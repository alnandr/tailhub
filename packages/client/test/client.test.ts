import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TailhubClient,
  TailhubError,
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
});

describe('retry helpers', () => {
  it('classifies transient statuses', () => {
    assert.equal(isTransientError(new TailhubError('x', 503)), true);
    assert.equal(isTransientError(new TailhubError('x', 429)), true);
    assert.equal(isTransientError(new TailhubError('x', 409)), false);
    assert.equal(isTransientError(new TailhubError('x', 401)), false);
    assert.equal(isTransientError(new Error('network down')), true);
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
