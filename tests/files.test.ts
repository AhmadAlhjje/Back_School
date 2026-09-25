import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { createCatalog, grantSubject, grantTeacher } from './helpers/factories.js';
import { api, authHeaders, staff, student } from './helpers/http.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const local = (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
};

describe('educational files', () => {
  it('uploads a PDF to a session and serves it only through an access-checked short-lived URL', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const upload = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .field('title', 'ملخص الدرس')
      .attach('file', PDF, 'summary.pdf');
    expect(upload.status).toBe(201);
    expect(upload.body.data).toMatchObject({
      title: 'ملخص الدرس',
      kind: 'PDF',
      extension: 'pdf',
      scope: 'SESSION',
    });
    expect(upload.body.data.storageKey).toBeUndefined();
    const fileId = upload.body.data.id as string;

    const outsider = await student();
    const denied = await api().post(`/api/v1/student/files/${fileId}/access`).set(authHeaders(outsider));
    expect(denied.body.error.code).toBe('ACCESS_DENIED');

    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const grant = await api().post(`/api/v1/student/files/${fileId}/access`).set(authHeaders(learner));
    expect(grant.status).toBe(200);
    const download = await api().get(local(grant.body.data.url));
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['cache-control']).toContain('no-store');

    // Using the file token for another file fails.
    const other = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .attach('file', PDF, 'other.pdf');
    expect((await api().get(local(grant.body.data.url.replace(fileId, other.body.data.id)))).status).toBe(
      403,
    );

    // Deleting (archiving) the file makes it unavailable to students but keeps it restorable.
    await api().post(`/api/v1/files/${fileId}/archive`).set(authHeaders(owner));
    expect(
      (await api().post(`/api/v1/student/files/${fileId}/access`).set(authHeaders(learner))).body.error.code,
    ).toBe('FILE_NOT_FOUND');
    expect(await prisma.auditLog.count({ where: { action: 'DELETE_FILE', entityId: fileId } })).toBe(1);
    const restored = await api().post(`/api/v1/files/${fileId}/restore`).set(authHeaders(owner));
    expect(restored.body.data.archivedAt).toBeNull();
  });

  it('subject-level files need only the subject grant', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const upload = await api()
      .post(`/api/v1/files?scope=SUBJECT&parentId=${catalog.math.id}`)
      .set(authHeaders(owner))
      .attach('file', PNG, 'syllabus.png');
    expect(upload.status).toBe(201);
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    const subject = await api().get(`/api/v1/student/subjects/${catalog.math.id}`).set(authHeaders(learner));
    expect(subject.body.data.files).toHaveLength(1);
    expect(
      (await api().post(`/api/v1/student/files/${upload.body.data.id}/access`).set(authHeaders(learner)))
        .status,
    ).toBe(200);
  });

  it('rejects disallowed extensions and content that does not match the extension', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const exe = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .attach('file', Buffer.from('MZ....'), 'tool.exe');
    expect(exe.status).toBe(415);
    expect(exe.body.error.code).toBe('INVALID_FILE_TYPE');

    const disguised = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .attach('file', Buffer.from('MZ\x90\x00 this is really an executable'), 'notes.pdf');
    expect(disguised.body.error.code).toBe('INVALID_FILE_TYPE');
    expect(disguised.body.error.details.reason).toBe('CONTENT_MISMATCH');
    expect(await prisma.contentFile.count()).toBe(0);
  });

  it('refuses uploads to archived parents', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    await prisma.session.update({ where: { id: catalog.session.id }, data: { archivedAt: new Date() } });
    const res = await api()
      .post(`/api/v1/files?scope=SESSION&parentId=${catalog.session.id}`)
      .set(authHeaders(owner))
      .attach('file', PDF, 'a.pdf');
    expect(res.body.error.code).toBe('PARENT_ARCHIVED');
  });
});

describe('teacher photos', () => {
  it('uploads a photo and serves it publicly without exposing storage paths', async () => {
    const owner = await staff('OWNER');
    const teacher = (await api().post('/api/v1/teachers').set(authHeaders(owner)).send({ name: 'أحمد' })).body
      .data;
    const res = await api()
      .post(`/api/v1/teachers/${teacher.id}/image`)
      .set(authHeaders(owner))
      .attach('file', PNG, 'me.png');
    expect(res.status).toBe(200);
    expect(res.body.data.hasImage).toBe(true);
    expect(res.body.data.imageKey).toBeUndefined();
    const image = await api().get(res.body.data.imageUrl);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
  });
});
