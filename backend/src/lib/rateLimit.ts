import type { Request } from "express";

// Minimal fixed-window failure limiter, in memory. No dependency — the app
// ships exactly three (express, drizzle, postgres) and this is ~50 lines.
//
// Scope: this exists to make guessing a round join code impractical, not to
// shape traffic. Only FAILED attempts are recorded, so a card legitimately
// PATCHing scores all afternoon is never throttled; a client walking the code
// space is cut off after `limit` misses. State is per-process and lost on
// restart, which is fine for that purpose (an attacker can't force a restart,
// and Cloudflare sits in front of everything anyway).

type Bucket = { count: number; resetAt: number };

export type FailureLimiter = {
  // Non-mutating: has this key already used up its allowance?
  isLimited(key: string): { retryAfterSec: number } | null;
  // Count one failed attempt.
  record(key: string): void;
  // Clear the count — called on success so a few typos don't lock out a card
  // that then gets the code right.
  reset(key: string): void;
};

export function createFailureLimiter(opts: {
  limit: number;
  windowMs: number;
  // Injectable clock so tests can advance time without sleeping.
  now?: () => number;
}): FailureLimiter {
  const { limit, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let lastSweep = now();

  // Drop expired buckets so a spray of distinct IPs can't grow the map without
  // bound. Amortized over calls rather than run on a timer — no interval to
  // leak, and an idle process does no work.
  function sweep(t: number) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [k, b] of buckets) {
      if (b.resetAt <= t) buckets.delete(k);
    }
  }

  return {
    isLimited(key) {
      const t = now();
      sweep(t);
      const b = buckets.get(key);
      if (!b || b.resetAt <= t || b.count < limit) return null;
      return { retryAfterSec: Math.max(1, Math.ceil((b.resetAt - t) / 1000)) };
    },
    record(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return;
      }
      b.count++;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}

// Caller identity for rate limiting. Cloudflare terminates in front of the API
// and sets CF-Connecting-IP to the real client; req.ip would be the tunnel.
// Falls back to req.ip for local dev, where there's no Cloudflare.
export function clientIp(req: Request): string {
  return req.header("CF-Connecting-IP")?.trim() || req.ip || "unknown";
}
