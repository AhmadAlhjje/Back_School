import { spawn } from 'node:child_process';
import { config } from '../../config/env.js';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export class MediaToolError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}

function run(
  binary: string,
  args: string[],
  onStdoutLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (onStdoutLine) {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) onStdoutLine(line.trim());
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      // Keep only the tail; ffmpeg can be very chatty on long inputs.
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', (error) =>
      reject(new MediaToolError(`${binary} could not start: ${error.message}`, stderr)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new MediaToolError(`${binary} exited with code ${code}`, stderr));
    });
  });
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
}

export async function probeVideo(inputPath: string): Promise<ProbeResult | null> {
  const { stdout } = await run(config.media.ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);
  const data = JSON.parse(stdout) as FfprobeOutput;
  const video = data.streams?.find(
    (stream) => stream.codec_type === 'video' && stream.width && stream.height,
  );
  if (!video) return null;
  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video.width!,
    height: video.height!,
    hasAudio: data.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
  };
}

export interface Rendition {
  name: string;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

const BITRATE_LADDER: [number, number, number][] = [
  // [maxHeight, video kbps, audio kbps]
  [240, 400, 64],
  [360, 800, 96],
  [480, 1400, 96],
  [720, 2800, 128],
  [1080, 5000, 128],
  [1440, 8000, 160],
  [2160, 14000, 160],
];

function bitratesFor(height: number): [number, number] {
  const step = BITRATE_LADDER.find(([max]) => height <= max) ?? BITRATE_LADDER.at(-1)!;
  return [step[1], step[2]];
}

/** Configured rendition heights that do not upscale the source (at least one rendition). */
export function planRenditions(sourceHeight: number, configuredHeights: readonly number[]): Rendition[] {
  const evenSource = Math.max(2, sourceHeight - (sourceHeight % 2));
  let heights = configuredHeights.filter((height) => height <= evenSource);
  if (heights.length === 0) heights = [evenSource];
  return heights.map((height, index) => {
    const [video, audio] = bitratesFor(height);
    return { name: `v${index}`, height, videoBitrateKbps: video, audioBitrateKbps: audio };
  });
}

export interface HlsOptions {
  inputPath: string;
  outputDir: string;
  keyInfoPath: string;
  renditions: Rendition[];
  hasAudio: boolean;
  segmentSeconds: number;
  preset: string;
  durationSeconds: number;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * Transcodes to multi-rendition HLS with AES-128 encrypted segments in a single FFmpeg pass.
 * Output: <outputDir>/master.m3u8, <outputDir>/v<N>/index.m3u8, <outputDir>/v<N>/seg_00000.ts
 */
export function buildHlsArgs(options: HlsOptions): string[] {
  const { renditions, segmentSeconds } = options;
  const split = renditions.length;
  const filter =
    `[0:v]split=${split}${renditions.map((_, i) => `[s${i}]`).join('')};` +
    renditions.map((r, i) => `[s${i}]scale=-2:${r.height}:flags=bicubic,format=yuv420p[o${i}]`).join(';');

  const args = ['-hide_banner', '-nostdin', '-y', '-i', options.inputPath, '-filter_complex', filter];
  renditions.forEach((rendition, i) => {
    const kbps = rendition.videoBitrateKbps;
    args.push(
      '-map',
      `[o${i}]`,
      `-c:v:${i}`,
      'libx264',
      `-b:v:${i}`,
      `${kbps}k`,
      `-maxrate:v:${i}`,
      `${Math.round(kbps * 1.07)}k`,
      `-bufsize:v:${i}`,
      `${kbps * 2}k`,
    );
  });
  if (options.hasAudio) {
    renditions.forEach((rendition, i) => {
      args.push(
        '-map',
        'a:0?',
        `-c:a:${i}`,
        'aac',
        `-b:a:${i}`,
        `${rendition.audioBitrateKbps}k`,
        `-ac:a:${i}`,
        '2',
      );
    });
  }
  args.push(
    '-preset',
    options.preset,
    '-profile:v',
    'main',
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${segmentSeconds})`,
    '-f',
    'hls',
    '-hls_time',
    String(segmentSeconds),
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-hls_key_info_file',
    options.keyInfoPath,
    '-hls_segment_filename',
    `${options.outputDir}/v%v/seg_%05d.ts`,
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    renditions.map((_, i) => (options.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
    '-progress',
    'pipe:1',
    '-nostats',
    `${options.outputDir}/v%v/index.m3u8`,
  );
  return args;
}

export async function transcodeToHls(options: HlsOptions): Promise<void> {
  const totalMicros = Math.max(1, options.durationSeconds * 1_000_000);
  let lastReported = -1;
  await run(
    config.media.ffmpegPath,
    buildHlsArgs(options),
    (line) => {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (!match || !options.onProgress) return;
      const percent = Math.min(99, Math.floor((Number(match[1]) / totalMicros) * 100));
      if (percent > lastReported) {
        lastReported = percent;
        options.onProgress(percent);
      }
    },
    options.signal,
  );
}
