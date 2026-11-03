import { describe, expect, it } from 'vitest';
import { FEISHU_SYNC_COOLDOWN_MS } from '../src/sync-cooldown';
import {
  feishuSyncReason,
  isSoftFeishuSyncResult,
  shouldPostFeishuSync,
} from '../src/manual-sync';

describe('manual feishu sync debounce', () => {
  it('posts only when a token is saved and the debounce has elapsed', () => {
    expect(shouldPostFeishuSync(false, 0, FEISHU_SYNC_COOLDOWN_MS)).toBe(false);
    expect(shouldPostFeishuSync(true, 1_000, 1_000 + FEISHU_SYNC_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldPostFeishuSync(true, 1_000, 1_000 + FEISHU_SYNC_COOLDOWN_MS)).toBe(true);
    expect(shouldPostFeishuSync(true, 0, Date.now())).toBe(true);
  });

  it('treats not_configured and skipped slots as non-fatal', () => {
    expect(isSoftFeishuSyncResult(200, 'not_configured')).toBe(true);
    expect(isSoftFeishuSyncResult(200, 'in_progress')).toBe(true);
    expect(isSoftFeishuSyncResult(200, 'recently_synced')).toBe(true);
    expect(isSoftFeishuSyncResult(200)).toBe(true);
    expect(isSoftFeishuSyncResult(502, 'in_progress')).toBe(true);
    expect(isSoftFeishuSyncResult(502, 'recently_synced')).toBe(true);
    expect(isSoftFeishuSyncResult(502, 'not_configured')).toBe(true);
    expect(isSoftFeishuSyncResult(502, 'records/search failed: http 400')).toBe(false);
    expect(isSoftFeishuSyncResult(401)).toBe(false);
  });

  it('reads a string reason and ignores anything else', () => {
    expect(feishuSyncReason({ reason: 'in_progress' })).toBe('in_progress');
    expect(feishuSyncReason({ reason: 1 })).toBeUndefined();
    expect(feishuSyncReason(null)).toBeUndefined();
    expect(feishuSyncReason('nope')).toBeUndefined();
  });
});
