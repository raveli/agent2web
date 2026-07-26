import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type AppBundle } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/auth/passwords.js';
import { openDb, type Db } from '../src/db.js';

export const ADMIN_PASSWORD = 'correct-horse-battery';
export const API_TOKEN = 'test-static-api-token-0123456789abcdef';

export type Harness = {
  config: Config;
  db: Db;
  bundle: AppBundle;
  server: Server;
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
};

/** Boots the whole app on an ephemeral port against a throwaway data directory. */
export async function startHarness(
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'a2w-test-'));
  // The public URL has to be known before the app is built, so reserve a port first.
  const actualPort = await freePort();

  const config = loadConfig(
    {
      A2W_PUBLIC_URL: `http://127.0.0.1:${actualPort}`,
      A2W_SECRET: 'test-secret-that-is-long-enough-0123456789',
      A2W_ADMIN_PASSWORD_HASH: hashPassword(ADMIN_PASSWORD),
      A2W_API_TOKEN: API_TOKEN,
      A2W_DATA_DIR: dataDir,
      A2W_TRUST_PROXY: 'false',
      ...env,
    } as NodeJS.ProcessEnv,
  );

  const db = openDb(join(dataDir, 'agent2web.db'));
  const bundle = createApp(config, db);
  const server = await new Promise<Server>(resolve => {
    const s = bundle.app.listen(actualPort, '127.0.0.1', () => resolve(s));
  });

  return {
    config,
    db,
    bundle,
    server,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    close: async () => {
      bundle.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** Calls an MCP tool over the streamable HTTP endpoint with a bearer token. */
export async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; result?: any; error?: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    return { status: res.status, error: await safeJson(res), headers: res.headers };
  }
  const payload = await parseMcpResponse(res);
  return { status: res.status, result: payload?.result, error: payload?.error, headers: res.headers };
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
  if (!res.ok) return { status: res.status, error: await safeJson(res) };
  return { status: res.status, ...(await parseMcpResponse(res)) };
}

/** The transport may answer with JSON or a single SSE event; accept both. */
async function parseMcpResponse(res: globalThis.Response): Promise<any> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
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
 * tests need to exercise verbatim.
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
