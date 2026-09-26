import { candidatesFor } from './paths.js';

/**
 * Which files a site's pages point at that the site does not have.
 *
 * Works from the stored files rather than by fetching the live site, so it
 * needs no password for a locked site and makes no requests. It reads what a
 * browser would request up front: href, src, srcset and poster on HTML tags,
 * and url() and @import in CSS, including <style> blocks and style="". A URL
 * assembled by JavaScript at runtime is invisible to it, as are SVG files'
 * own references and resolution against a <base> element.
 *
 * HTML is read tag by tag, not as text: an agent-written report full of code
 * samples must not come back as a list of "missing" files that were only ever
 * text. So comments and the bodies of script, template and textarea are
 * dropped first, and only attributes of real tags count.
 */

export type CheckFile = { path: string; contentType: string; text?: string };
export type MissingReference = { file: string; reference: string; resolved: string };

// Any scheme (https:, data:, mailto:, javascript:, ...) or protocol-relative
// URL points somewhere this site does not serve.
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const BASE = 'https://site.invalid/';

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const OPAQUE_BODY = /<(template|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const SCRIPT = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;
const STYLE_OR_TAG = /<style\b[^>]*>([\s\S]*?)<\/style\s*>|<([a-z][a-z0-9-]*)(\s[^>]*)?>/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const CSS_REFERENCE =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;

export function findMissingReferences(files: CheckFile[]): MissingReference[] {
  const present = new Set(files.map(f => f.path));
  const missing: MissingReference[] = [];
  const report = (file: string, reference: string) => {
    const resolved = resolve(file, reference);
    if (resolved === undefined) return;
    if (!candidatesFor(resolved).some(candidate => present.has(candidate))) {
      missing.push({ file, reference, resolved: display(resolved) });
    }
  };

  for (const file of files) {
    if (file.text === undefined) continue;
    if (file.contentType.startsWith('text/html')) {
      for (const reference of htmlReferences(file.text)) report(file.path, reference);
    } else if (file.contentType.startsWith('text/css')) {
      for (const reference of cssReferences(file.text)) report(file.path, reference);
    }
  }
  return missing;
}

function htmlReferences(text: string): string[] {
  const markup = text
    .replace(HTML_COMMENT, '')
    .replace(OPAQUE_BODY, '')
    .replace(SCRIPT, (_whole, attributes: string) => `<script${attributes}>`);
  const out: string[] = [];
  for (const match of markup.matchAll(STYLE_OR_TAG)) {
    if (match[1] !== undefined) {
      out.push(...cssReferences(match[1]));
      continue;
    }
    const tag = match[2]!.toLowerCase();
    // A <base> changes how other URLs resolve; it is not a file to have.
    if (tag === 'base') continue;
    for (const attribute of (match[3] ?? '').matchAll(ATTRIBUTE)) {
      const name = attribute[1]!.toLowerCase();
      const raw = attribute[2] ?? attribute[3] ?? attribute[4];
      if (raw === undefined) continue;
      const value = decodeEntities(raw).trim();
      if (name === 'href' || name === 'src' || name === 'poster') out.push(value);
      else if (name === 'srcset') out.push(...value.split(',').map(c => c.trim().split(/\s+/)[0]!).filter(Boolean));
      else if (name === 'style') out.push(...cssReferences(value));
    }
  }
  return out;
}

function cssReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(CSS_COMMENT, '').matchAll(CSS_REFERENCE)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim());
  }
  return out;
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

/** A resolved path as the agent's own file would be named. */
function display(pathname: string): string {
  const bare = pathname.replace(/^\//, '');
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
