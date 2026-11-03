import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/feishu', () => ({
  runFeishuSync: vi.fn(),
  runFeishuSyncAfterPendingWrite: vi.fn(),
}));

import worker from '../src/worker';
import { runFeishuSync, runFeishuSyncAfterPendingWrite } from '../src/feishu';
import { SESSION_COOKIE, encodeSession } from '../src/session';

const sync = vi.mocked(runFeishuSync);
const syncAfterWrite = vi.mocked(runFeishuSyncAfterPendingWrite);

const env = {
  AGENT_TOKEN: 'secret',
  DB: {},
  ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
};

function ctx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(p: Promise<unknown>) { pending.push(p); },
    passThroughOnException() {},
  };
}

function post(headers?: Record<string, string>, execution?: ReturnType<typeof ctx>) {
  return worker.fetch(
    new Request('https://pulse.test/api/feishu/sync', { method: 'POST', headers }),
    env as any,
    (execution ?? ctx()) as any,
  );
}

describe('POST /api/feishu/sync', () => {
  beforeEach(() => {
    sync.mockReset();
    syncAfterWrite.mockReset();
  });

  it('401 without a bearer token or session cookie and does not sync', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('200 with the session cookie and no Authorization header', async () => {
    sync.mockResolvedValue({ ok: true, fetched: 1 });
    const res = await post({ Cookie: `${SESSION_COOKIE}=${encodeSession('secret')}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fetched: 1 });
    expect(sync).toHaveBeenCalledOnce();
  });

  it('401 when the cookie is the raw token instead of the session encoding', async () => {
    const res = await post({ Cookie: `${SESSION_COOKIE}=secret` });
    expect(res.status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('200 when the sync ran', async () => {
    sync.mockResolvedValue({ ok: true, fetched: 2 });
    const res = await post({ Authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fetched: 2 });
  });

  it('200 for not_configured', async () => {
    sync.mockResolvedValue({ ok: false, reason: 'not_configured' });
    const res = await post({ Authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('200 for in_progress and recently_synced so the page does not treat them as fatal', async () => {
    sync.mockResolvedValue({ ok: true, skipped: true, reason: 'in_progress', retry_after_ms: 1000 });
    let res = await post({ Authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: 'in_progress' });

    sync.mockResolvedValue({ ok: true, skipped: true, reason: 'recently_synced', retry_after_ms: 1000 });
    res = await post({ Authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: 'recently_synced' });
  });

  it('502 when Feishu itself failed', async () => {
    sync.mockResolvedValue({ ok: false, reason: 'records/search failed: http 400, code 99991672' });
    const res = await post({ Authorization: 'Bearer secret' });
    expect(res.status).toBe(502);
  });
});

describe('scheduled', () => {
  beforeEach(() => sync.mockReset());

  it('runs the sync from waitUntil', async () => {
    sync.mockResolvedValue({ ok: true });
    const execution = ctx();
    await worker.scheduled({} as any, env as any, execution as any);
    await Promise.all(execution.pending);
    expect(sync).toHaveBeenCalledOnce();
  });
});
