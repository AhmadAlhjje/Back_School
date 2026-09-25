/**
 * Prepares data for the Flutter app's live API test (flutter_app/test/live/live_api_test.dart):
 * a new student with the teacher of the most recent READY video opened, plus a PDF in that
 * video's session. Writes the ids to the JSON file given as the first argument.
 *
 *   npm run e2e                                   # creates a READY video (API + worker running)
 *   npm run app:live-setup -- ../flutter_app/build/live-config.json
 *   cd ../flutter_app && LIVE_API_CONFIG=build/live-config.json flutter test test/live
 *
 * Owner credentials: E2E_OWNER_PHONE / E2E_OWNER_PASSWORD. Development databases only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/core/database/prisma.js';

const API = `${(process.env.E2E_API_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/api/v1`;
const out = process.argv[2];
const ownerPhone = process.env.E2E_OWNER_PHONE ?? '';
const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? '';

async function call<T>(method: string, route: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; data: T; error?: unknown };
  if (!json.success) throw new Error(`${method} ${route} → ${res.status} ${JSON.stringify(json.error)}`);
  return json.data;
}

async function main() {
  if (!out) throw new Error('Usage: app-live-setup <output.json>');
  if (!ownerPhone || !ownerPassword) throw new Error('Set E2E_OWNER_PHONE and E2E_OWNER_PASSWORD');

  // The whole chain must be active: an archived grade/subject/teacher hides its videos from students.
  const video = await prisma.video.findFirst({
    where: {
      status: 'READY',
      archivedAt: null,
      session: {
        archivedAt: null,
        topic: {
          archivedAt: null,
          subjectTeacher: {
            archivedAt: null,
            teacher: { archivedAt: null },
            subject: { archivedAt: null, grade: { archivedAt: null } },
          },
        },
      },
    },
    orderBy: { readyAt: 'desc' },
    include: {
      session: { include: { topic: { include: { subjectTeacher: { include: { subject: true } } } } } },
    },
  });
  if (!video) throw new Error('No READY video: run `npm run e2e` first');
  const { session } = video;
  const { subjectTeacher } = session.topic;

  const owner = await call<{ accessToken: string }>('POST', '/auth/owner/login', null, {
    phone: ownerPhone,
    password: ownerPassword,
  });
  const phone = `0966${String(Date.now()).slice(-6)}`;
  const password = 'Student123';
  const student = await call<{ id: string }>('POST', '/students', owner.accessToken, {
    name: 'طالب الاختبار الحي',
    phone,
    password,
  });
  await call(
    'PUT',
    `/access/students/${student.id}/subject-teachers/${subjectTeacher.id}`,
    owner.accessToken,
    {
      open: true,
    },
  );

  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
  const form = new FormData();
  form.append('title', 'ملخص الجلسة');
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'summary.pdf');
  const upload = await fetch(`${API}/files?scope=SESSION&parentId=${session.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.accessToken}` },
    body: form,
  });
  const uploaded = (await upload.json()) as { success: boolean; data: { id: string }; error?: unknown };
  if (!uploaded.success) throw new Error(`File upload failed: ${JSON.stringify(uploaded.error)}`);

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        apiBaseUrl: API.replace(/\/api\/v1$/, ''),
        phone,
        password,
        gradeId: subjectTeacher.subject.gradeId,
        subjectId: subjectTeacher.subjectId,
        subjectTeacherId: subjectTeacher.id,
        topicId: session.topicId,
        sessionId: session.id,
        videoId: video.id,
        fileId: uploaded.data.id,
        pdfSize: pdf.length,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Live test data written to ${out} (student ${phone})\n`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
