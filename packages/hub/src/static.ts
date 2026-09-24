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

/** Sent with every static response (console, SDK, hosted app files). */
const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * For pages that must never be framed by another origin — the admin console,
 * where the admin token is typed. Hosted apps are left embeddable.
 */
export const NO_FRAMING_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

export type ServeFileOptions = {
  contentType?: string;
  headers?: Record<string, string>;
};

/** Node drops the body for HEAD requests, so this also answers HEAD. */
export async function serveFile(
  res: ServerResponse,
  filePath: string,
  options: ServeFileOptions = {}
): Promise<boolean> {
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return false;
  }
  res.writeHead(200, {
    ...STATIC_SECURITY_HEADERS,
    ...options.headers,
    'Content-Type': options.contentType ?? contentTypeFor(filePath),
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
  // Lexical containment is not enough: stat/readFile follow symlinks, so a
  // link dropped under www/ could serve the admin token file. realpath both
  // sides and allow only files that stay inside the (possibly itself linked)
  // www root. In-tree symlinks remain readable.
  if (!(await staysInside(root, filePath))) return false;
  return serveFile(res, filePath);
}

async function staysInside(rootDir: string, filePath: string): Promise<boolean> {
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fs.realpath(rootDir);
    realFile = await fs.realpath(filePath);
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, realFile);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
