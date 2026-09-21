import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TailhubClient,
  TailhubError,
  TailhubNetworkError,
  isTransientError,
  withRetry,
} from '../src/index.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500, body: { error: 'exhausted' } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;
  return { impl, calls };
}

function client(f: typeof fetch) {
  return new TailhubClient({
    baseUrl: 'http://hub.test:4747/',
    app: 'notes',
    token: 'tok-123',
    deviceId: 'dev-1',
    deviceName: 'test-device',
    fetch: f,
  });
}

describe('TailhubClient', () => {
  it('sends auth + device headers and normalizes the base URL', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { artifacts: [] } }]);
    await client(impl).list('notes');
    assert.equal(calls[0]?.url, 'http://hub.test:4747/v1/apps/notes/notes');
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer tok-123');
    assert.equal(headers.get('X-Tailhub-Device'), 'dev-1');
    assert.equal(headers.get('X-Tailhub-Device-Name'), 'test-device');
  });

  it('pushes with baseRevision and returns the artifact + etag', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: { ok: true, created: true, artifact: { revision: 1 } },
        headers: { ETag: '"1-abc"' },
      },
    ]);
    const result = await client(impl).push('notes', 'n1', {
      payload: { body: 'x' },
      baseRevision: 0,
      title: 'First',
    });
    assert.equal(result.artifact.revision, 1);
    assert.equal(result.etag, '"1-abc"');
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.equal(sent.baseRevision, 0);
    assert.equal(sent.title, 'First');
    assert.equal(calls[0]?.init.method, 'PUT');
  });

  it('maps 409 to a TailhubError carrying the remote metadata', async () => {
    const { impl } = fakeFetch([
      {
        status: 409,
        body: { error: 'Conflict', message: 'stale', remote: { revision: 4, deviceName: 'phone' } },
      },
    ]);
    try {
      await client(impl).push('notes', 'n1', { payload: {}, baseRevision: 1 });
      assert.fail('expected a conflict error');
    } catch (error) {
      assert.ok(error instanceof TailhubError);
      assert.equal(error.conflict, true);
      assert.equal((error.remote as { revision: number }).revision, 4);
    }
  });

  it('treats 304 as notModified on pull', async () => {
    const { impl, calls } = fakeFetch([{ status: 304 }]);
    const result = await client(impl).pull('notes', 'n1', { etag: '"3-xyz"' });
    assert.deepEqual(result, { notModified: true });
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get('If-None-Match'), '"3-xyz"');
  });

  it('encodes path segments', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    await client(impl).pull('notes', 'weird id?').catch(() => undefined);
    assert.match(calls[0]?.url ?? '', /weird%20id%3F/);
  });

  it('wraps fetch transport failures as TailhubNetworkError', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(() => client(impl).list('notes'), TailhubNetworkError);
  });

  it('probes /health without a token or Authorization header', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { status: 'ok', name: 'tailhub', version: '0.1.0' } },
    ]);
    const hub = new TailhubClient({
      baseUrl: 'http://hub.test:4747',
      app: 'notes',
      token: '',
      fetch: impl,
    });
    const health = await hub.health();
    assert.equal(health.status, 'ok');
    assert.equal(health.name, 'tailhub');
    assert.equal(calls[0]?.url, 'http://hub.test:4747/health');
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get('Authorization'), null);
  });

  it('requires baseRevision on remove unless force is set', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { ok: true, artifact: { revision: 5 } } },
      { status: 200, body: { ok: true, artifact: { revision: 5 } } },
    ]);
    const hub = client(impl);
    await assert.rejects(
      () => hub.remove('notes', 'n1', {} as { baseRevision: number }),
      /baseRevision/
    );
    assert.equal(calls.length, 0);

    await hub.remove('notes', 'n1', { baseRevision: 4 });
    assert.equal(calls[0]?.init.method, 'DELETE');
    assert.match(calls[0]?.url ?? '', /baseRevision=4/);

    await hub.remove('notes', 'n1', { force: true });
    assert.match(calls[1]?.url ?? '', /force=1/);
    assert.doesNotMatch(calls[1]?.url ?? '', /baseRevision/);
  });
});

describe('retry helpers', () => {
  it('classifies transient statuses', () => {
    assert.equal(isTransientError(new TailhubError('x', 503)), true);
    assert.equal(isTransientError(new TailhubError('x', 429)), true);
    assert.equal(isTransientError(new TailhubError('x', 409)), false);
    assert.equal(isTransientError(new TailhubError('x', 401)), false);
    assert.equal(isTransientError(new TailhubNetworkError('timed out')), true);
    assert.equal(isTransientError(new TypeError('fetch failed')), false);
    assert.equal(isTransientError(new Error('network down')), false);
  });

  it('does not retry programmer errors', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          throw new TypeError('payload is not an object');
        },
        { attempts: 3, delaysMs: [1] }
      )
    );
    assert.equal(attempts, 1);
  });

  it('retries transient failures then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new TailhubError('busy', 503);
        return 'done';
      },
      { attempts: 3, delaysMs: [1, 1] }
    );
    assert.equal(result, 'done');
    assert.equal(attempts, 3);
  });

  it('does not retry permanent failures', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          throw new TailhubError('conflict', 409);
        },
        { attempts: 3, delaysMs: [1] }
      )
    );
    assert.equal(attempts, 1);
  });
});
