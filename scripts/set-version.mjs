// Sets the version everywhere it lives, in one command:
//
//   node scripts/set-version.mjs 0.2.0
//
// Then: npm install (refresh the lockfile), update CHANGELOG.md, commit,
// and tag v0.2.0 to trigger the release workflow.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver>   e.g. 0.2.0');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const editPackageJson = (rel) => {
  const file = path.join(root, rel);
  const raw = readFileSync(file, 'utf8');
  const updated = raw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  writeFileSync(file, updated);
  console.log(`  ${rel}`);
};

const editConstant = (rel, name) => {
  const file = path.join(root, rel);
  const raw = readFileSync(file, 'utf8');
  const pattern = new RegExp(`(${name} = ')[^']+(')`);
  if (!pattern.test(raw)) {
    console.error(`${name} not found in ${rel}`);
    process.exit(1);
  }
  writeFileSync(file, raw.replace(pattern, `$1${version}$2`));
  console.log(`  ${rel}`);
};

console.log(`Setting version ${version}:`);
editPackageJson('package.json');
editPackageJson('packages/hub/package.json');
editPackageJson('packages/client/package.json');
editConstant('packages/hub/src/version.ts', 'TAILHUB_VERSION');
editConstant('packages/client/src/index.ts', 'CLIENT_VERSION');
console.log('Done. Now run "npm install" to refresh package-lock.json, and update CHANGELOG.md.');
