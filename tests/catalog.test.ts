import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { api, authHeaders, staff, student } from './helpers/http.js';

describe('catalog management (grades → subjects → teachers → topics → sessions)', () => {
  it('lets the owner build the full content hierarchy', async () => {
    const owner = await staff('OWNER');
    const h = authHeaders(owner);

    const grade = await api().post('/api/v1/grades').set(h).send({ name: 'البكالوريا' });
    expect(grade.status).toBe(201);
    const subject = await api()
      .post('/api/v1/subjects')
      .set(h)
      .send({ gradeId: grade.body.data.id, name: 'رياضيات' });
    expect(subject.status).toBe(201);
    const teacher = await api()
      .post('/api/v1/teachers')
      .set(h)
      .send({ name: 'أحمد', phone: '0955555555', subjectIds: [subject.body.data.id] });
    expect(teacher.status).toBe(201);
    expect(teacher.body.data.subjects).toHaveLength(1);
    const subjectTeacherId = teacher.body.data.subjects[0].id;

    const topic = await api().post('/api/v1/topics').set(h).send({ subjectTeacherId, title: 'التفاضل' });
    expect(topic.status).toBe(201);
    const session = await api()
      .post('/api/v1/sessions')
      .set(h)
      .send({ topicId: topic.body.data.id, title: 'الجلسة الأولى' });
    expect(session.status).toBe(201);

    const space = await api().get(`/api/v1/subject-teachers/${subjectTeacherId}`).set(h);
    expect(space.body.data.topics).toHaveLength(1);
    expect(space.body.data.topics[0].sessionsCount).toBe(1);

    // Every step is audited.
    const actions = (await prisma.auditLog.findMany({ where: { actorId: owner.userId } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'CREATE_GRADE',
        'CREATE_SUBJECT',
        'CREATE_TEACHER',
        'CREATE_TOPIC',
        'CREATE_SESSION',
      ]),
    );
  });

  it('rolls back teacher creation when a subject is invalid (transaction)', async () => {
    const owner = await staff('OWNER');
    const res = await api()
      .post('/api/v1/teachers')
      .set(authHeaders(owner))
      .send({ name: 'أحمد', subjectIds: ['0190f000-0000-7000-8000-000000000000'] });
    expect(res.status).toBe(404);
    expect(await prisma.teacher.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_TEACHER' } })).toBe(0);
  });

  it('archives and restores without deleting, and blocks children under archived parents', async () => {
    const owner = await staff('OWNER');
    const h = authHeaders(owner);
    const grade = (await api().post('/api/v1/grades').set(h).send({ name: 'العاشر' })).body.data;

    const archived = await api().post(`/api/v1/grades/${grade.id}/archive`).set(h);
    expect(archived.status).toBe(200);
    expect(archived.body.data.archivedAt).not.toBeNull();
    expect(await prisma.grade.count()).toBe(1);

    const active = await api().get('/api/v1/grades').set(h);
    expect(active.body.data).toHaveLength(0);
    const all = await api().get('/api/v1/grades?status=all').set(h);
    expect(all.body.data).toHaveLength(1);

    const child = await api().post('/api/v1/subjects').set(h).send({ gradeId: grade.id, name: 'فيزياء' });
    expect(child.status).toBe(409);
    expect(child.body.error.code).toBe('PARENT_ARCHIVED');

    const restored = await api().post(`/api/v1/grades/${grade.id}/restore`).set(h);
    expect(restored.body.data.archivedAt).toBeNull();
  });

  it('rejects duplicate active names in the same grade', async () => {
    const owner = await staff('OWNER');
    const h = authHeaders(owner);
    const grade = (await api().post('/api/v1/grades').set(h).send({ name: 'التاسع' })).body.data;
    await api().post('/api/v1/subjects').set(h).send({ gradeId: grade.id, name: 'كيمياء' });
    const dup = await api().post('/api/v1/subjects').set(h).send({ gradeId: grade.id, name: 'كيمياء' });
    expect(dup.status).toBe(409);
  });

  it('reorders with sortOrder and rejects foreign ids', async () => {
    const owner = await staff('OWNER');
    const h = authHeaders(owner);
    const a = (await api().post('/api/v1/grades').set(h).send({ name: 'أ' })).body.data;
    const b = (await api().post('/api/v1/grades').set(h).send({ name: 'ب' })).body.data;
    const c = (await api().post('/api/v1/grades').set(h).send({ name: 'ج' })).body.data;

    const ok = await api()
      .put('/api/v1/grades/reorder')
      .set(h)
      .send({ ids: [c.id, a.id, b.id] });
    expect(ok.status).toBe(200);
    const list = await api().get('/api/v1/grades').set(h);
    expect(list.body.data.map((g: { id: string }) => g.id)).toEqual([c.id, a.id, b.id]);

    const bad = await api()
      .put('/api/v1/grades/reorder')
      .set(h)
      .send({ ids: [a.id, a.id] });
    expect(bad.status).toBe(400);
  });

  it('unassigning a teacher keeps its content and reassigning restores it', async () => {
    const owner = await staff('OWNER');
    const h = authHeaders(owner);
    const grade = (await api().post('/api/v1/grades').set(h).send({ name: 'الحادي عشر' })).body.data;
    const subject = (await api().post('/api/v1/subjects').set(h).send({ gradeId: grade.id, name: 'رياضيات' }))
      .body.data;
    const teacher = (await api().post('/api/v1/teachers').set(h).send({ name: 'محمد' })).body.data;
    const assigned = await api()
      .post(`/api/v1/subjects/${subject.id}/teachers`)
      .set(h)
      .send({ teacherId: teacher.id });
    expect(assigned.status).toBe(201);
    await api()
      .post('/api/v1/topics')
      .set(h)
      .send({ subjectTeacherId: assigned.body.data.id, title: 'الجبر' });

    await api().post(`/api/v1/subject-teachers/${assigned.body.data.id}/archive`).set(h);
    const again = await api()
      .post(`/api/v1/subjects/${subject.id}/teachers`)
      .set(h)
      .send({ teacherId: teacher.id });
    expect(again.body.data.id).toBe(assigned.body.data.id);
    const space = await api().get(`/api/v1/subject-teachers/${assigned.body.data.id}`).set(h);
    expect(space.body.data.topics).toHaveLength(1);
  });
});

describe('role-based access control', () => {
  it('forbids students from staff endpoints', async () => {
    const learner = await student();
    for (const path of [
      '/api/v1/students',
      '/api/v1/grades',
      '/api/v1/teachers',
      '/api/v1/dashboard/stats',
    ]) {
      const res = await api().get(path).set(authHeaders(learner));
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('forbids the owner from super admin endpoints', async () => {
    const owner = await staff('OWNER');
    for (const path of [
      '/api/v1/audit-logs',
      '/api/v1/devices',
      '/api/v1/admin/owners',
      '/api/v1/admin/settings',
      '/api/v1/dashboard/system',
    ]) {
      const res = await api().get(path).set(authHeaders(owner));
      expect(res.status, path).toBe(403);
    }
  });

  it('forbids staff from student endpoints', async () => {
    const owner = await staff('OWNER');
    const res = await api().get('/api/v1/student/home').set(authHeaders(owner));
    expect(res.status).toBe(403);
  });

  it('validates ids before touching the database', async () => {
    const owner = await staff('OWNER');
    const res = await api().get('/api/v1/grades/not-a-uuid').set(authHeaders(owner));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
