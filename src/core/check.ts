import { candidatesFor } from './paths.js';

/**
 * Which files a site's pages point at that the site does not have.
 *
 * Works from the stored files rather than by fetching the live site, so it
 * needs no password for a locked site and makes no requests. It reads what a
 * browser would request up front: href and src attributes in HTML, and url()
 * in CSS. A URL assembled by JavaScript at runtime is invisible to it.
 */

export type CheckFile = { path: string; contentType: string; text?: string };
export type MissingReference = { file: string; reference: string; resolved: string };

// Any scheme (https:, data:, mailto:, javascript:, ...) or protocol-relative
// URL points somewhere this site does not serve.
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const ATTRIBUTE = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
const BASE = 'https://site.invalid/';

export function findMissingReferences(files: CheckFile[]): MissingReference[] {
  const present = new Set(files.map(f => f.path));
  const missing: MissingReference[] = [];
  for (const file of files) {
    if (file.text === undefined) continue;
    const pattern = file.contentType.startsWith('text/html')
      ? ATTRIBUTE
      : file.contentType.startsWith('text/css')
        ? CSS_URL
        : undefined;
    if (!pattern) continue;
    for (const match of file.text.matchAll(pattern)) {
      const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      const resolved = resolve(file.path, reference);
      if (resolved === undefined) continue;
      if (!candidatesFor(resolved).some(candidate => present.has(candidate))) {
        missing.push({ file: file.path, reference, resolved: resolved.replace(/^\//, '') });
      }
    }
  }
  return missing;
}

/** The site path a browser requests for `reference` on page `from`, or undefined if it is not ours. */
function resolve(from: string, reference: string): string | undefined {
  if (reference === '' || reference.startsWith('#') || EXTERNAL.test(reference)) return undefined;
  // Template placeholders are filled in at runtime, not requested as written.
  if (/\$\{|\{\{/.test(reference)) return undefined;
  let url: URL;
  try {
    url = new URL(reference, BASE + from);
  } catch {
    return undefined;
  }
  return url.origin === new URL(BASE).origin ? url.pathname : undefined;
}
