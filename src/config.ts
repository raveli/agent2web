import { z } from 'zod';

/**
 * All configuration comes from the environment so the same image can run under
 * docker compose, plain docker or Kubernetes without a config file.
 */

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform(v => {
      if (v === undefined || v.trim() === '') return dflt;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (dflt: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v.trim() === '' ? dflt : Number(v)))
    .refine(v => Number.isInteger(v) && v >= min && v <= max, {
      message: `must be an integer between ${min} and ${max}`,
    });

const optionalString = z
  .string()
  .optional()
  .transform(v => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const schema = z.object({
  A2W_PUBLIC_URL: z
    .string()
    .min(1, 'is required, e.g. https://a2w.example.com')
    .transform(v => v.trim().replace(/\/+$/, ''))
    .refine(v => /^https?:\/\/[^/]+$/.test(v), {
      message: 'must be an origin such as https://a2w.example.com (no path)',
    }),
  A2W_SECRET: z.string().min(32, 'must be at least 32 characters — run `npm run gen-secrets`'),
  A2W_ADMIN_PASSWORD_HASH: optionalString,
  A2W_ADMIN_PASSWORD: optionalString,
  A2W_ADMIN_TOTP_SECRET: optionalString,
  A2W_API_TOKEN: optionalString,
  A2W_SITES_BASE_DOMAIN: optionalString.transform(v => v?.toLowerCase().replace(/^\.+/, '')),
  A2W_SITES_PATH_PREFIX: z
    .string()
    .optional()
    .transform(v => {
      const raw = (v ?? '/s').trim();
      const cleaned = `/${raw.replace(/^\/+|\/+$/g, '')}`;
      return cleaned === '/' ? '/s' : cleaned;
    })
    .refine(v => /^\/[a-z0-9-]{1,32}$/.test(v), {
      message: 'must look like /s (lowercase letters, digits and dashes)',
    }),
  A2W_SITE_SANDBOX: z.enum(['auto', 'always', 'never']).optional().default('auto'),
  A2W_DATA_DIR: z
    .string()
    .optional()
    .transform(v => (v === undefined || v.trim() === '' ? '/data' : v.trim())),
  A2W_PORT: int(8080, 1, 65535),
  A2W_BIND: z
    .string()
    .optional()
    .transform(v => (v === undefined || v.trim() === '' ? '0.0.0.0' : v.trim())),
  A2W_TRUST_PROXY: bool(true),
  A2W_MAX_FILE_BYTES: int(5 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  A2W_MAX_SITE_BYTES: int(50 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
  A2W_MAX_FILES: int(200, 1, 5000),
  A2W_KEEP_VERSIONS: int(10, 1, 1000),
  A2W_SITE_COOKIE_TTL_HOURS: int(168, 1, 24 * 365),
  A2W_ADMIN_SESSION_TTL_HOURS: int(12, 1, 24 * 90),
  A2W_EXTRA_REDIRECT_URIS: z
    .string()
    .optional()
    .transform(v =>
      (v ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ),
});

export type Config = {
  publicUrl: string;
  publicOrigin: URL;
  /** Canonical resource identifier for the MCP endpoint (RFC 8707 audience). */
  mcpUrl: string;
  secret: string;
  adminPasswordHash: string;
  adminTotpSecret?: string;
  apiToken?: string;
  sitesBaseDomain?: string;
  sitesPathPrefix: string;
  siteSandbox: 'auto' | 'always' | 'never';
  dataDir: string;
  port: number;
  bind: string;
  trustProxy: boolean;
  maxFileBytes: number;
  maxSiteBytes: number;
  maxFiles: number;
  keepVersions: number;
  siteCookieTtlHours: number;
  adminSessionTtlHours: number;
  extraRedirectUris: string[];
  warnings: string[];
};

export class ConfigError extends Error {}

/**
 * Parses and validates configuration, throwing a single readable error listing
 * every problem rather than failing one variable at a time.
 *
 * `hashPassword` is injected to keep this module free of crypto imports for tests.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  hashPassword: (plaintext: string) => string,
): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const v = parsed.data;
  const warnings: string[] = [];

  let adminPasswordHash = v.A2W_ADMIN_PASSWORD_HASH;
  if (!adminPasswordHash) {
    if (!v.A2W_ADMIN_PASSWORD) {
      throw new ConfigError(
        'Invalid configuration:\n  A2W_ADMIN_PASSWORD_HASH: is required (or set A2W_ADMIN_PASSWORD). Run `npm run gen-secrets` to generate one.',
      );
    }
    if (v.A2W_ADMIN_PASSWORD.length < 12) {
      throw new ConfigError(
        'Invalid configuration:\n  A2W_ADMIN_PASSWORD: must be at least 12 characters',
      );
    }
    adminPasswordHash = hashPassword(v.A2W_ADMIN_PASSWORD);
    warnings.push(
      'A2W_ADMIN_PASSWORD is set in plaintext. Prefer A2W_ADMIN_PASSWORD_HASH (see `npm run gen-secrets`).',
    );
  }

  if (v.A2W_API_TOKEN && v.A2W_API_TOKEN.length < 32) {
    throw new ConfigError(
      'Invalid configuration:\n  A2W_API_TOKEN: must be at least 32 characters, or unset to disable static token auth',
    );
  }

  const publicOrigin = new URL(v.A2W_PUBLIC_URL);
  if (publicOrigin.protocol !== 'https:' && !isLocalHostname(publicOrigin.hostname)) {
    warnings.push(
      `A2W_PUBLIC_URL uses ${publicOrigin.protocol} on a non-local host. OAuth clients such as Claude require https.`,
    );
  }
  if (v.A2W_SITES_BASE_DOMAIN && v.A2W_SITES_BASE_DOMAIN === publicOrigin.hostname) {
    warnings.push(
      'A2W_SITES_BASE_DOMAIN equals the app hostname. Use a dedicated domain (e.g. sites.example.com) so published pages are isolated from the admin origin.',
    );
  }

  return {
    publicUrl: v.A2W_PUBLIC_URL,
    publicOrigin,
    mcpUrl: `${v.A2W_PUBLIC_URL}/mcp`,
    secret: v.A2W_SECRET,
    adminPasswordHash,
    adminTotpSecret: v.A2W_ADMIN_TOTP_SECRET,
    apiToken: v.A2W_API_TOKEN,
    sitesBaseDomain: v.A2W_SITES_BASE_DOMAIN,
    sitesPathPrefix: v.A2W_SITES_PATH_PREFIX,
    siteSandbox: v.A2W_SITE_SANDBOX,
    dataDir: v.A2W_DATA_DIR,
    port: v.A2W_PORT,
    bind: v.A2W_BIND,
    trustProxy: v.A2W_TRUST_PROXY,
    maxFileBytes: v.A2W_MAX_FILE_BYTES,
    maxSiteBytes: v.A2W_MAX_SITE_BYTES,
    maxFiles: v.A2W_MAX_FILES,
    keepVersions: v.A2W_KEEP_VERSIONS,
    siteCookieTtlHours: v.A2W_SITE_COOKIE_TTL_HOURS,
    adminSessionTtlHours: v.A2W_ADMIN_SESSION_TTL_HOURS,
    extraRedirectUris: v.A2W_EXTRA_REDIRECT_URIS,
    warnings,
  };
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
