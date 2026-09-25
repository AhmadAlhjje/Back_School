import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../../src/config/env.js';
import type { AuditActor } from '../../src/core/audit/audit.js';
import { prisma } from '../../src/core/database/prisma.js';
import { getMemoryQueues } from '../../src/core/queue/queues.js';
import { EDUCATIONAL_FILE_TYPES } from '../../src/core/storage/file-types.js';
import type { ReceivedFile } from '../../src/core/storage/multipart.js';
import { ensureStorageDir, resolveStorageKey, StorageArea, storageKey } from '../../src/core/storage/storage.js';
import { uploadFile } from '../../src/modules/files/files.service.js';
import { deliverNotification } from '../../src/modules/notifications/notifications.service.js';
import { completeUpload, createVideoUpload, receiveChunk } from '../../src/modules/videos/video-upload.service.js';
import { startEmbeddedWorker } from '../../src/workers/embedded.js';
import type { DemoCatalog } from './demo-data.js';

const run = promisify(execFile);

/**
 * Demo media, created through the same services as real uploads: PDFs at subject, teacher and
 * session level, and a sample lesson video generated with FFmpeg, chunk-uploaded and processed to
 * encrypted HLS (so a student can play it right away). Skips the video when FFmpeg is missing.
 */
export async function seedDemoMedia(catalog: DemoCatalog, log: (line: string) => void): Promise<void> {
  const actor: AuditActor = { userId: catalog.ownerId, role: 'OWNER', ip: null, userAgent: 'demo-seeder' };

  await addPdf(actor, 'SUBJECT', catalog.subjectId, 'خطة مادة الرياضيات', 'course-plan.pdf', [
    'Mathematics - Course plan',
    'Units: Differentiation, Derivatives, Integration, Limits',
  ]);
  await addPdf(actor, 'TEACHER', catalog.subjectTeacherId, 'ملخص قوانين التفاضل', 'formulas.pdf', [
    'Differentiation formulas',
    "(x^n)' = n x^(n-1)      (sin x)' = cos x      (e^x)' = e^x",
  ]);
  await addPdf(actor, 'SESSION', catalog.sessionId, 'أوراق عمل الجلسة الأولى', 'worksheet.pdf', [
    'Worksheet - Session 1',
    '1) f(x) = 3x^2 + 2x   2) g(x) = sin(2x)   3) h(x) = e^(3x)',
  ]);
  log('  3 PDF files');

  const video = await generateSampleVideo(log);
  if (!video) return;
  try {
    const stats = await fs.stat(video);
    const { video: created, upload } = await createVideoUpload(
      {
        sessionId: catalog.sessionId,
        title: 'مقدمة في التفاضل',
        description: 'فيديو تجريبي للتأكد من التشغيل المشفّر',
        fileName: 'intro.mp4',
        fileSize: stats.size,
        mimeType: 'video/mp4',
      },
      actor,
    );
    for (let index = 0; index < upload.totalChunks; index += 1) {
      const start = index * upload.chunkSize;
      const end = Math.min(stats.size, start + upload.chunkSize) - 1;
      await receiveChunk(created.id, index, createReadStream(video, { start, end }), end - start + 1);
    }
    await completeUpload(created.id, actor);

    if (config.queueDriver === 'memory') {
      // No Redis: process it here with the same in-process worker the API uses.
      const worker = await startEmbeddedWorker();
      const queues = getMemoryQueues();
      await queues.video.onIdle();
      await queues.notifications.onIdle();
      await worker.stop();
      const status = (await prisma.video.findUniqueOrThrow({ where: { id: created.id } })).status;
      log(`  Sample video: ${status === 'READY' ? 'ready (encrypted HLS)' : status}`);
    } else {
      log('  Sample video uploaded; the worker process will convert it');
    }
  } finally {
    await fs.rm(video, { force: true });
  }

  const welcome = await prisma.notification.create({
    data: {
      type: 'SYSTEM',
      title: 'أهلاً بك في المعهد',
      body: 'هذه بيانات تجريبية: افتح مادة الرياضيات ثم الأستاذ أحمد لمشاهدة الفيديو والملفات.',
      createdById: catalog.ownerId,
    },
  });
  await deliverNotification(welcome.id, { kind: 'ALL_STUDENTS' });
}

async function generateSampleVideo(log: (line: string) => void): Promise<string | null> {
  const output = path.join(os.tmpdir(), `edu-demo-${randomUUID()}.mp4`);
  try {
    await run(
      config.media.ffmpegPath,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100',
        '-t', '20',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        output,
      ],
      { windowsHide: true },
    );
    return output;
  } catch {
    await fs.rm(output, { force: true });
    log('  FFmpeg not found (FFMPEG_PATH) — sample video skipped');
    return null;
  }
}

async function addPdf(
  actor: AuditActor,
  scope: 'SUBJECT' | 'TEACHER' | 'SESSION',
  parentId: string,
  title: string,
  fileName: string,
  lines: string[],
): Promise<void> {
  const bytes = buildPdf(lines);
  const rule = EDUCATIONAL_FILE_TYPES.pdf!;
  await ensureStorageDir(StorageArea.uploads);
  const tempKey = storageKey(StorageArea.uploads, `${randomUUID()}.upload`);
  await fs.writeFile(resolveStorageKey(tempKey), bytes);
  const file: ReceivedFile = {
    tempKey,
    originalFileName: fileName,
    extension: 'pdf',
    mimeType: rule.mime,
    kind: rule.kind,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await uploadFile({ scope, parentId, title, file }, actor);
}

/** A small valid one-page PDF (Helvetica text, correct cross-reference table). */
function buildPdf(lines: string[]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const content = [
    'BT /F1 22 Tf 60 780 Td',
    `(${escape(lines[0] ?? '')}) Tj`,
    '/F1 13 Tf 0 -40 Td',
    ...lines.slice(1).flatMap((line) => [`(${escape(line)}) Tj`, '0 -22 Td']),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
