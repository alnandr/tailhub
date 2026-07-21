// Runs node's built-in test runner on every *.test.js under the given
// directory, passing explicit file paths. Glob and directory arguments to
// `node --test` behave differently across Node versions (20 lacks glob
// expansion, newer versions changed directory handling) — explicit files
// work identically everywhere.
//
//   node ../../scripts/run-node-tests.mjs dist-test/test

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node run-node-tests.mjs <directory>');
  process.exit(1);
}

const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(dir, f))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.js files found under ${dir} — is the test build missing?`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
