import type { Config } from './config.js';
import type { WebCryptoProvider } from '../core/crypto.js';
import type { Throttle } from './throttle.js';
import { verifyTotp } from './totp.js';

export type OwnerLoginOutcome = { ok: true } | { ok: false; error: string; status: 401 | 429 };

/**
 * Verifies the single owner credential used by both the admin UI and the OAuth
 * consent flow: the admin password, plus a TOTP code when A2W_ADMIN_TOTP_SECRET
 * is configured. Attempts are throttled per client IP.
 */
export async function verifyOwner(
  config: Config,
  crypto: WebCryptoProvider,
  throttle: Throttle,
  ip: string,
  password: unknown,
  totpCode: unknown,
): Promise<OwnerLoginOutcome> {
  const retryAfter = await throttle.check(ip);
  if (retryAfter > 0) {
    return {
      ok: false,
      status: 429,
      error: `Too many attempts. Try again in ${retryAfter} seconds.`,
    };
  }

  const fail = async (error: string): Promise<OwnerLoginOutcome> => {
    await throttle.fail(ip);
    return { ok: false, status: 401, error };
  };

  if (typeof password !== 'string' || password.length === 0) {
    return fail('Enter the admin password.');
  }
  if (!(await crypto.verifyPassword(password, config.adminPasswordHash))) {
    return fail('Incorrect credentials.');
  }

  if (config.adminTotpSecret) {
    if (typeof totpCode !== 'string' || totpCode.trim() === '') {
      return fail('Enter the 6-digit code from your authenticator app.');
    }
    if (!(await verifyTotp(config.adminTotpSecret, totpCode))) {
      return fail('Incorrect credentials.');
    }
  }

  await throttle.succeed(ip);
  return { ok: true };
}
