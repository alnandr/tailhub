// Verifies every place the version number lives agrees, so a release can't
// ship with a stale constant. Optionally pass the expected version (the
// release workflow passes the tag) to pin them all to it.
//
//   node scripts/check-versions.mjs [expected]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const pkgVersion = (rel) => JSON.parse(read(rel)).version;

const sources = {
  'package.json': pkgVersion('package.json'),
  'packages/hub/package.json': pkgVersion('packages/hub/package.json'),
  'packages/client/package.json': pkgVersion('packages/client/package.json'),
  'packages/hub/src/version.ts': read('packages/hub/src/version.ts').match(
    /TAILHUB_VERSION = '([^']+)'/
  )?.[1],
  'packages/client/src/index.ts': read('packages/client/src/index.ts').match(
    /CLIENT_VERSION = '([^']+)'/
  )?.[1],
};

const expected = process.argv[2]?.replace(/^v/, '') ?? sources['package.json'];
const mismatched = Object.entries(sources).filter(([, v]) => v !== expected);

if (mismatched.length > 0) {
  console.error(`Version mismatch (expected ${expected}):`);
  for (const [file, version] of mismatched) {
    console.error(`  ${file}: ${version ?? 'NOT FOUND'}`);
  }
  console.error('Run "npm run set-version <version>" to fix.');
  process.exit(1);
}
console.log(`Versions consistent: ${expected}`);
