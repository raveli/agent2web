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
 * Both readers are single forward passes built on indexOf, never regexes that
 * can rescan: files run to 5 MB, and an unterminated `<` or `url(` used to cost
 * quadratic time (a megabyte of "a<b" took minutes). They read the way a
 * browser does, in document order: a comment, a raw-text element (script,
 * style, template, textarea) or a tag, whichever comes first, and a quoted
 * attribute value may contain ">". So an agent-written report full of code
 * samples does not come back as a list of "missing" files that were only text.
 */

export type CheckFile = { path: string; contentType: string; text?: string };
export type MissingReference = { file: string; reference: string; resolved: string };

// Any scheme (https:, data:, mailto:, javascript:, ...) or protocol-relative
// URL points somewhere this site does not serve.
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const BASE = 'https://site.invalid/';
const RAW_TEXT = new Set(['script', 'style', 'template', 'textarea']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster']);

export function findMissingReferences(files: CheckFile[]): MissingReference[] {
  const present = new Set(files.map(f => f.path));
  const missing: MissingReference[] = [];
  for (const file of files) {
    if (file.text === undefined) continue;
    const references = file.contentType.startsWith('text/html')
      ? htmlReferences(file.text)
      : file.contentType.startsWith('text/css')
        ? cssReferences(file.text)
        : [];
    for (const reference of references) {
      const resolved = resolve(file.path, reference);
      if (resolved === undefined) continue;
      if (!candidatesFor(resolved).some(candidate => present.has(candidate))) {
        missing.push({ file: file.path, reference, resolved: display(resolved) });
      }
    }
  }
  return missing;
}

// ------------------------------------------------------------------- HTML

function htmlReferences(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const nameEnd = tagNameEnd(text, lt + 1);
    if (nameEnd === lt + 1) {
      i = lt + 1; // "a < b", "</p>", "<!doctype>": not an opening tag
      continue;
    }
    const name = text.slice(lt + 1, nameEnd).toLowerCase();
    const end = tagEnd(text, nameEnd);
    if (end === -1) break; // an unfinished tag at the end of the file requests nothing
    if (name !== 'base') collectAttributes(text.slice(nameEnd, end), out);
    i = end + 1;

    if (RAW_TEXT.has(name)) {
      // Everything up to the closing tag is text, not markup, even if the
      // opening tag was written "<style/>". Unclosed, it runs to the end.
      const close = findClosingTag(text, name, i);
      if (name === 'style') out.push(...cssReferences(text.slice(i, close === -1 ? text.length : close)));
      if (close === -1) break;
      const closeEnd = text.indexOf('>', close);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
    }
  }
  return out;
}

function tagNameEnd(text: string, start: number): number {
  let i = start;
  if (!isAsciiLetter(text.charCodeAt(i))) return start;
  while (i < text.length && isNameChar(text.charCodeAt(i))) i++;
  return i;
}

/** Index of the ">" ending the tag, skipping quoted attribute values; -1 if the file ends first. */
function tagEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '>') return i;
    if (c === '=') {
      let j = i + 1;
      while (j < text.length && isSpace(text.charCodeAt(j))) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, j + 1);
        if (close === -1) return -1;
        i = close + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return -1;
}

function findClosingTag(text: string, name: string, from: number): number {
  const needle = `</${name}`;
  let i = from;
  for (;;) {
    const at = text.indexOf('</', i);
    if (at === -1) return -1;
    if (text.slice(at, at + needle.length).toLowerCase() === needle) {
      const after = text.charCodeAt(at + needle.length);
      if (Number.isNaN(after) || !isNameChar(after)) return at;
    }
    i = at + 2;
  }
}

/** Reads name=value pairs from the inside of one tag, quotes respected. */
function collectAttributes(inside: string, out: string[]): void {
  let i = 0;
  const n = inside.length;
  while (i < n) {
    while (i < n && (isSpace(inside.charCodeAt(i)) || inside[i] === '/')) i++;
    const nameStart = i;
    while (i < n && !isSpace(inside.charCodeAt(i)) && inside[i] !== '=' && inside[i] !== '/') i++;
    const name = inside.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isSpace(inside.charCodeAt(j))) j++;
    if (inside[j] !== '=') {
      i = j;
      continue; // a bare attribute such as "defer"
    }
    j++;
    while (j < n && isSpace(inside.charCodeAt(j))) j++;
    let value: string;
    const q = inside[j];
    if (q === '"' || q === "'") {
      const close = inside.indexOf(q, j + 1);
      const stop = close === -1 ? n : close;
      value = inside.slice(j + 1, stop);
      i = stop + 1;
    } else {
      const start = j;
      while (j < n && !isSpace(inside.charCodeAt(j))) j++;
      value = inside.slice(start, j);
      i = j;
    }
    value = decodeEntities(value).trim();
    if (URL_ATTRIBUTES.has(name)) out.push(value);
    else if (name === 'srcset') out.push(...srcsetUrls(value));
    else if (name === 'style') out.push(...cssReferences(value));
  }
}

/** The URLs of a srcset, per the HTML rules: a URL is a run of non-space, so a data: URI's comma stays in it. */
function srcsetUrls(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && (isSpace(value.charCodeAt(i)) || value[i] === ',')) i++;
    const start = i;
    while (i < n && !isSpace(value.charCodeAt(i))) i++;
    let url = value.slice(start, i);
    const endsCandidate = url.endsWith(',');
    url = url.replace(/,+$/, '');
    if (url) out.push(url);
    if (endsCandidate) continue;
    // Descriptors run to the next comma outside parentheses.
    let depth = 0;
    while (i < n) {
      const c = value[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) break;
      i++;
    }
  }
  return out;
}

// -------------------------------------------------------------------- CSS

function cssReferences(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
    } else if (c === '"' || c === "'") {
      // A string that is not a url() or @import argument: skip it whole, so
      // "/*" or "url(" inside it means nothing.
      const end = text.indexOf(c, i + 1);
      if (end === -1) break;
      i = end + 1;
    } else if ((c === 'u' || c === 'U') && text.slice(i, i + 4).toLowerCase() === 'url(') {
      const read = readCssArgument(text, i + 4, ')');
      if (read.value !== undefined) out.push(read.value);
      i = read.next;
    } else if (c === '@' && text.slice(i, i + 7).toLowerCase() === '@import') {
      let j = i + 7;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, j + 1);
        if (end === -1) break;
        out.push(text.slice(j + 1, end).trim());
        i = end + 1;
      } else {
        i = j; // @import url(...) is read by the url( branch
      }
    } else {
      i++;
    }
  }
  return out;
}

/** Reads url(...)'s argument, quoted or not; `next` is where scanning resumes. */
function readCssArgument(text: string, start: number, close: string): { value?: string; next: number } {
  let j = start;
  while (j < text.length && isSpace(text.charCodeAt(j))) j++;
  const q = text[j];
  if (q === '"' || q === "'") {
    const end = text.indexOf(q, j + 1);
    if (end === -1) return { next: text.length };
    const after = text.indexOf(close, end + 1);
    return { value: text.slice(j + 1, end).trim(), next: after === -1 ? text.length : after + 1 };
  }
  const end = text.indexOf(close, j);
  if (end === -1) return { next: text.length };
  return { value: text.slice(j, end).trim(), next: end + 1 };
}

// --------------------------------------------------------------- resolving

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
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isNameChar(c: number): boolean {
  return isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58;
}
