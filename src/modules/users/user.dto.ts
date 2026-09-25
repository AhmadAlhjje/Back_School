import type { User } from '../../generated/prisma/client.js';

/** Public shape of an account. Never includes the password hash. */
export interface AccountDto {
  id: string;
  role: User['role'];
  name: string;
  phone: string;
  status: User['status'];
  archived: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toAccountDto(user: User): AccountDto {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    phone: user.phone,
    status: user.status,
    archived: user.archivedAt !== null,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}
