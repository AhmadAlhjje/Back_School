import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { DEFAULT_PASSWORD, createUser } from './helpers/factories.js';
import { api, authHeaders, loginStaff, loginStudent, newDevice, staff, student } from './helpers/http.js';

describe('staff authentication', () => {
  it('logs in a super admin, sets an httpOnly refresh cookie and returns a working access token', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const res = await api()
      .post('/api/v1/auth/admin/login')
      .send({ phone: admin.phone, password: DEFAULT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ id: admin.id, role: 'SUPER_ADMIN' });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^edu_admin_rt=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(admin.id);
  });

  it('rejects an owner on the admin portal and an admin on the owner portal', async () => {
    const owner = await createUser('OWNER');
    const admin = await createUser('SUPER_ADMIN');
    const a = await api()
      .post('/api/v1/auth/admin/login')
      .send({ phone: owner.phone, password: DEFAULT_PASSWORD });
    const b = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: admin.phone, password: DEFAULT_PASSWORD });
    expect(a.status).toBe(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.status).toBe(401);
  });

  it('returns INVALID_CREDENTIALS for a wrong password and audits the failure', async () => {
    const owner = await createUser('OWNER');
    const res = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: owner.phone, password: 'WrongPass999' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, data: null, error: { code: 'INVALID_CREDENTIALS' } });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'LOGIN_FAILED', entityId: owner.id } });
    expect(audit).not.toBeNull();
  });

  it('returns the same error for unknown phones', async () => {
    const res = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: '0999999999', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('accepts Arabic-Indic digits in the phone number', async () => {
    const owner = await createUser('OWNER', { phone: '0912345678' });
    const res = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: '٠٩١٢٣٤٥٦٧٨', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(owner.id);
  });

  it('blocks disabled accounts', async () => {
    const owner = await createUser('OWNER', { status: 'DISABLED' });
    const res = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: owner.phone, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('rotates the web refresh cookie and rejects the old one', async () => {
    const owner = await createUser('OWNER');
    const session = await loginStaff('OWNER', owner.phone);
    const first = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .send({ portal: 'OWNER_WEB' });
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toBeTypeOf('string');
    const rotatedCookie = (first.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(rotatedCookie).not.toBe(session.cookie);

    const replay = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .send({ portal: 'OWNER_WEB' });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    const next = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookie)
      .send({ portal: 'OWNER_WEB' });
    expect(next.status).toBe(200);
  });

  it('does not accept an owner refresh cookie for the admin portal', async () => {
    const owner = await createUser('OWNER');
    const session = await loginStaff('OWNER', owner.phone);
    const cookieValue = session.cookie.split('=')[1]!;
    const res = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `edu_admin_rt=${cookieValue}`)
      .send({ portal: 'ADMIN_WEB' });
    expect(res.status).toBe(401);
  });

  it('logout revokes the session so the access token stops working', async () => {
    const session = await staff('OWNER');
    const out = await api().post('/api/v1/auth/logout').set(authHeaders(session));
    expect(out.status).toBe(200);
    const me = await api().get('/api/v1/auth/me').set(authHeaders(session));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });
});

describe('tokens', () => {
  it('rejects requests without a token', async () => {
    const res = await api().get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a tampered token', async () => {
    const session = await staff('OWNER');
    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${session.token}x`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired token', async () => {
    const session = await staff('OWNER');
    const claims = jwt.decode(session.token) as jwt.JwtPayload;
    const expired = jwt.sign(
      {
        role: claims.role,
        sid: claims.sid,
        portal: claims.portal,
        did: null,
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      process.env.JWT_ACCESS_SECRET!,
      { algorithm: 'HS256', subject: claims.sub, issuer: 'edu-platform', audience: 'edu-api' },
    );
    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign(
      { role: 'SUPER_ADMIN', sid: 'x', portal: 'ADMIN_WEB' },
      'another-secret-another-secret-123',
      {
        subject: 'someone',
        issuer: 'edu-platform',
        audience: 'edu-api',
      },
    );
    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('stops an existing session when the account gets disabled', async () => {
    const session = await staff('OWNER');
    await prisma.user.update({ where: { id: session.userId }, data: { status: 'DISABLED' } });
    const res = await api().get('/api/v1/auth/me').set(authHeaders(session));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('student authentication and device binding', () => {
  it('binds the device on first login and records it', async () => {
    const user = await createUser('STUDENT');
    const device = newDevice();
    const session = await loginStudent(user.phone, device);
    expect(session.refreshToken).toBeTypeOf('string');

    const bound = await prisma.device.findMany({ where: { studentId: user.id } });
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ status: 'ACTIVE', activeStudentId: user.id, platform: 'ANDROID' });
    expect(bound[0]!.identifierHash).not.toBe(device.identifier);
    expect(await prisma.auditLog.count({ where: { action: 'DEVICE_BOUND', actorId: user.id } })).toBe(1);
  });

  it('allows repeated logins from the bound device', async () => {
    const user = await createUser('STUDENT');
    const device = newDevice();
    await loginStudent(user.phone, device);
    const again = await loginStudent(user.phone, device);
    expect(again.token).toBeTypeOf('string');
    expect(await prisma.device.count({ where: { studentId: user.id } })).toBe(1);
  });

  it('rejects login from a second device with DEVICE_ALREADY_BOUND', async () => {
    const user = await createUser('STUDENT');
    await loginStudent(user.phone, newDevice());
    const res = await api()
      .post('/api/v1/auth/student/login')
      .send({ phone: user.phone, password: DEFAULT_PASSWORD, device: newDevice() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_ALREADY_BOUND');
    expect(
      await prisma.auditLog.count({ where: { action: 'LOGIN_DEVICE_REJECTED', actorId: user.id } }),
    ).toBe(1);
  });

  it('rejects student requests from another device header', async () => {
    const session = await student();
    const res = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-Device-Id', 'some-other-device-identifier');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_MISMATCH');
    const missing = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${session.token}`);
    expect(missing.status).toBe(403);
  });

  it('requires device information to log in', async () => {
    const user = await createUser('STUDENT');
    const res = await api()
      .post('/api/v1/auth/student/login')
      .send({ phone: user.phone, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rotates the app refresh token only with the bound device header', async () => {
    const session = await student();
    const wrongDevice = await api()
      .post('/api/v1/auth/refresh')
      .set('X-Device-Id', 'another-device-123')
      .send({ refreshToken: session.refreshToken });
    expect(wrongDevice.status).toBe(403);
    expect(wrongDevice.body.error.code).toBe('DEVICE_MISMATCH');

    const ok = await api()
      .post('/api/v1/auth/refresh')
      .set('X-Device-Id', session.device.identifier)
      .send({ refreshToken: session.refreshToken });
    expect(ok.status).toBe(200);
    expect(ok.body.data.refreshToken).not.toBe(session.refreshToken);
  });

  it('revokes the whole session when a rotated refresh token is replayed later (theft detection)', async () => {
    const session = await student();
    const rotated = await api()
      .post('/api/v1/auth/refresh')
      .set('X-Device-Id', session.device.identifier)
      .send({ refreshToken: session.refreshToken });
    expect(rotated.status).toBe(200);

    // Simulate the stolen copy being used a minute later.
    await prisma.refreshToken.updateMany({
      where: { rotatedAt: { not: null } },
      data: { rotatedAt: new Date(Date.now() - 60_000) },
    });
    const replay = await api()
      .post('/api/v1/auth/refresh')
      .set('X-Device-Id', session.device.identifier)
      .send({ refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);

    // The legitimate, newer refresh token is now dead too.
    const legit = await api()
      .post('/api/v1/auth/refresh')
      .set('X-Device-Id', session.device.identifier)
      .send({ refreshToken: rotated.body.data.refreshToken });
    expect(legit.status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'REFRESH_TOKEN_REUSE' } })).toBe(1);
  });

  it('refuses self-registration when the super admin turned it off', async () => {
    await prisma.systemSetting.create({ data: { key: 'studentSelfRegistration', value: false } });
    const res = await api()
      .post('/api/v1/auth/student/register')
      .send({ name: 'طالب جديد', phone: '0933333333', password: 'Student123', device: newDevice() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REGISTRATION_DISABLED');
  });

  it('lets students create their own account by default', async () => {
    const config = await api().get('/api/v1/public/config');
    expect(config.body.data.studentSelfRegistration).toBe(true);
    const device = newDevice();
    const res = await api()
      .post('/api/v1/auth/student/register')
      .send({ name: 'طالب جديد', phone: '0933333333', password: 'Student123', device });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role: 'STUDENT', name: 'طالب جديد' });
    const profile = await prisma.studentProfile.findUnique({ where: { userId: res.body.data.user.id } });
    expect(profile?.source).toBe('SELF_REGISTERED');

    const duplicate = await api()
      .post('/api/v1/auth/student/register')
      .send({ name: 'آخر', phone: '0933333333', password: 'Student123', device: newDevice() });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('PHONE_ALREADY_EXISTS');
  });

  it('lets the student choose a grade from the public list when creating the account', async () => {
    const first = await prisma.grade.create({ data: { name: 'التاسع', sortOrder: 2 } });
    const second = await prisma.grade.create({ data: { name: 'البكالوريا', sortOrder: 1 } });
    await prisma.grade.create({ data: { name: 'صف محذوف', sortOrder: 0, archivedAt: new Date() } });
    const grades = await api().get('/api/v1/public/grades');
    expect(grades.status).toBe(200);
    expect(grades.body.data).toEqual([
      { id: second.id, name: 'البكالوريا' },
      { id: first.id, name: 'التاسع' },
    ]);

    const res = await api().post('/api/v1/auth/student/register').send({
      name: 'طالب',
      phone: '0955555555',
      password: 'Student123',
      gradeId: first.id,
      device: newDevice(),
    });
    expect(res.status).toBe(201);
    const profile = await prisma.studentProfile.findUnique({ where: { userId: res.body.data.user.id } });
    expect(profile?.gradeId).toBe(first.id);

    const unknown = await api().post('/api/v1/auth/student/register').send({
      name: 'طالب',
      phone: '0966666666',
      password: 'Student123',
      gradeId: '01900000-0000-7000-8000-000000000000',
      device: newDevice(),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toMatchObject({ field: 'gradeId', reason: 'GRADE_NOT_FOUND' });
  });

  it('rejects weak passwords on registration', async () => {
    const res = await api()
      .post('/api/v1/auth/student/register')
      .send({ name: 'طالب', phone: '0944444444', password: 'short', device: newDevice() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

describe('password change', () => {
  it('changes the password and revokes the other sessions only', async () => {
    const owner = await createUser('OWNER');
    const first = await loginStaff('OWNER', owner.phone);
    const second = await loginStaff('OWNER', owner.phone);

    const res = await api().post('/api/v1/auth/change-password').set(authHeaders(second)).send({
      currentPassword: DEFAULT_PASSWORD,
      newPassword: 'NewPassw0rd',
      confirmPassword: 'NewPassw0rd',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.revokedSessions).toBe(1);

    expect((await api().get('/api/v1/auth/me').set(authHeaders(first))).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(authHeaders(second))).status).toBe(200);

    const oldLogin = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: owner.phone, password: DEFAULT_PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api()
      .post('/api/v1/auth/owner/login')
      .send({ phone: owner.phone, password: 'NewPassw0rd' });
    expect(newLogin.status).toBe(200);
  });

  it('requires the correct current password and a matching confirmation', async () => {
    const session = await student();
    const wrong = await api()
      .post('/api/v1/auth/change-password')
      .set(authHeaders(session))
      .send({ currentPassword: 'Nope12345', newPassword: 'NewPassw0rd', confirmPassword: 'NewPassw0rd' });
    expect(wrong.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    const mismatch = await api()
      .post('/api/v1/auth/change-password')
      .set(authHeaders(session))
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'NewPassw0rd', confirmPassword: 'Different1' });
    expect(mismatch.body.error.code).toBe('PASSWORD_CONFIRMATION_MISMATCH');
  });
});

describe('rate limiting', () => {
  it('limits repeated login attempts for one account', async () => {
    const owner = await createUser('OWNER');
    const attempts = [];
    for (let i = 0; i < 11; i += 1) {
      attempts.push(
        await api().post('/api/v1/auth/owner/login').send({ phone: owner.phone, password: 'Wrong12345' }),
      );
    }
    expect(attempts.slice(0, 10).every((res) => res.status === 401)).toBe(true);
    expect(attempts[10]!.status).toBe(429);
    expect(attempts[10]!.body.error.code).toBe('RATE_LIMITED');
  });
});
