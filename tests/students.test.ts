import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { DEFAULT_PASSWORD, createUser } from './helpers/factories.js';
import { api, authHeaders, loginStudent, newDevice, staff, student } from './helpers/http.js';

describe('student management', () => {
  it('owner creates a student who can then log in and change the password', async () => {
    const owner = await staff('OWNER');
    const created = await api()
      .post('/api/v1/students')
      .set(authHeaders(owner))
      .send({ name: 'سارة', phone: '0987654321', password: 'Student123' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'سارة',
      phone: '0987654321',
      status: 'ACTIVE',
      device: null,
    });

    const device = newDevice();
    const login = await api()
      .post('/api/v1/auth/student/login')
      .send({ phone: '0987654321', password: 'Student123', device });
    expect(login.status).toBe(200);

    const change = await api()
      .post('/api/v1/auth/change-password')
      .set({ Authorization: `Bearer ${login.body.data.accessToken}`, 'X-Device-Id': device.identifier })
      .send({ currentPassword: 'Student123', newPassword: 'Changed123', confirmPassword: 'Changed123' });
    expect(change.status).toBe(200);
  });

  it('rejects duplicate phones and weak passwords', async () => {
    const owner = await staff('OWNER');
    const existing = await createUser('STUDENT');
    const dup = await api()
      .post('/api/v1/students')
      .set(authHeaders(owner))
      .send({ name: 'x', phone: existing.phone, password: 'Student123' });
    expect(dup.body.error.code).toBe('PHONE_ALREADY_EXISTS');
    const weak = await api()
      .post('/api/v1/students')
      .set(authHeaders(owner))
      .send({ name: 'x', phone: '0911111111', password: '12345678' });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('searches by name and phone, filters by status, paginates', async () => {
    const owner = await staff('OWNER');
    await createUser('STUDENT', { name: 'علي حسن', phone: '0911000001' });
    await createUser('STUDENT', { name: 'علي محمود', phone: '0911000002', status: 'DISABLED' });
    await createUser('STUDENT', { name: 'ليلى', phone: '0922000003' });

    const byName = await api().get('/api/v1/students?search=علي').set(authHeaders(owner));
    expect(byName.body.data.total).toBe(2);
    const byPhone = await api().get('/api/v1/students?search=0922').set(authHeaders(owner));
    expect(byPhone.body.data.items[0].name).toBe('ليلى');
    const disabled = await api().get('/api/v1/students?accountStatus=DISABLED').set(authHeaders(owner));
    expect(disabled.body.data.total).toBe(1);
    const paged = await api().get('/api/v1/students?limit=2&page=2').set(authHeaders(owner));
    expect(paged.body.data).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(paged.body.data.items).toHaveLength(1);
  });

  it('disabling a student ends their sessions immediately', async () => {
    const owner = await staff('OWNER');
    const learner = await student();
    const res = await api().post(`/api/v1/students/${learner.userId}/disable`).set(authHeaders(owner));
    expect(res.body.data.status).toBe('DISABLED');
    const home = await api().get('/api/v1/student/home').set(authHeaders(learner));
    expect(home.status).toBe(401);
    const relogin = await api()
      .post('/api/v1/auth/student/login')
      .send({ phone: learner.phone, password: DEFAULT_PASSWORD, device: learner.device });
    expect(relogin.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('only the super admin resets a student password; it revokes sessions and the new password works', async () => {
    const owner = await staff('OWNER');
    const admin = await staff('SUPER_ADMIN');
    const learner = await student();
    const byOwner = await api()
      .post(`/api/v1/students/${learner.userId}/reset-password`)
      .set(authHeaders(owner))
      .send({ newPassword: 'Owner9999x' });
    expect(byOwner.status).toBe(403);
    await api()
      .post(`/api/v1/students/${learner.userId}/reset-password`)
      .set(authHeaders(admin))
      .send({ newPassword: 'Reset12345' });
    expect((await api().get('/api/v1/student/home').set(authHeaders(learner))).status).toBe(401);
    const login = await api()
      .post('/api/v1/auth/student/login')
      .send({ phone: learner.phone, password: 'Reset12345', device: learner.device });
    expect(login.status).toBe(200);
  });

  it('shows the student profile with device and opened content', async () => {
    const owner = await staff('OWNER');
    const learner = await student();
    const res = await api().get(`/api/v1/students/${learner.userId}`).set(authHeaders(owner));
    expect(res.body.data.device).toMatchObject({ platform: 'ANDROID', model: 'Pixel 8' });
    expect(res.body.data.openedSubjects).toEqual([]);
    expect(res.body.data.lastLoginAt).not.toBeNull();
  });
});

describe('device reset', () => {
  it('only the super admin can reset a device', async () => {
    const owner = await staff('OWNER');
    const learner = await student();
    const res = await api().post(`/api/v1/students/${learner.userId}/device/reset`).set(authHeaders(owner));
    expect(res.status).toBe(403);
  });

  it('reset revokes old sessions, allows a new device, and is audited', async () => {
    const admin = await staff('SUPER_ADMIN');
    const learner = await student();
    const blocked = await api()
      .post('/api/v1/auth/student/login')
      .send({ phone: learner.phone, password: DEFAULT_PASSWORD, device: newDevice() });
    expect(blocked.body.error.code).toBe('DEVICE_ALREADY_BOUND');

    const reset = await api().post(`/api/v1/students/${learner.userId}/device/reset`).set(authHeaders(admin));
    expect(reset.status).toBe(200);
    expect(reset.body.data.device).toBeNull();

    // Old device session is dead.
    expect((await api().get('/api/v1/student/home').set(authHeaders(learner))).status).toBe(401);
    // A new device can bind.
    const fresh = await loginStudent(learner.phone, newDevice());
    expect(fresh.token).toBeTypeOf('string');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'RESET_DEVICE' } });
    expect(audit).toMatchObject({ actorId: admin.userId, entityType: 'device' });
    const devices = await prisma.device.findMany({
      where: { studentId: learner.userId },
      orderBy: { firstSeenAt: 'asc' },
    });
    expect(devices.map((d) => d.status)).toEqual(['RESET', 'ACTIVE']);
  });
});

describe('owner account (super admin)', () => {
  it('creates the single owner, prevents a second one, and edits name/phone', async () => {
    const admin = await staff('SUPER_ADMIN');
    const created = await api()
      .post('/api/v1/admin/owners')
      .set(authHeaders(admin))
      .send({ name: 'صاحب المعهد', phone: '0966666666', password: 'Owner12345' });
    expect(created.status).toBe(201);
    const second = await api()
      .post('/api/v1/admin/owners')
      .set(authHeaders(admin))
      .send({ name: 'آخر', phone: '0977777777', password: 'Owner12345' });
    expect(second.body.error.code).toBe('OWNER_ALREADY_EXISTS');

    const updated = await api()
      .patch(`/api/v1/admin/owners/${created.body.data.id}`)
      .set(authHeaders(admin))
      .send({ name: 'الاسم الجديد', phone: '0966666667' });
    expect(updated.body.data).toMatchObject({ name: 'الاسم الجديد', phone: '0966666667' });

    const login = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: '0966666667', password: 'Owner12345' });
    expect(login.status).toBe(200);
  });

  it('the owner has no endpoint to change their own name or phone', async () => {
    const owner = await staff('OWNER');
    const res = await api()
      .patch(`/api/v1/admin/owners/${owner.userId}`)
      .set(authHeaders(owner))
      .send({ name: 'hack' });
    expect(res.status).toBe(403);
  });
});
