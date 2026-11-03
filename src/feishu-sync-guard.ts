import {
  FEISHU_SYNC_COOLDOWN_MS,
  FEISHU_SYNC_STALE_MS,
} from './sync-cooldown';

export interface SyncSkip {
  ok: true;
  skipped: true;
  reason: 'in_progress' | 'recently_synced';
  retry_after_ms: number;
}

export interface SyncReservation {
  owner: string;
  /** Set when this call won the D1 row (or the table is missing and we proceed). */
  acquired: boolean;
  memoryOnly: boolean;
  releaseFlight: () => void;
}

type Memory = { state: 'idle' | 'running'; until: number };

let memory: Memory = { state: 'idle', until: 0 };
let inFlight: Promise<void> | null = null;
let guardWarningLogged = false;

function skip(reason: SyncSkip['reason'], until: number, now: number): SyncSkip {
  return {
    ok: true,
    skipped: true,
    reason,
    retry_after_ms: Math.max(0, until - now),
  };
}

function warnGuard(err: unknown): void {
  if (guardWarningLogged) return;
  guardWarningLogged = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn('[feishu] sync guard unavailable, in-isolate lock only:', msg);
}

export function resetFeishuSyncGuardForTests(): void {
  memory = { state: 'idle', until: 0 };
  inFlight = null;
  guardWarningLogged = false;
}

/** Drop this isolate's view of the lock without touching D1 (other-isolate tests). */
export function clearFeishuSyncIsolateMemoryForTests(): void {
  memory = { state: 'idle', until: 0 };
  inFlight = null;
}

export function currentFeishuSyncFlight(): Promise<void> | null {
  return inFlight;
}

export function feishuSyncCooldownRemaining(now = Date.now()): number {
  if (memory.state === 'idle' && memory.until > now) return memory.until - now;
  return 0;
}

/**
 * Same-isolate fast path. `inFlight` is the mutex; `memory` only remembers a
 * cooldown this isolate already observed. Another isolate's running lock is
 * not cached here — D1 is checked for that — so a finished remote sync cannot
 * look busy until its stale deadline.
 */
export function peekFeishuSyncSkip(now = Date.now()): SyncSkip | null {
  if (inFlight) return skip('in_progress', now + FEISHU_SYNC_COOLDOWN_MS, now);
  if (memory.state === 'idle' && memory.until > now) return skip('recently_synced', memory.until, now);
  return null;
}

function changes(result: D1Result): number {
  return result.meta?.changes ?? 0;
}

/**
 * Reserve this isolate synchronously, then try to claim the D1 row.
 * Call `finishFeishuSyncReservation` from `finally` only when `acquired`.
 */
export async function beginFeishuSync(db: D1Database, now = Date.now()): Promise<SyncReservation | SyncSkip> {
  const fast = peekFeishuSyncSkip(now);
  if (fast) return fast;

  let resolveFlight: () => void = () => {};
  const flight = new Promise<void>((resolve) => {
    resolveFlight = resolve;
  });
  inFlight = flight;

  const owner = crypto.randomUUID();
  const reservation: SyncReservation = {
    owner,
    acquired: false,
    memoryOnly: false,
    releaseFlight: () => {
      if (inFlight === flight) inFlight = null;
      resolveFlight();
    },
  };

  const staleUntil = now + FEISHU_SYNC_STALE_MS;
  try {
    const updated = await db.prepare(
      `UPDATE feishu_sync_guard
       SET state = 'running', until_ms = ?, owner = ?
       WHERE id = 'feishu' AND until_ms <= ?`,
    ).bind(staleUntil, owner, now).run();

    if (changes(updated) > 0) {
      reservation.acquired = true;
      return reservation;
    }

    const row = await db.prepare(
      `SELECT state, until_ms FROM feishu_sync_guard WHERE id = ?`,
    ).bind('feishu').first<{ state: string; until_ms: number }>();

    if (!row) {
      const inserted = await db.prepare(
        `INSERT INTO feishu_sync_guard (id, state, until_ms, owner)
         VALUES ('feishu', 'running', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(staleUntil, owner).run();
      if (changes(inserted) > 0) {
        reservation.acquired = true;
        return reservation;
      }
      reservation.releaseFlight();
      return skip('in_progress', staleUntil, Date.now());
    }

    const reason = row.state === 'running' ? 'in_progress' : 'recently_synced';
    // Remember a cooldown locally. A remote *running* lock is not cached:
    // that isolate will release it, and a stale local "running" mark would
    // keep this isolate quiet until the abandoned-lock deadline.
    if (reason === 'recently_synced') memory = { state: 'idle', until: row.until_ms };
    reservation.releaseFlight();
    return skip(reason, row.until_ms, Date.now());
  } catch (err) {
    warnGuard(err);
    reservation.acquired = true;
    reservation.memoryOnly = true;
    return reservation;
  }
}

export async function finishFeishuSyncReservation(db: D1Database, reservation: SyncReservation, now = Date.now()): Promise<void> {
  const until = now + FEISHU_SYNC_COOLDOWN_MS;
  memory = { state: 'idle', until };
  if (reservation.memoryOnly) return;
  try {
    await db.prepare(
      `UPDATE feishu_sync_guard
       SET state = 'idle', until_ms = ?, owner = NULL
       WHERE id = 'feishu' AND owner = ?`,
    ).bind(until, reservation.owner).run();
  } catch (err) {
    warnGuard(err);
  }
}

export async function feishuSyncRetryDelayMs(db: D1Database, now = Date.now()): Promise<number> {
  let wait = feishuSyncCooldownRemaining(now);
  try {
    const row = await db.prepare(
      `SELECT state, until_ms FROM feishu_sync_guard WHERE id = ?`,
    ).bind('feishu').first<{ state: string; until_ms: number }>();
    if (row) wait = Math.max(wait, row.until_ms - now);
  } catch {
    // Missing table: the in-isolate cooldown is the only signal.
  }
  return Math.max(0, wait);
}

export async function sleepForFeishuRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  // `scheduler.wait` yields without burning Worker CPU. Node tests fall back
  // to setTimeout so fake timers can advance the retry.
  if (typeof scheduler !== 'undefined' && typeof scheduler.wait === 'function') {
    await scheduler.wait(ms, signal ? { signal } : undefined);
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
