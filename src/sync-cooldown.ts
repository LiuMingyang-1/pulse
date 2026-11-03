/** Quiet period between Feishu syncs (manual refresh, cron, or todo toggle). */
export const FEISHU_SYNC_COOLDOWN_MS = 15_000;

/**
 * A D1 lock older than this is treated as abandoned so a crashed isolate
 * cannot block syncs until the next hour. Longer than a normal bitable pull.
 */
export const FEISHU_SYNC_STALE_MS = 45_000;

/**
 * Extra wait inside `waitUntil` after a skipped toggle sync. Stays under
 * Workers' ~30s post-response limit once a short Feishu round-trip is added.
 */
export const FEISHU_SYNC_RETRY_BUDGET_MS = 20_000;
