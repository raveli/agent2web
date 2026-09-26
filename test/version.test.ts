import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { CHANGES, VERSION } from '../src/core/version.js';
import { API_TOKEN, callTool, mcpRequest, startHarness, structured, type Harness } from './helpers.js';

// Backlog #69 (agents act on stale knowledge) and #14 (one version string).

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

test('the version exists once: package.json, the changelog and every surface agree', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(CHANGES[0]!.version, VERSION, 'add a CHANGES entry when you bump the version');

  const health = (await (await fetch(`${h.baseUrl}/healthz`)).json()) as { version: string };
  assert.equal(health.version, VERSION);

  const init = await mcpRequest(h.baseUrl, API_TOKEN, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.serverInfo.version, VERSION);
});

test('the MCP instructions carry the latest changes and say to trust them over memory', async () => {
  const init = await mcpRequest(h.baseUrl, API_TOKEN, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  const text: string = init.result.instructions;
  assert.match(text, new RegExp(`Server version ${VERSION.replace(/\./g, '\\.')}`));
  for (const note of CHANGES[0]!.notes) assert.ok(text.includes(note), note);
  assert.match(text, /trust the descriptions over your memory/);
});

test('site_get reports the server version', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { slug: 'v', html: '<p>v</p>' });
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_get', { slug: 'v' });
  assert.equal(structured(res.result).server_version, VERSION);
});
