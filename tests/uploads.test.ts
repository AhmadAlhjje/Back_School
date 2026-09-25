import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { resolveStorageKey } from '../src/core/storage/storage.js';
import { createCatalog } from './helpers/factories.js';
import { api, authHeaders, staff } from './helpers/http.js';

const MB = 1024 * 1024; // UPLOAD_CHUNK_SIZE_MB=1 in .env.test
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('BT /F1 12 Tf (ملخص الدرس الأول) Tj ET\n'.repeat(4000)),
  Buffer.from('%%EOF\n'),
]);

/** A multipart body built by hand, so it can be sent gzip-compressed like the dashboards do. */
function multipart(fileName: string, bytes: Buffer, title?: string) {
  const boundary = '----edu-test-boundary';
  const parts: Buffer[] = [];
  if (title) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('background uploads (upload tokens)', () => {
  it('uploads a video with only the upload token, for that video only, until the session ends', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const bytes = Buffer.alloc(Math.round(2.5 * MB), 7);
    const created = await api().post('/api/v1/videos').set(authHeaders(owner)).send({
      sessionId: catalog.session.id,
      title: 'درس طويل',
      fileName: 'lesson.mp4',
      fileSize: bytes.length,
      mimeType: 'video/mp4',
    });
    expect(created.status).toBe(201);
    const { video, upload, uploadToken, uploadTokenExpiresAt } = created.body.data;
    expect(typeof uploadToken).toBe('string');
    expect(new Date(uploadTokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 24 * 3600 * 1000);

    const putChunk = (index: number, token: string, videoId = video.id as string, body?: Buffer) =>
      api()
        .put(`/api/v1/videos/${videoId}/upload/chunks/${index}`)
        .set('X-Upload-Token', token)
        .set('Content-Type', 'application/octet-stream')
        .send(body ?? bytes.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize));
    // Refused requests are answered before their body is read: send a small one.
    const tiny = Buffer.alloc(16);

    // Chunks in any order, without the bearer token.
    expect((await putChunk(2, uploadToken)).status).toBe(200);
    expect((await putChunk(0, uploadToken)).status).toBe(200);

    // The token names one video: useless for another one.
    const other = await api().post('/api/v1/videos').set(authHeaders(owner)).send({
      sessionId: catalog.session.id,
      title: 'آخر',
      fileName: 'other.mp4',
      fileSize: bytes.length,
    });
    const crossed = await putChunk(0, uploadToken, other.body.data.video.id, tiny);
    expect(crossed.status).toBe(401);
    expect(crossed.body.error.code).toBe('TOKEN_INVALID');
    // Not accepted by any other route.
    const elsewhere = await api().get(`/api/v1/videos/${video.id}`).set('X-Upload-Token', uploadToken);
    expect(elsewhere.status).toBe(401);

    // The resume endpoint hands out a token too.
    const status = await api().get(`/api/v1/videos/${video.id}/upload`).set(authHeaders(owner));
    expect(status.body.data.upload.receivedChunks).toEqual([0, 2]);
    expect(typeof status.body.data.uploadToken).toBe('string');

    expect((await putChunk(1, uploadToken)).status).toBe(200);
    const done = await api()
      .post(`/api/v1/videos/${video.id}/upload/complete`)
      .set('X-Upload-Token', uploadToken);
    expect(done.status).toBe(200);
    expect(done.body.data.upload.status).toBe('QUEUED');

    // Signing out ends every upload token of that session.
    const plan = await api().get(`/api/v1/videos/${other.body.data.video.id}/upload`).set(authHeaders(owner));
    await api().post('/api/v1/auth/logout').set(authHeaders(owner));
    const afterLogout = await putChunk(0, plan.body.data.uploadToken, other.body.data.video.id, tiny);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe('SESSION_REVOKED');
  });

  it('uploads a gzip-compressed file with a files upload token and stores the original bytes', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const place = `scope=SESSION&parentId=${catalog.session.id}`;
    const token = await api().post(`/api/v1/files/upload-token?${place}`).set(authHeaders(owner));
    expect(token.status).toBe(200);

    const { body, contentType } = multipart('ملخص.pdf', PDF, 'ملخص مضغوط');
    const compressed = gzipSync(body);
    expect(compressed.length).toBeLessThan(body.length / 5);
    const upload = await api()
      .post(`/api/v1/files?${place}`)
      .set('X-Upload-Token', token.body.data.uploadToken)
      .set('Content-Type', contentType)
      .set('Content-Encoding', 'gzip')
      .send(compressed);
    expect(upload.status).toBe(201);
    expect(upload.body.data).toMatchObject({ title: 'ملخص مضغوط', kind: 'PDF', extension: 'pdf' });
    expect(Number(upload.body.data.sizeBytes)).toBe(PDF.length);

    const row = await prisma.contentFile.findUniqueOrThrow({ where: { id: upload.body.data.id } });
    const stored = fs.readFileSync(resolveStorageKey(row.storageKey));
    expect(stored.equals(PDF)).toBe(true);
    expect(row.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));

    // A files token is bound to its place.
    const elsewhere = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.lockedSession.id}`)
      .set('X-Upload-Token', token.body.data.uploadToken)
      .set('Content-Type', contentType)
      .send(body);
    expect(elsewhere.status).toBe(401);
  });

  it('fails cleanly (no hang, no leftover file) on a broken gzip body', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const { body, contentType } = multipart('broken.pdf', PDF);
    const compressed = gzipSync(body);
    const broken = Buffer.concat([
      compressed.subarray(0, compressed.length / 2),
      Buffer.from('not gzip at all'),
    ]);
    const res = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .set('Content-Type', contentType)
      .set('Content-Encoding', 'gzip')
      .send(broken);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe('UPLOAD_FAILED');
    expect(await prisma.contentFile.count()).toBe(0);

    const unsupported = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .set('Content-Type', contentType)
      .set('Content-Encoding', 'br')
      .send(body);
    expect(unsupported.status).toBe(400);
  });
});
