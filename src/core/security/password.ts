import argon2 from 'argon2';
import { AppError } from '../errors/app-error.js';

/**
 * Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 iterations, 1 lane).
 * Parameters are encoded in each hash, so they can be raised later without breaking old hashes;
 * `needsRehash` tells the login flow when to upgrade a stored hash.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/**
 * Runs a full Argon2 verification against a throwaway hash. Used when an account does not
 * exist so response timing does not reveal which phone numbers are registered.
 */
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equalizer-not-a-real-password-1');
  await verifyPassword(await dummyHash, plain);
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Strength rule shared by every account type: 8–128 chars, at least one letter and one digit. */
export function isStrongPassword(value: string): boolean {
  return (
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH &&
    /\p{L}/u.test(value) &&
    /\p{Nd}/u.test(value)
  );
}

export function assertStrongPassword(value: string): void {
  if (!isStrongPassword(value)) throw new AppError('WEAK_PASSWORD');
}
