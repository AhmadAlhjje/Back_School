import { prisma } from '../../src/core/database/prisma.js';
import { assertStrongPassword, hashPassword } from '../../src/core/security/password.js';
import { normalizePhone, PHONE_PATTERN } from '../../src/core/security/phone.js';

export interface SuperAdminInput {
  name: string;
  phone: string;
  password: string;
}

export function superAdminFromEnv(): SuperAdminInput {
  const name = process.env.SEED_SUPER_ADMIN_NAME?.trim();
  const phone = process.env.SEED_SUPER_ADMIN_PHONE?.trim();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!name || !phone || !password || password.startsWith('CHANGE_ME')) {
    throw new Error('Set SEED_SUPER_ADMIN_NAME, SEED_SUPER_ADMIN_PHONE and SEED_SUPER_ADMIN_PASSWORD first.');
  }
  return { name, phone, password };
}

/**
 * Creates the super admin if no account uses that phone. Never overwrites an existing account
 * (re-running a seed must not reset anyone's password).
 */
export async function ensureSuperAdmin(input: SuperAdminInput): Promise<'created' | 'exists'> {
  const phone = normalizePhone(input.phone);
  if (!PHONE_PATTERN.test(phone)) throw new Error(`Invalid super admin phone: ${input.phone}`);
  assertStrongPassword(input.password);
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    if (existing.role !== 'SUPER_ADMIN') throw new Error(`Phone ${phone} already belongs to a ${existing.role} account.`);
    return 'exists';
  }
  await prisma.user.create({
    data: {
      role: 'SUPER_ADMIN',
      name: input.name,
      phone,
      passwordHash: await hashPassword(input.password),
      passwordChangedAt: new Date(),
    },
  });
  return 'created';
}
