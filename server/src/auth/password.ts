import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

export function newAuthToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 256) {
    throw new Error('Password must be 8-256 characters');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1]!, 'base64url');
    const expected = Buffer.from(parts[2]!, 'base64url');
    const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) && email.trim().length <= 320;
}
