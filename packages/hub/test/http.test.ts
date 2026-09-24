import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sha256Hex } from '../src/auth.js';
import { createHub, type Hub } from '../src/http.js';

const ADMIN = 'test-admin-token-0123456789abcdef';
const APP_TOKEN = 'notes-app-token-fedcba9876543210';

let dataDir: string;
let hub: Hub;
let base: string;

function headers(token?: string, extra: Record<string, string> = {}) {
  const h: Record<string, string> = { ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function jfetch(
  pathname: string,
  init: RequestInit & { token?: string } = {}
): Promise<{ status: number; body: any; etag: string | null }> {
  const { token, ...rest } = init;
  const res = await fetch(`${base}${pathname}`, {
    ...rest,
    headers: {
      ...headers(token),
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...((rest.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, etag: res.headers.get('ETag') };
}

/** Raw request that bypasses fetch/URL dot-segment normalization. */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      { host: url.hostname, port: url.port, path: rawPath, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailhub-http-'));
  hub = createHub({
    dataDir,
    adminToken: ADMIN,
    quiet: true,
    defaultHistoryKeep: 5,
  });
  const { port } = await hub.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await hub.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('health + auth', () => {
  it('serves /health without auth', async () => {
    const { status, body } = await jfetch('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.name, 'tailhub');
  });

  it('rejects missing and wrong tokens', async () => {
    assert.equal((await jfetch('/v1/hub')).status, 401);
    assert.equal((await jfetch('/v1/hub', { token: 'wrong' })).status, 401);
  });

  it('serves the hub overview to the admin token', async () => {
    const { status, body } = await jfetch('/v1/hub', { token: ADMIN });
    assert.equal(status, 200);
    assert.equal(body.storage, 'local-disk');
  });

  it('serves the console at /', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /Tailhub console/);
  });
});

describe('app registration', () => {
  it('404s artifact routes for unregistered apps', async () => {
    const { status } = await jfetch('/v1/apps/notes/notes', { token: ADMIN });
    assert.equal(status, 404);
  });

  it('rejects invalid manifests', async () => {
    const bad = await jfetch('/v1/apps/notes', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({ app: 'notes', collections: { bundle: {} } }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /reserved/);
  });

  it('registers a manifest with app tokens and www', async () => {
    const manifest = {
      app: 'notes',
      name: 'Tailnotes',
      collections: {
        notes: { maxBytes: 4096, historyKeep: 3, encryption: 'optional' },
        sealed: { encryption: 'required' },
        plain: { encryption: 'none' },
      },
      tokens: [sha256Hex(APP_TOKEN)],
      www: true,
    };
    const { status, body } = await jfetch('/v1/apps/notes', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify(manifest),
    });
    assert.equal(status, 200);
    assert.equal(body.app.tokenCount, 1);
    // Token digests never come back.
    assert.equal(body.app.tokens, undefined);
  });

  it('registers a launchUrl for apps the hub does not host', async () => {
    const bad = await jfetch('/v1/apps/bottomline', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'bottomline',
        collections: { portfolios: {} },
        launchUrl: 'not-a-url',
      }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /launchUrl/);

    const ok = await jfetch('/v1/apps/bottomline', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'bottomline',
        collections: { portfolios: {} },
        launchUrl: 'https://bottomline.example.ts.net/',
      }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.app.www, false);
    assert.equal(ok.body.app.launchUrl, 'https://bottomline.example.ts.net/');

    // Scheme-relative typos ("https:host") parse as absolute server-side but
    // would resolve against the page origin in a browser — stored normalized.
    const typo = await jfetch('/v1/apps/bottomline', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'bottomline',
        collections: { portfolios: {} },
        launchUrl: 'https:bottomline.example.ts.net',
      }),
    });
    assert.equal(typo.status, 200);
    assert.equal(typo.body.app.launchUrl, 'https://bottomline.example.ts.net/');
  });

  it('omits launchUrl from the public view when it is not operative', async () => {
    // Services are never launchable.
    const svc = await jfetch('/v1/apps/svc-elsewhere', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'svc-elsewhere',
        kind: 'service',
        collections: { data: {} },
        launchUrl: 'https://svc.example.ts.net/',
      }),
    });
    assert.equal(svc.status, 200);
    assert.equal(svc.body.app.launchUrl, undefined);

    // Hub hosting takes precedence over launchUrl.
    const hosted = await jfetch('/v1/apps/hosted-elsewhere', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'hosted-elsewhere',
        www: true,
        collections: { data: {} },
        launchUrl: 'https://hosted.example.ts.net/',
      }),
    });
    assert.equal(hosted.status, 200);
    assert.equal(hosted.body.app.launchUrl, undefined);
  });

  it('classifies apps vs background services via kind', async () => {
    const bad = await jfetch('/v1/apps/svc', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({ app: 'svc', kind: 'daemon', collections: { data: {} } }),
    });
    assert.equal(bad.status, 400);

    const ok = await jfetch('/v1/apps/svc', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({ app: 'svc', kind: 'service', www: true, collections: { data: {} } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.app.kind, 'service');

    // Unset kind defaults to "app".
    const notes = await jfetch('/v1/apps/notes', { token: ADMIN });
    assert.equal(notes.body.kind, 'app');
  });

  it('scopes app tokens to their app', async () => {
    // App token works on its own app's routes...
    const ok = await jfetch('/v1/apps/notes', { token: APP_TOKEN });
    assert.equal(ok.status, 200);
    // ...but not on admin routes,
    assert.equal((await jfetch('/v1/apps', { token: APP_TOKEN })).status, 401);
    // and cannot register manifests.
    const put = await jfetch('/v1/apps/notes', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ app: 'notes', collections: { notes: {} } }),
    });
    assert.equal(put.status, 403);
  });

  it('keeps token digests when an update omits them and drops them on tokens: []', async () => {
    const collections = {
      notes: { maxBytes: 4096, historyKeep: 3, encryption: 'optional' },
      sealed: { encryption: 'required' },
      plain: { encryption: 'none' },
    };
    const updated = await jfetch('/v1/apps/notes', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'notes',
        name: 'Tailnotes renamed',
        collections,
        www: true,
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.app.name, 'Tailnotes renamed');
    assert.equal(updated.body.app.tokenCount, 1);
    assert.equal(updated.body.app.tokens, undefined);
    assert.equal((await jfetch('/v1/apps/notes', { token: APP_TOKEN })).status, 200);

    const revoked = await jfetch('/v1/apps/notes', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({ app: 'notes', name: 'Tailnotes', collections, tokens: [], www: true }),
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.app.tokenCount, 0);
    assert.equal((await jfetch('/v1/apps/notes', { token: APP_TOKEN })).status, 401);

    const restored = await jfetch('/v1/apps/notes', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'notes',
        name: 'Tailnotes',
        collections,
        tokens: [sha256Hex(APP_TOKEN)],
        www: true,
      }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.app.tokenCount, 1);
    assert.equal((await jfetch('/v1/apps/notes', { token: APP_TOKEN })).status, 200);
  });
});

describe('app token revocation', () => {
  it('revokes all app tokens for admins only, keeping the rest of the manifest', async () => {
    const extraToken = 'revocable-app-token-00112233445566';
    const registered = await jfetch('/v1/apps/revocable', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({
        app: 'revocable',
        name: 'Revocable',
        collections: { tokens: {} },
        tokens: [sha256Hex(extraToken)],
        www: true,
        launchUrl: 'https://kept.example.ts.net/',
      }),
    });
    assert.equal(registered.status, 200);

    // A collection named "tokens" is still listable.
    const listed = await jfetch('/v1/apps/revocable/tokens', { token: extraToken });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.artifacts, []);

    const byApp = await jfetch('/v1/apps/revocable/tokens', { method: 'DELETE', token: extraToken });
    assert.equal(byApp.status, 403);

    const revoked = await jfetch('/v1/apps/revocable/tokens', { method: 'DELETE', token: ADMIN });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, 1);
    assert.equal(revoked.body.app.tokenCount, 0);
    assert.equal((await jfetch('/v1/apps/revocable', { token: extraToken })).status, 401);

    // The hidden launchUrl survives: it becomes operative once www is off.
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'apps', 'revocable.json'), 'utf8'));
    assert.equal(stored.launchUrl, 'https://kept.example.ts.net/');
    assert.equal(stored.name, 'Revocable');
    assert.deepEqual(stored.tokens, []);
  });
});

describe('artifact push/pull', () => {
  it('pushes, pulls, and honors ETag/304', async () => {
    const push = await jfetch('/v1/apps/notes/notes/n1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ title: 'First', payload: { body: 'hello' }, baseRevision: 0 }),
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.created, true);
    assert.equal(push.body.artifact.revision, 1);
    assert.ok(push.etag);

    const pull = await jfetch('/v1/apps/notes/notes/n1', { token: APP_TOKEN });
    assert.equal(pull.status, 200);
    assert.deepEqual(pull.body.payload, { body: 'hello' });
    assert.equal(pull.etag, push.etag);

    const cached = await jfetch('/v1/apps/notes/notes/n1', {
      token: APP_TOKEN,
      headers: { 'If-None-Match': pull.etag ?? '' },
    });
    assert.equal(cached.status, 304);
  });

  it('409s a stale push with the winning metadata', async () => {
    const stale = await jfetch('/v1/apps/notes/notes/n1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ title: 'Stale', payload: { body: 'old' }, baseRevision: 0 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.remote.revision, 1);
  });

  it('enforces collection encryption policy both ways', async () => {
    const envelope = {
      v: 1, algo: 'AES-GCM-256', kdf: 'PBKDF2-SHA-256',
      iterations: 310000, salt: 'c2FsdA==', iv: 'aXZpdml2aXZp',
    };
    const needsSeal = await jfetch('/v1/apps/notes/sealed/s1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: { secret: true }, baseRevision: 0 }),
    });
    assert.equal(needsSeal.status, 400);

    const sealedOk = await jfetch('/v1/apps/notes/sealed/s1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: 'Y2lwaGVydGV4dA==', encryption: envelope, baseRevision: 0 }),
    });
    assert.equal(sealedOk.status, 200);

    const noSealAllowed = await jfetch('/v1/apps/notes/plain/p1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: 'x', encryption: envelope, baseRevision: 0 }),
    });
    assert.equal(noSealAllowed.status, 400);
  });

  it('accepts bound (v2) envelopes and rejects unknown versions', async () => {
    const envelope = {
      algo: 'AES-GCM-256', kdf: 'PBKDF2-SHA-256',
      iterations: 310000, salt: 'c2FsdA==', iv: 'aXZpdml2aXZp',
    };
    const v2 = await jfetch('/v1/apps/notes/sealed/bound1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: 'Y2lwaGVy', encryption: { v: 2, ...envelope }, baseRevision: 0 }),
    });
    assert.equal(v2.status, 200);
    const read = await jfetch('/v1/apps/notes/sealed/bound1', { token: APP_TOKEN });
    assert.equal(read.body.encryption.v, 2);

    const v3 = await jfetch('/v1/apps/notes/sealed/bound2', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: 'Y2lwaGVy', encryption: { v: 3, ...envelope }, baseRevision: 0 }),
    });
    assert.equal(v3.status, 400);
  });

  it('413s payloads over the collection limit', async () => {
    const big = await jfetch('/v1/apps/notes/notes/huge', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: 'z'.repeat(5000), baseRevision: 0 }),
    });
    assert.equal(big.status, 413);
  });

  it('rejects invalid collection and artifact ids', async () => {
    assert.equal((await jfetch('/v1/apps/notes/NOPE', { token: APP_TOKEN })).status, 400);
    assert.equal(
      (await jfetch('/v1/apps/notes/missing-collection', { token: APP_TOKEN })).status,
      404
    );
    assert.equal(
      (await jfetch('/v1/apps/notes/notes/.hidden', { token: APP_TOKEN })).status,
      400
    );
  });

  it('rejects Windows device names as app, collection, and artifact ids', async () => {
    for (const id of ['con', 'NUL', 'com1', 'lpt9.backup', 'Aux.json']) {
      const res = await jfetch(`/v1/apps/notes/notes/${id}`, {
        method: 'PUT',
        token: APP_TOKEN,
        body: JSON.stringify({ payload: { x: 1 }, baseRevision: 0 }),
      });
      assert.equal(res.status, 400, id);
    }
    const app = await jfetch('/v1/apps/prn', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({ app: 'prn', collections: { data: {} } }),
    });
    assert.equal(app.status, 400);
    const collection = await jfetch('/v1/apps/devices', {
      method: 'PUT',
      token: ADMIN,
      body: JSON.stringify({ app: 'devices', collections: { com3: {} } }),
    });
    assert.equal(collection.status, 400);
    assert.match(collection.body.message, /Windows device name/);
    // Names that merely start with a device name are fine.
    const fine = await jfetch('/v1/apps/notes/notes/console-log', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: { x: 1 }, baseRevision: 0 }),
    });
    assert.equal(fine.status, 200);
  });

  it('strips control characters from stored metadata', async () => {
    const res = await jfetch('/v1/apps/notes/notes/ctrl1', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({
        title: 'line one\nline\u0000two\u007f',
        deviceId: '\u0007dev-9',
        deviceName: 'phone\r\n',
        payload: { x: 1 },
        baseRevision: 0,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.artifact.title, 'line one line two');
    assert.equal(res.body.artifact.deviceId, 'dev-9');
    assert.equal(res.body.artifact.deviceName, 'phone');

    const onlyControl = await jfetch('/v1/apps/notes/notes/ctrl2', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ title: '\n\t', payload: {}, baseRevision: 0 }),
    });
    assert.equal(onlyControl.body.artifact.title, 'Untitled');
  });

  it('keeps only sane ISO updatedAt values, normalized to UTC', async () => {
    const push = async (id: string, updatedAt: unknown) =>
      (
        await jfetch(`/v1/apps/notes/notes/${id}`, {
          method: 'PUT',
          token: APP_TOKEN,
          body: JSON.stringify({ updatedAt, payload: {}, baseRevision: 0 }),
        })
      ).body.artifact;

    const offset = await push('when1', '2026-07-20T21:16:50.853+02:00');
    assert.equal(offset.updatedAt, '2026-07-20T19:16:50.853Z');

    for (const [id, bogus] of [
      ['when2', 'zzz-pinned-to-top'],
      ['when3', '9999-12-31T00:00:00Z'],
      ['when4', '1'],
    ] as const) {
      const artifact = await push(id, bogus);
      assert.equal(artifact.updatedAt, artifact.receivedAt, `${bogus} should fall back to hub time`);
    }
  });

  it('does not treat the inherited "constructor" key as a declared collection', async () => {
    // The allowlist is a bracket lookup on manifest.collections; a plain {} would
    // let "constructor" (an all-lowercase Object.prototype key that passes the
    // name pattern) resolve to a truthy prototype member and pass as declared.
    // The notes manifest never declares it.
    const read = await jfetch('/v1/apps/notes/constructor', { token: APP_TOKEN });
    assert.equal(read.status, 404);
    const write = await jfetch('/v1/apps/notes/constructor/x', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ payload: { x: 1 }, baseRevision: 0 }),
    });
    assert.equal(write.status, 404);
  });
});

describe('history + delete', () => {
  it('lists history and serves single revisions', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const r = await jfetch('/v1/apps/notes/notes/h1', {
        method: 'PUT',
        token: APP_TOKEN,
        body: JSON.stringify({ title: `v${i}`, payload: { v: i }, baseRevision: i - 1 }),
      });
      assert.equal(r.status, 200);
    }
    const history = await jfetch('/v1/apps/notes/notes/h1/history', { token: APP_TOKEN });
    assert.deepEqual(history.body.revisions.map((r: any) => r.revision), [3, 2, 1]);

    const r2 = await jfetch('/v1/apps/notes/notes/h1/history/2', { token: APP_TOKEN });
    assert.deepEqual(r2.body.payload, { v: 2 });
  });

  it('tombstones on delete and answers 410 afterwards', async () => {
    const del = await jfetch('/v1/apps/notes/notes/h1?baseRevision=3', {
      method: 'DELETE',
      token: APP_TOKEN,
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.artifact.deleted, true);

    const gone = await jfetch('/v1/apps/notes/notes/h1', { token: APP_TOKEN });
    assert.equal(gone.status, 410);
    assert.equal(gone.body.artifact.revision, 4);

    const list = await jfetch('/v1/apps/notes/notes', { token: APP_TOKEN });
    assert.ok(!list.body.artifacts.some((a: any) => a.id === 'h1'));
    const listAll = await jfetch('/v1/apps/notes/notes?includeDeleted=1', { token: APP_TOKEN });
    assert.ok(listAll.body.artifacts.some((a: any) => a.id === 'h1'));
  });
});

describe('bundles', () => {
  it('round-trips a raw export through a forced import, skipping tombstones', async () => {
    const exported = await jfetch('/v1/apps/notes/bundle', { token: APP_TOKEN });
    assert.equal(exported.status, 200);
    assert.ok(exported.body.artifacts.length > 0);

    const imported = await jfetch('/v1/apps/notes/bundle', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({ artifacts: exported.body.artifacts, force: true }),
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.ok, true);
    assert.ok(imported.body.written > 0);
    assert.ok(imported.body.skipped.length > 0); // the h1 tombstone
  });

  it('409s when every entry conflicts', async () => {
    const conflict = await jfetch('/v1/apps/notes/bundle', {
      method: 'PUT',
      token: APP_TOKEN,
      body: JSON.stringify({
        artifacts: [
          { collection: 'notes', id: 'n1', title: 'x', payload: {}, baseRevision: 99 },
        ],
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.written, 0);
  });
});

describe('static app hosting', () => {
  it('serves files for www apps and blocks traversal', async () => {
    const www = path.join(dataDir, 'apps', 'notes', 'www');
    await fs.mkdir(path.join(www, 'assets'), { recursive: true });
    await fs.writeFile(path.join(www, 'index.html'), '<h1>Tailnotes shell</h1>', 'utf8');
    await fs.writeFile(path.join(www, 'assets', 'app.css'), 'body{}', 'utf8');
    // Secret outside the www root that traversal must never reach.
    await fs.writeFile(path.join(dataDir, 'admin-token.txt'), 'SECRET', 'utf8');

    const page = await fetch(`${base}/apps/notes/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Tailnotes shell/);

    const css = await fetch(`${base}/apps/notes/assets/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);

    // SPA fallback for extension-less client routes.
    const spa = await fetch(`${base}/apps/notes/some/client/route`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /Tailnotes shell/);

    // Raw traversal attempts (bypassing fetch normalization).
    for (const attempt of [
      '/apps/notes/../../admin-token.txt',
      '/apps/notes/%2e%2e/%2e%2e/admin-token.txt',
      '/apps/notes/..%5C..%5Cadmin-token.txt',
      '/apps/notes/.hidden',
    ]) {
      const res = await rawGet(attempt);
      assert.notEqual(res.status, 200, `expected block for ${attempt}`);
      assert.ok(!res.body.includes('SECRET'), `leaked secret via ${attempt}`);
    }

    // Apps without www stay unhosted.
    const none = await fetch(`${base}/apps/unknown-app/`);
    assert.equal(none.status, 404);
  });

  it('does not follow a symlink that escapes www', async (t) => {
    const www = path.join(dataDir, 'apps', 'notes', 'www');
    await fs.mkdir(www, { recursive: true });
    const secret = path.join(dataDir, 'symlink-secret.txt');
    await fs.writeFile(secret, 'SYMLINK-SECRET', 'utf8');
    const outside = path.join(www, 'leak.txt');
    const inside = path.join(www, 'inside.txt');
    const alias = path.join(www, 'alias.txt');
    await fs.writeFile(inside, 'inside-ok', 'utf8');
    try {
      await fs.symlink(secret, outside, 'file');
      await fs.symlink(inside, alias, 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        t.skip('symlink creation is not permitted on this platform');
        return;
      }
      throw error;
    }

    const leaked = await fetch(`${base}/apps/notes/leak.txt`);
    const leakedBody = await leaked.text();
    assert.notEqual(leaked.status, 200);
    assert.ok(!leakedBody.includes('SYMLINK-SECRET'));

    const linked = await fetch(`${base}/apps/notes/alias.txt`);
    assert.equal(linked.status, 200);
    assert.equal(await linked.text(), 'inside-ok');
  });
});

function rawRequest(
  method: string,
  rawPath: string,
  requestHeaders: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      { host: url.hostname, port: url.port, path: rawPath, method, headers: requestHeaders },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    // Send headers only: an oversize Content-Length must be refused unread.
    req.flushHeaders();
  });
}

describe('server behaviour', () => {
  it('refuses an oversized Content-Length before reading the body', async () => {
    const res = await rawRequest('PUT', '/v1/apps/notes/notes/huge-declared', {
      Authorization: `Bearer ${ADMIN}`,
      'Content-Type': 'application/json',
      'Content-Length': String(100 * 1024 * 1024),
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.connection, 'close');
    assert.match(res.body, /Payload too large/);
  });

  it('sends security headers, and forbids framing only for the console', async () => {
    const consolePage = await fetch(`${base}/`);
    assert.equal(consolePage.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(consolePage.headers.get('referrer-policy'), 'no-referrer');
    assert.match(consolePage.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(consolePage.headers.get('x-frame-options'), 'DENY');

    const hosted = await fetch(`${base}/apps/notes/`);
    assert.equal(hosted.status, 200);
    assert.equal(hosted.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(hosted.headers.get('content-security-policy'), null);

    const api = await fetch(`${base}/health`);
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  });

  it('answers HEAD for the console and hosted files without a body', async () => {
    for (const target of ['/', '/apps/notes/', '/health']) {
      const res = await fetch(`${base}${target}`, { method: 'HEAD' });
      assert.equal(res.status, 200, target);
      assert.ok(Number(res.headers.get('content-length')) > 0, target);
      assert.equal(await res.text(), '', target);
    }
  });

  it('treats a weak If-None-Match validator as matching', async () => {
    const pull = await jfetch('/v1/apps/notes/notes/n1', { token: APP_TOKEN });
    assert.ok(pull.etag);
    const weak = await jfetch('/v1/apps/notes/notes/n1', {
      token: APP_TOKEN,
      headers: { 'If-None-Match': `W/${pull.etag}` },
    });
    assert.equal(weak.status, 304);
  });
});

describe('hub lifecycle', () => {
  it('reports server errors after startup instead of swallowing them', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailhub-life-'));
    const other = createHub({ dataDir: dir, adminToken: ADMIN, quiet: true });
    await other.listen(0, '127.0.0.1');
    const logged = t.mock.method(console, 'error', () => undefined);
    try {
      assert.equal(other.server.listenerCount('error'), 1);
      other.server.emit('error', new Error('boom after listen'));
      assert.equal(logged.mock.callCount(), 1);
      assert.match(String(logged.mock.calls[0]?.arguments[1]), /boom after listen/);
    } finally {
      logged.mock.restore();
      await other.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('closes while a request is in flight, and repeated close() shares one shutdown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailhub-life-'));
    const other = createHub({ dataDir: dir, adminToken: ADMIN, quiet: true, shutdownGraceMs: 100 });
    const { port } = await other.listen(0, '127.0.0.1');
    const net = await import('node:net');
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    // Headers plus half a body: the request stays active, not idle.
    socket.write(
      `PUT /v1/apps/x/y/z HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${ADMIN}\r\n` +
        'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"payl'
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    const first = other.close();
    const second = other.close();
    assert.equal(first, second);
    await first;
    assert.ok(Date.now() - started < 2000, 'close() waited too long for the active request');
    socket.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('corrupt artifacts', () => {
  it('returns 422 and quarantines an unparseable record', async () => {
    const dir = path.join(dataDir, 'data', 'notes', 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'corrupt1.json'), '{ not json', 'utf8');

    const res = await jfetch('/v1/apps/notes/notes/corrupt1', { token: APP_TOKEN });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'Corrupt artifact');
    assert.equal(res.body.message, 'Artifact data is corrupt and was quarantined.');
    assert.ok(!JSON.stringify(res.body).includes('not json'));

    const names = await fs.readdir(dir);
    assert.ok(!names.includes('corrupt1.json'));
    assert.ok(names.some((name) => name.startsWith('corrupt1.json.corrupt-')));
  });
});
