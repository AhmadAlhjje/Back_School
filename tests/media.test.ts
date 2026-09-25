import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { getMemoryQueues } from '../src/core/queue/queues.js';
import { openSecret } from '../src/core/security/crypto.js';
import { resolveStorageKey } from '../src/core/storage/storage.js';
import { clearMediaGuardCache } from '../src/modules/media/media-guard.js';
import {
  buildHlsArgs,
  copyableRendition,
  planRenditions,
  type ProbeResult,
} from '../src/workers/video/ffmpeg.js';
import { markVideoFailed, PermanentVideoError, processVideoJob } from '../src/workers/video/process-video.js';
import { createCatalog, grantSubject, grantTeacher } from './helpers/factories.js';
import { api, authHeaders, staff, student, type StaffSession } from './helpers/http.js';

const FIXTURE_DIR = path.resolve('tests/.fixtures');
const SAMPLE = path.join(FIXTURE_DIR, 'sample.mp4');

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!fs.existsSync(SAMPLE)) {
    // ~2.5 MB, 5 s, 480p with audio → several 1 MB upload chunks and 2-second HLS segments.
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=5:size=854x480:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-c:v',
      'libx264',
      '-b:v',
      '4M',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      SAMPLE,
    ]);
  }
}, 120_000);

/** Turns an absolute API URL into a path supertest can call. */
const local = (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
};

async function uploadSample(
  owner: StaffSession,
  sessionId: string,
  bytes = fs.readFileSync(SAMPLE),
  fileName = 'lesson.mp4',
) {
  const created = await api()
    .post('/api/v1/videos')
    .set(authHeaders(owner))
    .send({ sessionId, title: 'شرح المقدمة', fileName, fileSize: bytes.length, mimeType: 'video/mp4' });
  expect(created.status).toBe(201);
  const { video, upload } = created.body.data;
  for (let index = 0; index < upload.totalChunks; index += 1) {
    const chunk = bytes.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize);
    const res = await api()
      .put(`/api/v1/videos/${video.id}/upload/chunks/${index}`)
      .set(authHeaders(owner))
      .set('Content-Type', 'application/octet-stream')
      .send(chunk);
    expect(res.status, `chunk ${index}`).toBe(200);
  }
  return {
    videoId: video.id as string,
    uploadId: upload.id as string,
    totalChunks: upload.totalChunks as number,
  };
}

/** Decrypts the first segment of a stored rendition and asks ffprobe what is inside. */
function probeStoredSegment(storageKeyOfAsset: string, encryptedKey: string, variant: string) {
  const playlist = fs.readFileSync(resolveStorageKey(`${storageKeyOfAsset}/${variant}/index.m3u8`), 'utf8');
  const iv = Buffer.from(/IV=0x([0-9a-fA-F]+)/.exec(playlist)![1]!, 'hex');
  const segment = fs.readFileSync(resolveStorageKey(`${storageKeyOfAsset}/${variant}/seg_00000.ts`));
  const decipher = createDecipheriv('aes-128-cbc', openSecret(encryptedKey), iv);
  const clear = path.join(FIXTURE_DIR, `probe-${variant}.ts`);
  fs.writeFileSync(clear, Buffer.concat([decipher.update(segment), decipher.final()]));
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,profile,height,avg_frame_rate',
    '-of',
    'json',
    clear,
  ]).toString();
  return (JSON.parse(out) as { streams: { profile: string; height: number; avg_frame_rate: string }[] })
    .streams[0]!;
}

describe('faster processing', () => {
  const probe = (overrides: Partial<ProbeResult>): ProbeResult => ({
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    hasAudio: true,
    videoCodec: 'h264',
    videoProfile: 'High',
    pixelFormat: 'yuv420p',
    videoBitrateKbps: 3000,
    frameRate: 30,
    ...overrides,
  });
  const ladder = planRenditions(1080, [360, 720, 1080]);

  it('takes the largest rendition from a suitable upload as it is', () => {
    expect(copyableRendition(probe({}), ladder)).toBe(2);
    expect(copyableRendition(probe({ videoCodec: 'hevc' }), ladder)).toBe(-1);
    expect(copyableRendition(probe({ videoBitrateKbps: 15000 }), ladder)).toBe(-1); // phone recording
    expect(copyableRendition(probe({ pixelFormat: 'yuv420p10le' }), ladder)).toBe(-1);
    expect(copyableRendition(probe({ height: 1088 }), ladder)).toBe(-1);
  });

  it('encodes the other renditions, at 30 fps when the source is 60', () => {
    const args = buildHlsArgs({
      inputPath: 'in.mp4',
      outputDir: 'out',
      keyInfoPath: 'key.info',
      renditions: ladder,
      copyIndex: 2,
      sourceFrameRate: 59.94,
      hasAudio: true,
      segmentSeconds: 6,
      preset: 'superfast',
      durationSeconds: 60,
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('fps=30,split=2');
    expect(args.join(' ')).toContain('-map 0:v:0 -c:v:2 copy');
    expect(args.filter((arg) => arg === 'libx264')).toHaveLength(2);
  });

  it('processes an already-compressed upload without re-encoding its size (real FFmpeg)', async () => {
    const source = path.join(FIXTURE_DIR, 'compressed-360.mp4');
    if (!fs.existsSync(source)) {
      // What the dashboard's browser compression produces: H.264 High, key frame every 2 s.
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=6:size=640x360:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:duration=6',
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-b:v',
        '500k',
        '-g',
        '60',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        source,
      ]);
    }
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const { videoId, uploadId } = await uploadSample(
      owner,
      catalog.session.id,
      fs.readFileSync(source),
      'lesson.mp4',
    );
    await api().post(`/api/v1/videos/${videoId}/upload/complete`).set(authHeaders(owner));

    // While it waits and while it is prepared, the dashboard sees how far it is.
    const queued = await api().get(`/api/v1/videos/${videoId}`).set(authHeaders(owner));
    expect(queued.body.data.upload.preparingPercent).toBe(0);
    expect(await processVideoJob(uploadId)).toBe('processed');

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId }, include: { asset: true } });
    expect(video.status).toBe('READY');
    const job = await prisma.uploadJob.findUniqueOrThrow({ where: { id: uploadId } });
    expect(job.progressPercent).toBe(100);
    const done = await api().get(`/api/v1/videos/${videoId}`).set(authHeaders(owner));
    expect(done.body.data.upload.preparingPercent).toBeNull();

    // 360p (= the source) was copied: still the source's High profile. 240p was encoded by the
    // server (with the test preset `ultrafast`, x264 signals the simplest profile).
    const copied = probeStoredSegment(video.asset!.storageKey, video.asset!.encryptedKey, 'v1');
    expect(copied).toMatchObject({ height: 360, profile: 'High' });
    const encoded = probeStoredSegment(video.asset!.storageKey, video.asset!.encryptedKey, 'v0');
    expect(encoded.height).toBe(240);
    expect(encoded.profile).not.toBe('High');
  }, 120_000);
});

describe('video pipeline (real FFmpeg)', () => {
  it('uploads in chunks, processes to encrypted HLS, and plays back only for authorized students', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const { videoId, uploadId, totalChunks } = await uploadSample(owner, catalog.session.id);
    expect(totalChunks).toBeGreaterThan(1);

    const status = await api().get(`/api/v1/videos/${videoId}/upload`).set(authHeaders(owner));
    expect(status.body.data.upload.receivedChunks).toHaveLength(totalChunks);

    const completed = await api().post(`/api/v1/videos/${videoId}/upload/complete`).set(authHeaders(owner));
    expect(completed.status).toBe(200);
    expect(completed.body.data.video).toMatchObject({ status: 'PROCESSING', displayStatus: 'UPLOADING' });
    // Queued for the background worker (tests start none, so it just waits).
    expect(getMemoryQueues().video.getWaiting(uploadId)?.uploadJobId).toBe(uploadId);

    // Run exactly what the worker runs.
    expect(await processVideoJob(uploadId)).toBe('processed');

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId }, include: { asset: true } });
    expect(video.status).toBe('READY');
    expect(video.durationSeconds).toBe(5);
    expect(video.asset?.renditions).toHaveLength(2); // 240p + 360p from a 480p source (test ladder)
    expect(fs.existsSync(resolveStorageKey(`tmp/uploads/${uploadId}`))).toBe(false);

    // Stored segments are encrypted: an MPEG-TS packet would start with 0x47.
    const segmentPath = resolveStorageKey(`${video.asset!.storageKey}/v0/seg_00000.ts`);
    expect(fs.readFileSync(segmentPath)[0]).not.toBe(0x47);
    // The stored playlist never contains the real key location.
    const storedVariant = fs.readFileSync(
      resolveStorageKey(`${video.asset!.storageKey}/v0/index.m3u8`),
      'utf8',
    );
    expect(storedVariant).not.toContain('enc.key');

    // Dashboard sees READY.
    const staffView = await api().get(`/api/v1/videos/${videoId}`).set(authHeaders(owner));
    expect(staffView.body.data.displayStatus).toBe('READY');

    // Locked student: no playback.
    const outsider = await student();
    const denied = await api().post(`/api/v1/student/videos/${videoId}/playback`).set(authHeaders(outsider));
    expect(denied.body.error.code).toBe('ACCESS_DENIED');

    // Authorized student: full HLS flow.
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const grant = await api().post(`/api/v1/student/videos/${videoId}/playback`).set(authHeaders(learner));
    expect(grant.status).toBe(200);
    expect(grant.body.data).not.toHaveProperty('watermark');
    const masterUrl: string = grant.body.data.manifestUrl;

    const master = await api().get(local(masterUrl));
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toContain('mpegurl');
    expect(master.headers['cache-control']).toBe('no-store');
    const variantLine = master.text.split('\n').find((line) => line.startsWith('v0/'))!;
    expect(variantLine).toMatch(/^v0\/index\.m3u8\?token=/);

    const variantUrl = new URL(variantLine, masterUrl).toString();
    const variant = await api().get(local(variantUrl));
    const keyLine = variant.text.split('\n').find((line) => line.startsWith('#EXT-X-KEY'))!;
    expect(keyLine).toContain('METHOD=AES-128');
    const keyUri = /URI="([^"]+)"/.exec(keyLine)![1]!;
    expect(keyUri.startsWith('../key?token=')).toBe(true);
    const iv = Buffer.from(/IV=0x([0-9a-fA-F]+)/.exec(keyLine)![1]!, 'hex');
    const segmentLine = variant.text.split('\n').find((line) => line.startsWith('seg_'))!;

    const key = await api()
      .get(local(new URL(keyUri, variantUrl).toString()))
      .buffer(true)
      .parse(binaryParser);
    expect(key.status).toBe(200);
    expect((key.body as Buffer).length).toBe(16);

    const segment = await api()
      .get(local(new URL(segmentLine, variantUrl).toString()))
      .buffer(true)
      .parse(binaryParser);
    expect(segment.status).toBe(200);
    const decipher = createDecipheriv('aes-128-cbc', key.body as Buffer, iv);
    const clear = Buffer.concat([decipher.update(segment.body as Buffer), decipher.final()]);
    expect(clear[0]).toBe(0x47); // decrypts to a valid MPEG-TS stream

    // Tampered or cross-video tokens fail.
    expect((await api().get(local(masterUrl.replace(/token=.{6}/, 'token=AAAAAA')))).status).toBe(403);
    const otherVideo = await prisma.video.create({
      data: { sessionId: catalog.session.id, title: 'x', status: 'READY' },
    });
    expect((await api().get(local(masterUrl.replace(videoId, otherVideo.id)))).status).toBe(403);

    // Revoking access kills the key immediately (the key endpoint is never cached).
    await prisma.studentTeacherAccess.updateMany({
      where: { studentId: learner.userId },
      data: { revokedAt: new Date() },
    });
    const revokedKey = await api().get(local(new URL(keyUri, variantUrl).toString()));
    expect(revokedKey.status).toBe(403);
    expect(revokedKey.body.error.code).toBe('MEDIA_TOKEN_INVALID');
    clearMediaGuardCache();
    expect((await api().get(local(masterUrl))).status).toBe(403);

    // Staff preview: relative to the API, so it works through the dashboards' own address.
    const preview = await api().post(`/api/v1/videos/${videoId}/preview`).set(authHeaders(owner));
    const previewUrl: string = preview.body.data.manifestUrl;
    expect(previewUrl).toMatch(new RegExp(`^/api/v1/media/videos/${videoId}/master\\.m3u8\\?token=`));
    expect((await api().get(previewUrl)).status).toBe(200);

    // New video notification reached students with access at processing time: none had access then.
    expect(await prisma.notification.count({ where: { type: 'NEW_LESSON' } })).toBe(1);
  });

  it('device reset invalidates existing playback links', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const admin = await staff('SUPER_ADMIN');
    const { videoId, uploadId } = await uploadSample(owner, catalog.session.id);
    await api().post(`/api/v1/videos/${videoId}/upload/complete`).set(authHeaders(owner));
    await processVideoJob(uploadId);

    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const grant = await api().post(`/api/v1/student/videos/${videoId}/playback`).set(authHeaders(learner));
    expect((await api().get(local(grant.body.data.manifestUrl))).status).toBe(200);

    await api().post(`/api/v1/students/${learner.userId}/device/reset`).set(authHeaders(admin));
    clearMediaGuardCache();
    expect((await api().get(local(grant.body.data.manifestUrl))).status).toBe(403);
  });

  it('issues device-bound offline licenses with the video location, lists and revokes them', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const admin = await staff('SUPER_ADMIN');
    const { videoId, uploadId } = await uploadSample(owner, catalog.session.id);
    await api().post(`/api/v1/videos/${videoId}/upload/complete`).set(authHeaders(owner));
    await processVideoJob(uploadId);

    const learner = await student();
    // No access yet: no license.
    const denied = await api()
      .post(`/api/v1/student/videos/${videoId}/offline-license`)
      .set(authHeaders(learner));
    expect(denied.body.error.code).toBe('ACCESS_DENIED');
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);

    const issued = await api()
      .post(`/api/v1/student/videos/${videoId}/offline-license`)
      .set(authHeaders(learner));
    expect(issued.status).toBe(200);
    expect(issued.body.data.path).toEqual({
      subject: 'رياضيات',
      teacher: 'أحمد',
      topic: 'التفاضل',
      session: 'الجلسة الأولى',
    });
    expect(issued.body.data.renditions.length).toBeGreaterThan(0);
    const licenseId = issued.body.data.licenseId as string;

    // Valid for a whole year by default.
    const days = (new Date(issued.body.data.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(365);

    const listed = await api().get('/api/v1/student/offline-licenses').set(authHeaders(learner));
    expect(listed.body.data.licenses.map((l: { licenseId: string }) => l.licenseId)).toEqual([licenseId]);

    const removed = await api()
      .delete(`/api/v1/student/offline-licenses/${licenseId}`)
      .set(authHeaders(learner));
    expect(removed.status).toBe(200);
    expect(
      (await api().get('/api/v1/student/offline-licenses').set(authHeaders(learner))).body.data.licenses,
    ).toEqual([]);

    // The super admin can turn offline downloads off.
    await api()
      .patch('/api/v1/admin/settings')
      .set(authHeaders(admin))
      .send({ offlineDownloadsEnabled: false });
    const disabled = await api()
      .post(`/api/v1/student/videos/${videoId}/offline-license`)
      .set(authHeaders(learner));
    expect(disabled.body.error.code).toBe('OFFLINE_DISABLED');
  });

  it('rejects wrong chunk sizes and incomplete uploads', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const created = await api()
      .post('/api/v1/videos')
      .set(authHeaders(owner))
      .send({ sessionId: catalog.session.id, title: 'x', fileName: 'x.mp4', fileSize: 3 * 1024 * 1024 });
    const { video } = created.body.data;
    const wrong = await api()
      .put(`/api/v1/videos/${video.id}/upload/chunks/0`)
      .set(authHeaders(owner))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(100));
    expect(wrong.status).toBe(400);
    const incomplete = await api().post(`/api/v1/videos/${video.id}/upload/complete`).set(authHeaders(owner));
    expect(incomplete.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(incomplete.body.error.details.missingChunks).toEqual([0, 1, 2]);
  });

  it('rejects non-video extensions', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const res = await api()
      .post('/api/v1/videos')
      .set(authHeaders(owner))
      .send({ sessionId: catalog.session.id, title: 'x', fileName: 'virus.exe', fileSize: 1000 });
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  it('marks a non-video upload as FAILED and allows a retry', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const garbage = Buffer.alloc(300_000, 7);
    const { videoId, uploadId } = await uploadSample(owner, catalog.session.id, garbage, 'broken.mp4');
    await api().post(`/api/v1/videos/${videoId}/upload/complete`).set(authHeaders(owner));

    await expect(processVideoJob(uploadId)).rejects.toBeInstanceOf(PermanentVideoError);
    await markVideoFailed(uploadId, 'not a video');
    const failed = await api().get(`/api/v1/videos/${videoId}`).set(authHeaders(owner));
    expect(failed.body.data.displayStatus).toBe('FAILED');

    const retry = await api()
      .post(`/api/v1/videos/${videoId}/upload/restart`)
      .set(authHeaders(owner))
      .send({ fileName: 'fixed.mp4', fileSize: 1000 });
    expect(retry.status).toBe(200);
    expect(retry.body.data.video.displayStatus).toBe('UPLOADING');
  });
});

/** Collects a binary response body (superagent parses only text/JSON by default). */
function binaryParser(res: unknown, callback: (err: Error | null, body: Buffer) => void) {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}
