import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import type { UserRole } from '../../src/generated/prisma/enums.js';
import { DEFAULT_PASSWORD, createUser } from './factories.js';

export const app = createApp();
export const api = () => supertest(app);

export interface TestDevice {
  identifier: string;
  platform: 'ANDROID' | 'IOS';
  model: string;
  appVersion: string;
}

export function newDevice(): TestDevice {
  return { identifier: `device-${randomUUID()}`, platform: 'ANDROID', model: 'Pixel 8', appVersion: '1.0.0' };
}

export interface StaffSession {
  userId: string;
  token: string;
  cookie: string;
  phone: string;
}

export async function loginStaff(role: 'SUPER_ADMIN' | 'OWNER', phone: string): Promise<StaffSession> {
  const path = role === 'SUPER_ADMIN' ? '/api/v1/auth/admin/login' : '/api/v1/auth/owner/login';
  const res = await api().post(path).send({ phone, password: DEFAULT_PASSWORD });
  if (res.status !== 200) throw new Error(`Staff login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return {
    userId: res.body.data.user.id,
    token: res.body.data.accessToken,
    cookie: cookies[0]!.split(';')[0]!,
    phone,
  };
}

export async function staff(role: 'SUPER_ADMIN' | 'OWNER'): Promise<StaffSession> {
  const user = await createUser(role);
  return loginStaff(role, user.phone);
}

export interface StudentSession {
  userId: string;
  phone: string;
  token: string;
  refreshToken: string;
  device: TestDevice;
}

export async function loginStudent(phone: string, device: TestDevice = newDevice()): Promise<StudentSession> {
  const res = await api()
    .post('/api/v1/auth/student/login')
    .send({ phone, password: DEFAULT_PASSWORD, device });
  if (res.status !== 200) throw new Error(`Student login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    userId: res.body.data.user.id,
    phone,
    token: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
    device,
  };
}

export async function student(): Promise<StudentSession> {
  const user = await createUser('STUDENT');
  return loginStudent(user.phone);
}

/** Authorization headers for a staff or student session. */
export function authHeaders(session: StaffSession | StudentSession): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${session.token}` };
  if ('device' in session) headers['X-Device-Id'] = session.device.identifier;
  return headers;
}

export type { UserRole };
