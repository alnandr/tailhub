// Copies non-TypeScript assets into dist/: the admin console page and the
// browser SDK (built by @tailhub/client) that the hub serves at /sdk/*.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(pkgDir, 'dist');
const clientDist = path.resolve(pkgDir, '..', 'client', 'dist');

copyFileSync(path.join(pkgDir, 'src', 'console.html'), path.join(dist, 'console.html'));

if (!existsSync(path.join(clientDist, 'index.js'))) {
  console.error(
    'postbuild: @tailhub/client is not built. Run the root "npm run build" so the client builds first.'
  );
  process.exit(1);
}
const sdkDir = path.join(dist, 'sdk');
mkdirSync(sdkDir, { recursive: true });
copyFileSync(path.join(clientDist, 'index.js'), path.join(sdkDir, 'tailhub-client.js'));
copyFileSync(path.join(clientDist, 'index.js'), path.join(sdkDir, 'index.js'));
copyFileSync(path.join(clientDist, 'crypto.js'), path.join(sdkDir, 'crypto.js'));
copyFileSync(path.join(clientDist, 'browser.js'), path.join(sdkDir, 'browser.js'));
console.log('postbuild: console + SDK assets copied into dist/');
