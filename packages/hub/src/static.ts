/**
 * Minimal, path-safe static file serving so the hub can host the private
 * apps themselves (manifest `www: true`) plus the built-in console and SDK.
 * One `tailscale serve` command then exposes app, data API, and console on a
 * single HTTPS origin.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export async function serveFile(
  res: ServerResponse,
  filePath: string,
  contentType?: string
): Promise<boolean> {
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': contentType ?? contentTypeFor(filePath),
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
  return true;
}

/**
 * Serve a request path from inside rootDir, refusing anything that could
 * escape it. Directory requests get index.html; extension-less misses fall
 * back to the app's index.html (client-side routing).
 */
export async function serveStaticTree(
  res: ServerResponse,
  rootDir: string,
  relPath: string
): Promise<boolean> {
  const segments = relPath.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment.startsWith('.')) return false;
    if (segment.includes('\\') || /[:<>|*?"]/.test(segment)) return false;
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return false;

  let filePath = target;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    if (path.extname(filePath)) return false;
    filePath = path.join(root, 'index.html');
  }
  return serveFile(res, filePath);
}
