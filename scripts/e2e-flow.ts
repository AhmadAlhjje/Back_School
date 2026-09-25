/**
 * End-to-end smoke test of the full business flow (spec §134) against a RUNNING API.
 *
 *   npm run dev        (terminal 1; with REDIS_URL also `npm run worker:dev` in terminal 2)
 *   E2E_OWNER_PHONE=0911111111 E2E_OWNER_PASSWORD=Owner12345 npm run e2e   (another terminal)
 *
 * Super admin → owner → grade → subject → teacher → assign → topic → session → chunked video
 * upload → worker makes it READY → student → open subject + teacher → student login → browse
 * → playback → fetch playlists, key and a segment → decrypt the segment.
 *
 * Creates uniquely named data; intended for development/staging databases, not production.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = (process.env.E2E_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const ADMIN_PHONE = process.env.SEED_SUPER_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? '';
const run = randomUUID().slice(0, 6);

let step = 0;
function ok(message: string) {
  step += 1;
  process.stdout.write(`  ✓ ${String(step).padStart(2, '0')}. ${message}\n`);
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; details: unknown };
}

async function call<T>(
  method: string,
  url: string,
  options: { token?: string; device?: string; body?: unknown; raw?: Buffer } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.device) headers['X-Device-Id'] = options.device;
  let body: string | Buffer | undefined;
  if (options.raw) {
    headers['Content-Type'] = 'application/octet-stream';
    body = options.raw;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await fetch(`${API}${url}`, { method, headers, body });
  const json = (await res.json()) as Envelope<T>;
  if (!json.success) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json.error)}`);
  return json.data;
}

function sampleVideo(): Buffer {
  const dir = path.resolve('tests/.fixtures');
  const file = path.join(dir, 'e2e-sample.mp4');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc2=duration=12:size=1280x720:rate=25'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=330:duration=12'],
      ...['-c:v', 'libx264', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    ]);
  }
  return fs.readFileSync(file);
}

async function main() {
  process.stdout.write(`E2E flow against ${API} (run ${run})\n`);
  if (!ADMIN_PHONE || !ADMIN_PASSWORD) throw new Error('SEED_SUPER_ADMIN_PHONE / _PASSWORD must be set');

  const admin = await call<{ accessToken: string }>('POST', '/api/v1/auth/admin/login', {
    body: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD },
  });
  ok('Super admin logged in');

  // Single institute: use the given owner credentials, or create the owner, or (last resort)
  // reset the existing owner's password through the super admin.
  let ownerPhone = process.env.E2E_OWNER_PHONE ?? '';
  let ownerPassword = process.env.E2E_OWNER_PASSWORD ?? '';
  if (ownerPhone && ownerPassword) {
    ok('Using existing owner credentials (E2E_OWNER_PHONE)');
  } else {
    ownerPassword = `Owner${run}9`;
    const owners = await call<{ id: string; phone: string; archived: boolean }[]>(
      'GET',
      '/api/v1/admin/owners',
      {
        token: admin.accessToken,
      },
    );
    const activeOwner = owners.find((owner) => !owner.archived);
    if (activeOwner) {
      await call('POST', `/api/v1/admin/owners/${activeOwner.id}/reset-password`, {
        token: admin.accessToken,
        body: { newPassword: ownerPassword },
      });
      ownerPhone = activeOwner.phone;
      ok('Owner exists — password reset by super admin');
    } else {
      ownerPhone = `0977${String(Date.now()).slice(-6)}`;
      await call('POST', '/api/v1/admin/owners', {
        token: admin.accessToken,
        body: { name: 'صاحب المعهد', phone: ownerPhone, password: ownerPassword },
      });
      ok('Owner created by super admin');
    }
  }

  const owner = await call<{ accessToken: string }>('POST', '/api/v1/auth/owner/login', {
    body: { phone: ownerPhone, password: ownerPassword },
  });
  const t = owner.accessToken;
  ok('Owner logged in');

  const grade = await call<{ id: string }>('POST', '/api/v1/grades', {
    token: t,
    body: { name: `صف ${run}` },
  });
  ok('Grade created');
  const subject = await call<{ id: string }>('POST', '/api/v1/subjects', {
    token: t,
    body: { gradeId: grade.id, name: `رياضيات ${run}` },
  });
  ok('Subject created');
  const teacher = await call<{ id: string }>('POST', '/api/v1/teachers', {
    token: t,
    body: { name: `أحمد ${run}` },
  });
  ok('Teacher created');
  const assignment = await call<{ id: string }>('POST', `/api/v1/subjects/${subject.id}/teachers`, {
    token: t,
    body: { teacherId: teacher.id },
  });
  ok('Teacher assigned to subject');
  const topic = await call<{ id: string }>('POST', '/api/v1/topics', {
    token: t,
    body: { subjectTeacherId: assignment.id, title: 'التفاضل' },
  });
  ok('Topic created');
  const session = await call<{ id: string }>('POST', '/api/v1/sessions', {
    token: t,
    body: { topicId: topic.id, title: 'الجلسة الأولى' },
  });
  ok('Session created');

  const bytes = sampleVideo();
  const created = await call<{ video: { id: string }; upload: { chunkSize: number; totalChunks: number } }>(
    'POST',
    '/api/v1/videos',
    {
      token: t,
      body: {
        sessionId: session.id,
        title: 'شرح المقدمة',
        fileName: 'intro.mp4',
        fileSize: bytes.length,
        mimeType: 'video/mp4',
      },
    },
  );
  const { chunkSize, totalChunks } = created.upload;
  for (let index = 0; index < totalChunks; index += 1) {
    await call('PUT', `/api/v1/videos/${created.video.id}/upload/chunks/${index}`, {
      token: t,
      raw: bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
    });
    process.stdout.write(`      جاري الرفع ${Math.round(((index + 1) / totalChunks) * 100)}%\r`);
  }
  process.stdout.write('\n');
  await call('POST', `/api/v1/videos/${created.video.id}/upload/complete`, { token: t });
  ok(`Video uploaded (${(bytes.length / 1024 / 1024).toFixed(1)} MB in ${totalChunks} chunk(s))`);

  const started = Date.now();
  let status = 'UPLOADING';
  while (status === 'UPLOADING') {
    if (Date.now() - started > 5 * 60_000)
      throw new Error('Video was not processed within 5 minutes — is the worker running?');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = (
      await call<{ displayStatus: string }>('GET', `/api/v1/videos/${created.video.id}`, { token: t })
    ).displayStatus;
  }
  if (status !== 'READY') throw new Error(`Video processing ended with ${status}`);
  ok(`Video ready — processed by the worker in ${Math.round((Date.now() - started) / 1000)} s`);

  const studentPhone = `0988${String(Date.now()).slice(-6)}`;
  const student = await call<{ id: string }>('POST', '/api/v1/students', {
    token: t,
    body: { name: `طالب ${run}`, phone: studentPhone, password: 'Student123', gradeId: grade.id },
  });
  ok('Student created');
  await call('PUT', `/api/v1/access/students/${student.id}/subjects/${subject.id}`, {
    token: t,
    body: { open: true },
  });
  ok('Subject opened for the student');
  await call('PUT', `/api/v1/access/students/${student.id}/subject-teachers/${assignment.id}`, {
    token: t,
    body: { open: true },
  });
  ok('Teacher opened for the student');

  const device = `e2e-device-${run}`;
  const login = await call<{ accessToken: string }>('POST', '/api/v1/auth/student/login', {
    body: {
      phone: studentPhone,
      password: 'Student123',
      device: { identifier: device, platform: 'ANDROID', model: 'E2E' },
    },
  });
  const s = { token: login.accessToken, device };
  ok('Student logged in (device bound)');

  const home = await call<{ subjects: { id: string; locked: boolean }[] }>('GET', '/api/v1/student/home', s);
  if (!home.subjects.some((item) => item.id === subject.id && !item.locked))
    throw new Error('Subject not visible/open');
  ok('Student sees the subject (open)');
  const subjectView = await call<{ teachers: { subjectTeacherId: string; locked: boolean }[] }>(
    'GET',
    `/api/v1/student/subjects/${subject.id}`,
    s,
  );
  if (!subjectView.teachers.some((item) => item.subjectTeacherId === assignment.id && !item.locked)) {
    throw new Error('Teacher not open');
  }
  ok('Student sees the teacher (open)');
  const space = await call<{ topics: { id: string }[] }>(
    'GET',
    `/api/v1/student/subject-teachers/${assignment.id}`,
    s,
  );
  const topicView = await call<{ sessions: { id: string }[] }>(
    'GET',
    `/api/v1/student/topics/${space.topics[0]!.id}`,
    s,
  );
  const sessionView = await call<{ videos: { id: string }[] }>(
    'GET',
    `/api/v1/student/sessions/${topicView.sessions[0]!.id}`,
    s,
  );
  if (sessionView.videos[0]?.id !== created.video.id) throw new Error('Video not listed in session');
  ok('Student sees the session and its video');

  const playback = await call<{ manifestUrl: string }>(
    'POST',
    `/api/v1/student/videos/${created.video.id}/playback`,
    s,
  );
  const masterText = await (await fetch(playback.manifestUrl)).text();
  const variantUri = masterText.split('\n').find((line) => line.startsWith('v0/'))!;
  const variantUrl = new URL(variantUri, playback.manifestUrl);
  const variantText = await (await fetch(variantUrl)).text();
  const keyLine = variantText.split('\n').find((line) => line.startsWith('#EXT-X-KEY'))!;
  const keyUrl = new URL(/URI="([^"]+)"/.exec(keyLine)![1]!, variantUrl);
  const iv = Buffer.from(/IV=0x([0-9a-f]+)/i.exec(keyLine)![1]!, 'hex');
  const key = Buffer.from(await (await fetch(keyUrl)).arrayBuffer());
  const segmentUrl = new URL(
    variantText.split('\n').find((line) => line.startsWith('seg_'))!,
    variantUrl,
  );
  const segment = Buffer.from(await (await fetch(segmentUrl)).arrayBuffer());
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  const clear = Buffer.concat([decipher.update(segment), decipher.final()]);
  if (clear[0] !== 0x47) throw new Error('Decrypted segment is not MPEG-TS');
  ok(`Student plays the video: master → variant → key (16 B) → segment decrypted (${segment.length} B)`);

  process.stdout.write(`\nAll ${step} steps passed.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n✗ E2E flow failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
