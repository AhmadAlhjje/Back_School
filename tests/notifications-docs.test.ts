import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { routeRegistry } from '../src/core/http/route.js';
import { getMemoryQueues } from '../src/core/queue/queues.js';
import { deliverNotification } from '../src/modules/notifications/notifications.service.js';
import { createCatalog, grantSubject, grantTeacher } from './helpers/factories.js';
import { api, authHeaders, staff, student } from './helpers/http.js';

describe('notifications', () => {
  it('delivers an announcement only to the targeted audience and tracks read state', async () => {
    const catalog = await createCatalog();
    const owner = await staff('OWNER');
    const insider = await student();
    const outsider = await student();
    await grantSubject(insider.userId, catalog.math.id);
    await grantTeacher(insider.userId, catalog.mathAhmad.id);
    // A teacher grant without its subject grant does not count.
    await grantTeacher(outsider.userId, catalog.mathAhmad.id);

    const sent = await api()
      .post('/api/v1/notifications')
      .set(authHeaders(owner))
      .send({
        title: 'تنبيه',
        body: 'درس إضافي غداً',
        audience: { kind: 'SUBJECT_TEACHER', subjectTeacherId: catalog.mathAhmad.id },
      });
    expect(sent.status).toBe(201);
    // Tests run without Redis: the fan-out job waits in the in-process queue (no worker started).
    const job = getMemoryQueues().notifications.getWaiting(`fanout-${sent.body.data.id}`);
    expect(job).toBeDefined();

    // Run what the worker runs.
    expect(await deliverNotification(sent.body.data.id, job!.audience)).toBe(1);

    const count = await api().get('/api/v1/student/notifications/unread-count').set(authHeaders(insider));
    expect(count.body.data.unread).toBe(1);
    expect(
      (await api().get('/api/v1/student/notifications/unread-count').set(authHeaders(outsider))).body.data
        .unread,
    ).toBe(0);

    const inbox = await api().get('/api/v1/student/notifications').set(authHeaders(insider));
    expect(inbox.body.data.items[0]).toMatchObject({ title: 'تنبيه', readAt: null });
    const read = await api()
      .post(`/api/v1/student/notifications/${inbox.body.data.items[0].id}/read`)
      .set(authHeaders(insider));
    expect(read.body.data.unread).toBe(0);

    const list = await api().get('/api/v1/notifications').set(authHeaders(owner));
    expect(list.body.data.items[0]).toMatchObject({ recipients: 1, reads: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'SEND_NOTIFICATION' } })).toBe(1);
  });
});

describe('API documentation and route contract', () => {
  it('serves an OpenAPI document covering every route', async () => {
    const res = await api().get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(50);
    expect(res.body.paths['/api/v1/auth/student/login'].post.requestBody).toBeDefined();
    expect(res.body.components.schemas.ErrorCode.enum).toContain('DEVICE_ALREADY_BOUND');
  });

  it('every route declares its access explicitly', () => {
    for (const routeDef of routeRegistry) {
      const access = routeDef.access;
      const ok =
        access === 'public' || access === 'media-token' || (Array.isArray(access) && access.length > 0);
      expect(ok, `${routeDef.method.toUpperCase()} ${routeDef.fullPath}`).toBe(true);
    }
    const publicRoutes = routeRegistry
      .filter((r) => r.access === 'public')
      .map((r) => `${r.method} ${r.fullPath}`);
    expect(publicRoutes.sort()).toEqual(
      [
        'get /api/v1/media/teachers/:teacherId/image',
        'get /api/v1/public/config',
        'get /api/v1/public/grades',
        'post /api/v1/auth/admin/login',
        'post /api/v1/auth/owner/login',
        'post /api/v1/auth/refresh',
        'post /api/v1/auth/student/login',
        'post /api/v1/auth/student/register',
      ].sort(),
    );
  });

  it('returns the uniform error envelope for unknown routes', async () => {
    const res = await api().get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      data: null,
      message: 'المسار غير موجود',
      error: { code: 'ROUTE_NOT_FOUND', details: null },
    });
    const en = await api().get('/api/v1/nope').set('Accept-Language', 'en');
    expect(en.body.message).toBe('Route not found');
  });

  it('reports readiness of the database (Redis is optional)', async () => {
    const res = await api().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: true, redis: 'not-used' });
  });
});
