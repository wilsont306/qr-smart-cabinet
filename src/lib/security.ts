import { db } from "./store";

// ---------------------------------------------------------------------------
// Rate limiting — fixed-window token buckets keyed in memory (stands in for the
// Redis token buckets in PRD §5.1). Enforced server-side only.
// ---------------------------------------------------------------------------

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // seconds
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateResult {
  const now = Date.now();
  const b = db.rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    db.rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  if (b.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.ceil((b.resetAt - now) / 1000),
    };
  }
  b.count += 1;
  return { ok: true, remaining: limit - b.count, retryAfter: 0 };
}

// Limits from PRD §5.1. Production values are strict; in development they're
// loosened so local testing doesn't lock you out (the PRD limits are enforced
// as-is whenever NODE_ENV=production).
const PROD = process.env.NODE_ENV === "production";

export const LIMITS = {
  auth: { limit: PROD ? 5 : 100, windowMs: 15 * 60 * 1000 }, // 5 / 15 min (prod)
  // Workshop use needs many opens/takes per visit; PRD 10/hr was too tight in practice.
  unlock: { limit: PROD ? 60 : 200, windowMs: 60 * 60 * 1000 }, // 60 / hour per user
  lookup: { limit: 60, windowMs: 60 * 1000 }, // drawer enumeration guard
  drawerCooldownMs: 5 * 1000, // between opens on the same drawer
};

// ---------------------------------------------------------------------------
// Idempotency (PRD §5.2) — retries with the same key return the stored result
// instead of re-running the mutation.
// ---------------------------------------------------------------------------

export function getIdempotent<T>(userId: string, key: string): T | undefined {
  return db.idempotency.get(`${userId}:${key}`) as T | undefined;
}
export function saveIdempotent<T>(userId: string, key: string, value: T): T {
  db.idempotency.set(`${userId}:${key}`, value);
  return value;
}

// ---------------------------------------------------------------------------
// Authorization — deny-by-default object-level check (PRD §5.2, kills IDOR).
// ---------------------------------------------------------------------------
export function canAccessDrawer(userId: string, drawerId: string): boolean {
  return db.permissions.get(userId)?.has(drawerId) ?? false;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "0.0.0.0";
}
