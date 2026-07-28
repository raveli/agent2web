import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import { Sql } from '../src/d1.js';

export const ADMIN_PASSWORD = 'correct-horse-battery';
export const API_TOKEN = 'test-static-api-token-0123456789abcdef';

export type Harness = {
  /** Async SQL over the local D1 binding, for setting up and inspecting state. */
  db: Sql;
  mf: Miniflare;
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
};

/**
 * Boots the real Worker bundle in Miniflare on an ephemeral port, with local D1
 * and R2 bindings.
 *
 * Miniflare serves over actual HTTP, so the suite talks to the app exactly as a
 * client would — no in-process shortcuts, and the same code path that ships.
 */
export async function startHarness(
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  // The public URL must be known before the Worker boots, since it is the OAuth
  // issuer, so reserve the port first.
  const port = await freePort();

  const mf = new Miniflare({
    scriptPath: 'build/worker.bundle.js',
    modules: true,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['BLOBS'],
    port,
    bindings: bindings(port, env),
  });
  await mf.ready;

  return {
    mf,
    db: new Sql((await mf.getD1Database('DB')) as never),
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => mf.dispose(),
  };
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
}

/**
 * Base bindings with the test's overrides applied.
 *
 * Passing `undefined` for a key *unsets* it rather than being ignored, so a test
 * can exercise a deployment where the variable was never configured.
 */
function bindings(
  port: number,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    A2W_PUBLIC_URL: `http://127.0.0.1:${port}`,
    A2W_SECRET: 'test-secret-that-is-long-enough-0123456789',
    A2W_ADMIN_PASSWORD: ADMIN_PASSWORD,
    A2W_API_TOKEN: API_TOKEN,
    ...env,
  };
  return Object.fromEntries(
    Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/**
 * Every R2 key, optionally under a prefix.
 *
 * Cleanup bugs are invisible from the outside: a pruned version stops being
 * listed and a deleted site starts 404ing whether or not its bytes were
 * actually removed. The bucket is the only place that shows the difference.
 */
export async function blobKeys(h: Harness, prefix?: string): Promise<string[]> {
  const bucket = await h.mf.getR2Bucket('BLOBS');
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o: { key: string }) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/** Calls an MCP tool over the streamable HTTP endpoint with a bearer token. */
export async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; result?: any; error?: any; headers: Headers }> {
  return mcpRequest(baseUrl, token, 'tools/call', { name, arguments: args }).then(r => ({
    status: r.status,
    result: r.result,
    error: r.error,
    headers: r.headers ?? new Headers(),
  }));
}

export async function mcpRequest(
  baseUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) return { status: res.status, error: await safeJson(res), headers: res.headers };
  return { status: res.status, headers: res.headers, ...(await parseMcpResponse(res)) };
}

/** The transport may answer with JSON or a single SSE event; accept both. */
async function parseMcpResponse(res: globalThis.Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
    }
    return undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

async function safeJson(res: globalThis.Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export function structured(result: any): any {
  return result?.structuredContent;
}

export function textOf(result: any): string {
  return (result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

export function cookieValue(setCookie: string[] | string | null, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const entry of list) {
    const [pair] = entry.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1));
  }
  return undefined;
}

/** Reads a JSON body as `any` so tests can assert on fields directly. */
export async function json(res: globalThis.Response): Promise<any> {
  return res.json();
}

export type RawResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/**
 * Sends a request with node:http rather than fetch, because fetch refuses to set
 * a custom Host header and normalises `..` out of paths — both of which these
 * tests need verbatim. Miniflare builds the Worker's request URL from the Host
 * header, so subdomain routing is exercised for real.
 */
export async function rawRequest(
  port: number,
  path: string,
  options: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { ...(options.host ? { host: options.host } : {}), ...(options.headers ?? {}) },
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
