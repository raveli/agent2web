import mime from 'mime';
import { UserError } from '../util/errors.js';

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 200;

/**
 * Turns caller-supplied file paths into a safe relative POSIX path, or throws a
 * UserError explaining exactly what was wrong.
 *
 * This is the only place that decides what may become a stored key, so every
 * write goes through it. It deliberately uses no path library: the rules are
 * stated here in full rather than delegated to a platform whose normalisation
 * differs between runtimes.
 */
export function normalizeSitePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new UserError('File path must be a non-empty string, e.g. "index.html".');
  }
  let raw = input.trim();
  if (raw.includes('\0')) {
    throw new UserError(`File path contains a NUL byte: ${JSON.stringify(input)}`);
  }
  if (raw.includes('\\')) {
    throw new UserError(
      `File path must use forward slashes, got ${JSON.stringify(input)}. Example: "assets/app.css".`,
    );
  }
  if (raw.includes(':')) {
    throw new UserError(`File path must not contain ':' — got ${JSON.stringify(input)}.`);
  }
  raw = raw.replace(/^\/+/, '');
  if (raw === '') {
    throw new UserError('File path must not be "/" — name a file such as "index.html".');
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw new UserError(`File path is longer than ${MAX_PATH_LENGTH} characters.`);
  }

  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') {
      throw new UserError(
        `File path must not contain empty or "." segments: ${JSON.stringify(input)}.`,
      );
    }
    if (segment === '..') {
      throw new UserError(`File path must not contain ".." segments: ${JSON.stringify(input)}.`);
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new UserError(`File path segment "${segment.slice(0, 32)}…" is too long.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      throw new UserError(`File path contains control characters: ${JSON.stringify(input)}.`);
    }
    out.push(segment);
  }

  const joined = out.join('/');
  // Belt and braces: whatever the loop above believed, the result must be a
  // plain relative path with no traversal left in it.
  if (joined.startsWith('/') || joined.split('/').includes('..')) {
    throw new UserError(`File path is not a safe relative path: ${JSON.stringify(input)}.`);
  }
  return joined;
}

/** Percent-decodes a URL path, rejecting anything that decodes to a traversal. */
export function decodeRequestPath(requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const stripped = decoded.replace(/^\/+/, '');
  if (stripped.split('/').some(segment => segment === '..')) return undefined;
  return stripped;
}

/**
 * Candidate files for a request path, in priority order: the path itself, then a
 * directory index, then an implicit .html extension.
 */
export function candidatesFor(requestPath: string): string[] {
  const decoded = decodeRequestPath(requestPath);
  if (decoded === undefined) return [];
  const raw =
    decoded === '' || decoded.endsWith('/')
      ? [`${decoded}index.html`]
      : [decoded, `${decoded}/index.html`, `${decoded}.html`];

  const safe: string[] = [];
  for (const candidate of raw) {
    try {
      safe.push(normalizeSitePath(candidate));
    } catch {
      // A candidate that cannot be a valid key simply is not a candidate.
    }
  }
  return safe;
}

export function contentTypeFor(path: string): string {
  const type = mime.getType(path) ?? 'application/octet-stream';
  if (type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml') {
    return `${type}; charset=utf-8`;
  }
  return type;
}

/**
 * The files a browser fetches as subresources rather than navigating to.
 *
 * The distinction matters only on password-protected sites: a navigation carries
 * the unlock cookie, and a subresource request from the sandboxed page does not,
 * so stylesheets and scripts are denied while linked pages are fine.
 */
export function subresourcePaths(paths: string[]): string[] {
  return paths.filter(path => !/\.html?$/i.test(path)).sort();
}

/** True for a Sec-Fetch-Dest that the browser will render as its own document. */
export function isDocumentDestination(dest: string | undefined): boolean {
  if (!dest) return true; // Absent header: assume a browser navigation or curl.
  return dest === 'document' || dest === 'iframe' || dest === 'frame' || dest === 'object' || dest === 'embed';
}

// Object keys mirror what the filesystem layout used to be, so a bucket listing
// is still readable by a human: sites/<site-id>/<version-id>/<path>
export const versionPrefix = (siteId: string, versionId: string) =>
  `sites/${siteId}/${versionId}/`;
export const sitePrefix = (siteId: string) => `sites/${siteId}/`;
export const blobKey = (siteId: string, versionId: string, path: string) =>
  `${versionPrefix(siteId, versionId)}${normalizeSitePath(path)}`;
