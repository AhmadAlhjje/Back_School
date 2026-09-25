import { spawn } from 'node:child_process';
import { config } from '../../config/env.js';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** e.g. `h264`, `hevc`. */
  videoCodec: string;
  /** e.g. `High`, `Main`, `High 10`. */
  videoProfile: string;
  pixelFormat: string;
  /** Average video bitrate; 0 when unknown. */
  videoBitrateKbps: number;
  /** Average frames per second; 0 when unknown. */
  frameRate: number;
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

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

/** "30000/1001" → 29.97 */
function parseRate(rate: string | undefined): number {
  const [num, den] = (rate ?? '').split('/').map(Number);
  return num && den ? num / den : 0;
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
  // The stream bitrate, or the whole file's minus a typical audio track.
  const streamBps = Number(video.bit_rate ?? 0);
  const formatBps = Number(data.format?.bit_rate ?? 0);
  const videoBps = streamBps > 0 ? streamBps : Math.max(0, formatBps - 128_000);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video.width!,
    height: video.height!,
    hasAudio: data.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
    videoCodec: video.codec_name ?? '',
    videoProfile: video.profile ?? '',
    pixelFormat: video.pix_fmt ?? '',
    videoBitrateKbps: Number.isFinite(videoBps) ? Math.round(videoBps / 1000) : 0,
    frameRate: parseRate(video.avg_frame_rate),
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

/**
 * The rendition that can take the source video as it is (no re-encoding), or -1.
 *
 * Re-encoding the largest quality is the slowest part of processing. When the upload already
 * is what that rendition would be — H.264 (8-bit 4:2:0) at exactly its height and within its
 * bitrate, as produced by the dashboards' in-browser compression — it is only cut into encrypted
 * segments. Only the smaller renditions are encoded.
 */
export function copyableRendition(probe: ProbeResult, renditions: readonly Rendition[]): number {
  if (probe.videoCodec !== 'h264') return -1;
  if (probe.pixelFormat !== 'yuv420p' && probe.pixelFormat !== 'yuvj420p') return -1;
  if (!['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(probe.videoProfile)) return -1;
  if (probe.frameRate <= 0 || probe.frameRate > 60.5) return -1;
  const top = renditions.length - 1;
  const rendition = renditions[top];
  if (!rendition || rendition.height !== probe.height) return -1;
  if (probe.videoBitrateKbps <= 0 || probe.videoBitrateKbps > rendition.videoBitrateKbps * 1.25) return -1;
  return top;
}

/** Lessons do not need more than 30 frames per second: 60 fps sources are encoded at 30. */
export const MAX_FRAME_RATE = 30;

export interface HlsOptions {
  inputPath: string;
  outputDir: string;
  keyInfoPath: string;
  renditions: Rendition[];
  /** Index of a rendition taken from the source as it is (see `copyableRendition`), or -1. */
  copyIndex?: number;
  /** The source frame rate (0 = unknown); above 30 the encoded renditions use 30. */
  sourceFrameRate?: number;
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
  const copyIndex = options.copyIndex ?? -1;
  const encoded = renditions.map((_, i) => i).filter((i) => i !== copyIndex);
  const fps = (options.sourceFrameRate ?? 0) > MAX_FRAME_RATE + 1 ? `fps=${MAX_FRAME_RATE},` : '';
  const filter =
    encoded.length === 0
      ? null
      : `[0:v]${fps}split=${encoded.length}${encoded.map((i) => `[s${i}]`).join('')};` +
        encoded
          .map((i) => `[s${i}]scale=-2:${renditions[i]!.height}:flags=bicubic,format=yuv420p[o${i}]`)
          .join(';');

  const args = ['-hide_banner', '-nostdin', '-y', '-i', options.inputPath];
  if (filter) args.push('-filter_complex', filter);
  renditions.forEach((rendition, i) => {
    if (i === copyIndex) {
      // Already the right size and quality: only segmented and encrypted.
      args.push('-map', '0:v:0', `-c:v:${i}`, 'copy');
      return;
    }
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
      `-preset:v:${i}`,
      options.preset,
      `-profile:v:${i}`,
      'main',
      `-sc_threshold:v:${i}`,
      '0',
      `-force_key_frames:v:${i}`,
      `expr:gte(t,n_forced*${segmentSeconds})`,
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
