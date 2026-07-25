import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Short, filesystem-safe, lowercase identifier used for site and version
 * directory names. 12 chars of this alphabet is ~62 bits of entropy.
 */
export function newId(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'assets',
  'healthz',
  'mcp',
  'oauth',
  's',
  'static',
  'well-known',
  'www',
]);

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug) && !slug.includes('--');
}

/** Derives a candidate slug from a human title. Returns '' when nothing usable remains. */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '');
  return base;
}
