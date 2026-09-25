import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { createCatalog, grantSubject, grantTeacher } from './helpers/factories.js';
import { api, authHeaders, staff, student } from './helpers/http.js';

describe('access model', () => {
  it('shows subjects and teachers with lock state', async () => {
    const catalog = await createCatalog();
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);

    const grade = await api()
      .get(`/api/v1/student/grades/${catalog.grade.id}/subjects`)
      .set(authHeaders(learner));
    const locks = Object.fromEntries(
      grade.body.data.subjects.map((s: { name: string; locked: boolean }) => [s.name, s.locked]),
    );
    expect(locks).toEqual({ رياضيات: false, فيزياء: true });

    const subject = await api().get(`/api/v1/student/subjects/${catalog.math.id}`).set(authHeaders(learner));
    const teacherLocks = Object.fromEntries(
      subject.body.data.teachers.map((t: { teacher: { name: string }; locked: boolean }) => [
        t.teacher.name,
        t.locked,
      ]),
    );
    expect(teacherLocks).toEqual({ أحمد: false, محمد: true });
  });

  it('opening a teacher opens all of its current AND future content', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const learner = await student();

    const open = await api()
      .put(`/api/v1/access/students/${learner.userId}/subject-teachers/${catalog.mathAhmad.id}`)
      .set(authHeaders(owner))
      .send({ open: true });
    expect(open.status).toBe(200);
    // Opening the teacher also opened the subject.
    const math = open.body.data.grades[0].subjects.find((s: { id: string }) => s.id === catalog.math.id);
    expect(math.open).toBe(true);
    expect(math.teachers.find((t: { name: string }) => t.name === 'أحمد').effective).toBe(true);

    expect(
      (await api().get(`/api/v1/student/sessions/${catalog.session.id}`).set(authHeaders(learner))).status,
    ).toBe(200);

    // Content added later is available without any extra grant.
    const newTopic = await api()
      .post('/api/v1/topics')
      .set(authHeaders(owner))
      .send({ subjectTeacherId: catalog.mathAhmad.id, title: 'التكامل' });
    const newSession = await api()
      .post('/api/v1/sessions')
      .set(authHeaders(owner))
      .send({ topicId: newTopic.body.data.id, title: 'جلسة جديدة' });
    const later = await api()
      .get(`/api/v1/student/sessions/${newSession.body.data.id}`)
      .set(authHeaders(learner));
    expect(later.status).toBe(200);

    const audits = await prisma.auditLog.count({ where: { action: 'OPEN_ACCESS', actorId: owner.userId } });
    expect(audits).toBe(2);
  });

  it('closing the subject locks the teacher content; reopening restores it', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const path = `/api/v1/student/topics/${catalog.topic.id}`;
    expect((await api().get(path).set(authHeaders(learner))).status).toBe(200);

    await api()
      .put(`/api/v1/access/students/${learner.userId}/subjects/${catalog.math.id}`)
      .set(authHeaders(owner))
      .send({ open: false });
    const closed = await api().get(path).set(authHeaders(learner));
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('ACCESS_DENIED');

    await api()
      .put(`/api/v1/access/students/${learner.userId}/subjects/${catalog.math.id}`)
      .set(authHeaders(owner))
      .send({ open: true });
    expect((await api().get(path).set(authHeaders(learner))).status).toBe(200);
  });

  it('bulk-opens a teacher for several students', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const a = await student();
    const b = await student();
    const res = await api()
      .post('/api/v1/access/bulk')
      .set(authHeaders(owner))
      .send({
        studentIds: [a.userId, b.userId],
        target: { type: 'SUBJECT_TEACHER', id: catalog.mathAhmad.id },
        open: true,
      });
    expect(res.body.data).toEqual({ updated: 2, total: 2 });
    expect((await api().get(`/api/v1/student/topics/${catalog.topic.id}`).set(authHeaders(b))).status).toBe(
      200,
    );
  });

  it('expired grants do not give access', async () => {
    const catalog = await createCatalog();
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await prisma.studentTeacherAccess.create({
      data: {
        studentId: learner.userId,
        subjectTeacherId: catalog.mathAhmad.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(
      (await api().get(`/api/v1/student/topics/${catalog.topic.id}`).set(authHeaders(learner))).status,
    ).toBe(403);
  });
});

describe('critical security (spec §90)', () => {
  it('student A cannot read or act on student B data', async () => {
    const a = await student();
    const b = await student();
    // No endpoint takes another student id for students; staff endpoints are forbidden.
    expect((await api().get(`/api/v1/students/${b.userId}`).set(authHeaders(a))).status).toBe(403);
    expect((await api().get(`/api/v1/access/students/${b.userId}`).set(authHeaders(a))).status).toBe(403);
    // Notifications of B cannot be marked by A.
    const notification = await prisma.notification.create({
      data: { type: 'SYSTEM', title: 't', body: 'b' },
    });
    const recipient = await prisma.notificationRecipient.create({
      data: { notificationId: notification.id, userId: b.userId },
    });
    const res = await api().post(`/api/v1/student/notifications/${recipient.id}/read`).set(authHeaders(a));
    expect(res.status).toBe(404);
    expect(
      (await prisma.notificationRecipient.findUnique({ where: { id: recipient.id } }))?.readAt,
    ).toBeNull();
    // A's token with B's device header is rejected.
    const spoof = await api()
      .get('/api/v1/student/home')
      .set({ Authorization: `Bearer ${a.token}`, 'X-Device-Id': b.device.identifier });
    expect(spoof.body.error.code).toBe('DEVICE_MISMATCH');
  });

  it('a locked subject cannot be opened through the API', async () => {
    const catalog = await createCatalog();
    const learner = await student();
    await grantTeacher(learner.userId, catalog.physicsAhmad.id); // teacher grant without the subject
    const res = await api()
      .get(`/api/v1/student/subject-teachers/${catalog.physicsAhmad.id}`)
      .set(authHeaders(learner));
    expect(res.status).toBe(403);
    const subject = await api()
      .get(`/api/v1/student/subjects/${catalog.physics.id}`)
      .set(authHeaders(learner));
    expect(subject.body.data.subject.locked).toBe(true);
    expect(subject.body.data.files).toEqual([]);
  });

  it('a locked teacher’s sessions and videos cannot be requested directly', async () => {
    const catalog = await createCatalog();
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const video = await prisma.video.create({
      data: { sessionId: catalog.lockedSession.id, title: 'درس مقفل', status: 'READY', durationSeconds: 60 },
    });
    for (const path of [
      `/api/v1/student/subject-teachers/${catalog.mathMohammad.id}`,
      `/api/v1/student/topics/${catalog.lockedTopic.id}`,
      `/api/v1/student/sessions/${catalog.lockedSession.id}`,
    ]) {
      const res = await api().get(path).set(authHeaders(learner));
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('ACCESS_DENIED');
    }
    const playback = await api()
      .post(`/api/v1/student/videos/${video.id}/playback`)
      .set(authHeaders(learner));
    expect(playback.status).toBe(403);
    expect(playback.body.error.code).toBe('ACCESS_DENIED');
  });

  it('a wrong device cannot use the account', async () => {
    const learner = await student();
    const res = await api()
      .get('/api/v1/student/home')
      .set({ Authorization: `Bearer ${learner.token}`, 'X-Device-Id': 'cloned-device-id-123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_MISMATCH');
  });

  it('an expired token cannot access content', async () => {
    const learner = await student();
    const claims = jwt.decode(learner.token) as jwt.JwtPayload;
    const expired = jwt.sign(
      {
        role: claims.role,
        sid: claims.sid,
        portal: claims.portal,
        did: claims.did,
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      process.env.JWT_ACCESS_SECRET!,
      { subject: claims.sub, issuer: 'edu-platform', audience: 'edu-api' },
    );
    const res = await api()
      .get('/api/v1/student/home')
      .set({ Authorization: `Bearer ${expired}`, 'X-Device-Id': learner.device.identifier });
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('archived content is not active content', async () => {
    const catalog = await createCatalog();
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const video = await prisma.video.create({
      data: { sessionId: catalog.session.id, title: 'فيديو', status: 'READY', durationSeconds: 60 },
    });
    await prisma.video.update({ where: { id: video.id }, data: { archivedAt: new Date() } });
    const session = await api()
      .get(`/api/v1/student/sessions/${catalog.session.id}`)
      .set(authHeaders(learner));
    expect(session.body.data.videos).toEqual([]);
    const playback = await api()
      .post(`/api/v1/student/videos/${video.id}/playback`)
      .set(authHeaders(learner));
    expect(playback.body.error.code).toBe('VIDEO_NOT_FOUND');

    // Archiving an ancestor hides everything below it.
    await prisma.topic.update({ where: { id: catalog.topic.id }, data: { archivedAt: new Date() } });
    const hidden = await api()
      .get(`/api/v1/student/sessions/${catalog.session.id}`)
      .set(authHeaders(learner));
    expect(hidden.status).toBe(404);
    const teacher = await api()
      .get(`/api/v1/student/subject-teachers/${catalog.mathAhmad.id}`)
      .set(authHeaders(learner));
    expect(teacher.body.data.topics).toEqual([]);
  });

  it('videos that are not READY are never playable', async () => {
    const catalog = await createCatalog();
    const learner = await student();
    await grantSubject(learner.userId, catalog.math.id);
    await grantTeacher(learner.userId, catalog.mathAhmad.id);
    const video = await prisma.video.create({
      data: { sessionId: catalog.session.id, title: 'قيد الرفع', status: 'PROCESSING' },
    });
    const res = await api().post(`/api/v1/student/videos/${video.id}/playback`).set(authHeaders(learner));
    expect(res.body.error.code).toBe('VIDEO_NOT_READY');
  });

  it('audit logs are append-only in the database itself', async () => {
    const owner = await staff('OWNER');
    const learner = await student();
    await api()
      .post(`/api/v1/students/${learner.userId}/disable`)
      .set(authHeaders(owner))
      .expect(200);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { actorId: owner.userId } });

    await expect(
      prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'TAMPERED' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);

    const unchanged = await prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } });
    expect(unchanged.action).toBe(entry.action);
  });
});
