import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db.js';
import { siteUrls } from './urls.js';

function main(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      console.error('\nSee .env.example, or run `npm run gen-secrets` to generate the required secrets.');
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  for (const warning of config.warnings) console.warn(`[config] ${warning}`);

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'agent2web.db'));
  const { app, stop } = createApp(config, db);

  const server = app.listen(config.port, config.bind, () => {
    console.log(`[agent2web] listening on ${config.bind}:${config.port}`);
    console.log(`[agent2web] public URL   ${config.publicUrl}`);
    console.log(`[agent2web] MCP endpoint ${config.mcpUrl}`);
    // Built through siteUrls so the banner cannot drift from the real URLs.
    const example = siteUrls(config, { slug: '<slug>', custom_domain: null });
    console.log(
      `[agent2web] sites at     ${example.path}` +
        (example.subdomain ? ` and ${example.subdomain}` : ''),
    );
    if (!config.apiToken) console.log('[agent2web] static token auth disabled (A2W_API_TOKEN unset)');
  });

  const shutdown = (signal: string) => {
    console.log(`[agent2web] ${signal} received, shutting down`);
    stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not wait forever for lingering keep-alive connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
