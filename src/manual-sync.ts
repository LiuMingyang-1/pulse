import { FEISHU_SYNC_COOLDOWN_MS } from './sync-cooldown';

const SOFT_REASONS = new Set(['not_configured', 'in_progress', 'recently_synced']);

/** True when this click should POST /api/feishu/sync (signed in + debounce elapsed). */
export function shouldPostFeishuSync(signedIn: boolean, lastAttemptAt: number, now: number): boolean {
  return signedIn && now - lastAttemptAt >= FEISHU_SYNC_COOLDOWN_MS;
}

export function feishuSyncReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('reason' in body)) return undefined;
  const reason = (body as { reason: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * 2xx is success, including `not_configured` and the skipped-slot reasons.
 * Those reasons stay non-fatal even if a proxy rewrites the status.
 */
export function isSoftFeishuSyncResult(status: number, reason?: string): boolean {
  if (status >= 200 && status < 300) return true;
  return typeof reason === 'string' && SOFT_REASONS.has(reason);
}
