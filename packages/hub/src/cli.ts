#!/usr/bin/env node
/**
 * tailhub CLI — start the hub, manage tokens, register app tokens.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { sha256Hex } from './auth.js';
import {
  adminTokenPath,
  loadConfigFromEnv,
  resolveAdminToken,
  type HubConfig,
} from './config.js';
import { createHub } from './http.js';
import { isValidAppName } from './ids.js';
import { loadManifest, saveManifest } from './manifests.js';
import { TAILHUB_VERSION } from './version.js';

const HELP = `tailhub v${TAILHUB_VERSION} — private apps for your tailnet

Usage:
  tailhub [start]            Start the hub (default command)
  tailhub token              Show the admin token and where it comes from
  tailhub token rotate       Generate and persist a new admin token
  tailhub apptoken <app>     Generate a scoped token for a registered app
  tailhub --version          Print the version

Environment:
  TAILHUB_PORT                     Listen port          (default 4747)
  TAILHUB_HOST                     Bind address         (default 127.0.0.1)
  TAILHUB_DATA_DIR                 Storage directory    (default ~/.tailhub)
  TAILHUB_TOKEN                    Admin token override (default: token file)
  TAILHUB_MAX_ARTIFACT_BYTES       Default artifact size limit (10 MiB)
  TAILHUB_HISTORY_KEEP             Default revisions retained  (20)
  TAILHUB_CORS_ORIGINS             "*" or comma-separated origins
  TAILHUB_TRUST_TAILSCALE_HEADERS  "1" to record Tailscale Serve identity
  TAILHUB_QUIET                    "1" to disable request logging

Expose over your tailnet (HTTPS + MagicDNS, run once):
  tailscale serve --bg --https=443 http://127.0.0.1:4747
`;

async function start(config: HubConfig): Promise<void> {
  const { token, source } = await resolveAdminToken(config);
  const hub = createHub({
    dataDir: config.dataDir,
    adminToken: token,
    maxRequestBytes: config.maxRequestBytes,
    defaultMaxArtifactBytes: config.defaultMaxArtifactBytes,
    defaultHistoryKeep: config.defaultHistoryKeep,
    corsOrigins: config.corsOrigins,
    trustTailscaleHeaders: config.trustTailscaleHeaders,
    quiet: config.quiet,
  });
  const { port, host } = await hub.listen(config.port, config.host);

  console.log(`tailhub v${TAILHUB_VERSION}`);
  console.log(`  Listening: http://${host}:${port}`);
  console.log(`  Console:   http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
  console.log(`  Data dir:  ${config.dataDir}`);
  if (source === 'generated') {
    console.log('  Admin token (generated now, shown once — also saved to the token file):');
    console.log(`    ${token}`);
    console.log(`    File: ${adminTokenPath(config.dataDir)}`);
  } else if (source === 'file') {
    console.log(`  Admin token: loaded from ${adminTokenPath(config.dataDir)}`);
  } else {
    console.log('  Admin token: from TAILHUB_TOKEN environment variable');
  }
  console.log('  Expose over Tailscale (once, from an admin shell):');
  console.log(`    tailscale serve --bg --https=443 http://127.0.0.1:${port}`);

  const shutdown = () => {
    hub
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function showToken(config: HubConfig): Promise<void> {
  const { token, source } = await resolveAdminToken(config);
  console.log(token);
  if (source === 'env') console.error('(from TAILHUB_TOKEN)');
  else console.error(`(from ${adminTokenPath(config.dataDir)})`);
}

async function rotateToken(config: HubConfig): Promise<void> {
  if (config.adminToken) {
    console.error(
      'TAILHUB_TOKEN is set in the environment and overrides the token file — unset it or rotate it there.'
    );
    process.exitCode = 1;
    return;
  }
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(adminTokenPath(config.dataDir), `${token}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  console.log(token);
  console.error('New admin token saved. Restart the hub and update every client that used the old one.');
}

async function appToken(config: HubConfig, app: string | undefined): Promise<void> {
  if (!app || !isValidAppName(app)) {
    console.error('Usage: tailhub apptoken <app>   (lowercase a-z, 0-9, hyphen)');
    process.exitCode = 1;
    return;
  }
  const manifest = await loadManifest(config.dataDir, app);
  if (!manifest) {
    console.error(
      `App "${app}" is not registered on this hub. Register a manifest first (console, or PUT /v1/apps/${app}).`
    );
    process.exitCode = 1;
    return;
  }
  const token = randomBytes(32).toString('hex');
  manifest.tokens = [...(manifest.tokens ?? []), sha256Hex(token)];
  await saveManifest(config.dataDir, manifest);
  console.log(token);
  console.error(
    `App token for "${app}" (shown once — only its SHA-256 digest is stored). ` +
      'Paste it into the app\'s sync settings on each device.'
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';
  const config = loadConfigFromEnv();
  switch (command) {
    case 'start':
      return start(config);
    case 'token':
      return args[1] === 'rotate' ? rotateToken(config) : showToken(config);
    case 'apptoken':
      return appToken(config, args[1]);
    case '--version':
    case '-v':
      console.log(TAILHUB_VERSION);
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
