// Browser session for the dashboard. The only secret is AGENT_TOKEN: login
// compares the submitted value to it, then stores that same value in an
// HttpOnly cookie so page JS cannot read it. Agent routes keep using Bearer.

export const SESSION_COOKIE = 'pulse_session';
/** ~30 days, in seconds. */
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/** Short lockout window for login attempts (POST /api/login and ?token=). */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 60_000;

const MAX_BODY_CHARS = 8192;
const MAX_COOKIE_VALUE = 4096;

// Constant-time string comparison — pad to the same length and accumulate the
// XOR diff without early return so response timing doesn't leak the token.
// (No node:crypto here: the worker doesn't enable nodejs_compat.)
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt past the end returns NaN, which XORs as 0 — that plus the
    // length seed above keeps the loop running full length on a mismatch.
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Missing or empty AGENT_TOKEN never matches. */
export function tokenMatches(provided: string, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}

export function bearerMatches(authorization: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  return safeEqual(authorization ?? '', `Bearer ${expected}`);
}

export function encodeSession(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeSession(value: string): string | null {
  if (!value || value.length > MAX_COOKIE_VALUE) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeSession(token)}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

export function cookieMatches(cookieHeader: string | undefined, expected: string | undefined): boolean {
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return false;
  const decoded = decodeSession(raw);
  if (decoded === null) return false;
  return tokenMatches(decoded, expected);
}

export function userMatches(
  authorization: string | undefined,
  cookieHeader: string | undefined,
  expected: string | undefined,
): boolean {
  return bearerMatches(authorization, expected) || cookieMatches(cookieHeader, expected);
}

/**
 * Feed-only credential for /api/calendar.ics?token= — derived from
 * AGENT_TOKEN so there is no second secret to manage and it rotates with it.
 * A leaked subscription URL reads the feed but grants no write or other API
 * access (unlike handing out AGENT_TOKEN itself).
 */
export async function feedToken(expected: string | undefined): Promise<string | undefined> {
  if (!expected) return undefined;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`pulse-calendar-feed:${expected}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * Separate `token` from the rest of the URL. `token` is null when the query
 * param is absent (empty string when it is present but blank). `location` is
 * a same-origin path safe to put in a Location header.
 */
export function splitTokenQuery(rawUrl: string): { token: string | null; location: string } {
  const url = new URL(rawUrl);
  const has = url.searchParams.has('token');
  const token = has ? (url.searchParams.get('token') ?? '') : null;
  url.searchParams.delete('token');
  // Drop the rest of the query if a value still contains CR/LF. URLSearchParams
  // would percent-encode it, but echoing that into Location is not worth it.
  const hostile = [...url.searchParams.values()].some((v) => /[\r\n\0]/.test(v));
  const location = hostile ? url.pathname : url.pathname + url.search;
  return { token, location };
}

export function clientIp(headerValue: string | undefined): string {
  const ip = headerValue?.trim() ?? '';
  if (!ip) return 'unknown';
  return ip.slice(0, 128);
}

export function loginBodyTooLarge(text: string): boolean {
  return text.length > MAX_BODY_CHARS;
}

const buckets = new Map<string, number[]>();

export function resetLoginRateLimitForTests(): void {
  buckets.clear();
}

/** Per-isolate fixed window. A full bucket returns retryAfter in seconds. */
export function checkLoginRateLimit(
  ip: string,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfter: number } {
  const start = now - LOGIN_WINDOW_MS;
  const hits = (buckets.get(ip) ?? []).filter((t) => t > start);
  if (hits.length >= LOGIN_MAX_ATTEMPTS) {
    buckets.set(ip, hits);
    const retryAfter = Math.max(1, Math.ceil((hits[0]! + LOGIN_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  hits.push(now);
  buckets.set(ip, hits);
  if (buckets.size > 256) {
    for (const [key, stamps] of buckets) {
      if (stamps.every((t) => t <= start)) buckets.delete(key);
    }
  }
  return { ok: true };
}
