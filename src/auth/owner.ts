import type { Request } from 'express';
import type { Config } from '../config.js';
import { verifyPassword } from './passwords.js';
import { Throttle } from './throttle.js';
import { verifyTotp } from './totp.js';

export type OwnerLoginOutcome =
  | { ok: true }
  | { ok: false; error: string; status: 401 | 429 };

/**
 * Verifies the single owner credential used by both the admin UI and the OAuth
 * consent flow: the admin password, plus a TOTP code when A2W_ADMIN_TOTP_SECRET
 * is configured. Attempts are throttled per client IP.
 */
export function verifyOwner(
  config: Config,
  throttle: Throttle,
  ip: string,
  password: unknown,
  totpCode: unknown,
): OwnerLoginOutcome {
  const retryAfter = throttle.check(ip);
  if (retryAfter > 0) {
    return {
      ok: false,
      status: 429,
      error: `Too many attempts. Try again in ${retryAfter} seconds.`,
    };
  }

  const fail = (error: string): OwnerLoginOutcome => {
    throttle.fail(ip);
    return { ok: false, status: 401, error };
  };

  if (typeof password !== 'string' || password.length === 0) return fail('Enter the admin password.');
  if (!verifyPassword(password, config.adminPasswordHash)) return fail('Incorrect credentials.');

  if (config.adminTotpSecret) {
    if (typeof totpCode !== 'string' || totpCode.trim() === '') {
      return fail('Enter the 6-digit code from your authenticator app.');
    }
    if (!verifyTotp(config.adminTotpSecret, totpCode)) return fail('Incorrect credentials.');
  }

  throttle.succeed(ip);
  return { ok: true };
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
