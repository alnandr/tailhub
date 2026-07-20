// Mirror of postbuild.mjs for the test build: compiled sources live under
// dist-test/src/, so assets resolved relative to import.meta.url go there too.
// The SDK copy is best-effort — HTTP tests only require the console asset.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outSrc = path.join(pkgDir, 'dist-test', 'src');
const clientDist = path.resolve(pkgDir, '..', 'client', 'dist');

mkdirSync(outSrc, { recursive: true });
copyFileSync(path.join(pkgDir, 'src', 'console.html'), path.join(outSrc, 'console.html'));

if (existsSync(path.join(clientDist, 'index.js'))) {
  const sdkDir = path.join(outSrc, 'sdk');
  mkdirSync(sdkDir, { recursive: true });
  copyFileSync(path.join(clientDist, 'index.js'), path.join(sdkDir, 'tailhub-client.js'));
  copyFileSync(path.join(clientDist, 'index.js'), path.join(sdkDir, 'index.js'));
  copyFileSync(path.join(clientDist, 'crypto.js'), path.join(sdkDir, 'crypto.js'));
  copyFileSync(path.join(clientDist, 'browser.js'), path.join(sdkDir, 'browser.js'));
}
