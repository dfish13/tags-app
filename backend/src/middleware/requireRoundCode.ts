import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { rounds } from "../db/schema.js";
import { normalizeCode } from "../lib/roundCode.js";
import { createFailureLimiter, clientIp } from "../lib/rateLimit.js";
import { roundCodeRequired } from "../config.js";

// Gate for the LIVE ROUND write routes (/api/rounds/:id/...).
//
// This is the app's third auth tier and the only write path NOT behind
// Cloudflare Access — that is deliberate: players at the course have no Access
// identity, and Access would bounce them at the edge before Express ever saw
// the request. Which is exactly why these routes may never live under
// /api/admin/*, and why what this gate authorizes is kept narrow:
//
//   * ONE round — everything is checked against the round in the URL, so a
//     code for round 7 does nothing to round 8.
//   * Check-in and entry edits ONLY. Never finalize, never the roster, never
//     tag status. Those stay behind requireAdmin.
//   * Never a finalized round — the code is cleared on finalize, and status is
//     re-checked here regardless.
//   * Never a round that isn't open to players — a round with no code (never
//     issued, or revoked) and an expired code are both refused.
//
// The last two hold whether or not a code is REQUIRED (see config.ts): with
// REQUIRE_ROUND_CODE off, every check below still runs except the two that
// read what the caller supplied. The code keeps its other job — it is what
// marks a round open to players — so revoking one still shuts the round.
//
// Brute force is handled by counting failed attempts per client IP.

// Shared with POST /rounds/join, which maps the whole code space and so draws
// from the same per-IP budget. Exported for tests too, which need a clean
// slate between cases.
export const codeFailureLimiter = createFailureLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
});
const failures = codeFailureLimiter;

export type RoundCodeRequest = Request & {
  round?: typeof rounds.$inferSelect;
};

export async function requireRoundCode(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // One read for the whole request: a flag that changed mid-handler would let
  // a request pass one check under one rule and the next under the other.
  const gated = roundCodeRequired();

  const ip = clientIp(req);
  if (gated) {
    const limited = failures.isLimited(ip);
    if (limited) {
      res.set("Retry-After", String(limited.retryAfterSec));
      return res.status(429).json({
        error: "Too many incorrect codes. Try again in a few minutes.",
      });
    }
  }

  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId)) {
    return res.status(400).json({ error: "Invalid round id" });
  }

  // Header is the primary channel; body is accepted so the join form can post
  // it without a custom header. Never read from the query string — codes must
  // not end up in logs or Referer headers.
  const supplied = normalizeCode(
    req.header("X-Round-Code") ?? (req.body as { code?: unknown })?.code
  );
  if (gated && !supplied) {
    // Malformed input isn't a guess at a specific code, but it IS how a naive
    // brute-forcer looks, so it counts.
    failures.record(ip);
    return res.status(401).json({ error: "A valid round code is required" });
  }

  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
  if (!round) return res.status(404).json({ error: "Round not found" });

  if (round.status === "finalized") {
    return res.status(409).json({ error: "This round is finalized" });
  }
  if (!round.joinCode) {
    // Covers scoring as well as check-in — this route set is both, and an
    // admin can close a round to players part-way through.
    return res.status(403).json({ error: "This round is closed to players" });
  }
  if (round.codeExpiresAt && round.codeExpiresAt.getTime() <= Date.now()) {
    return res.status(403).json({
      error: gated
        ? "This round's code has expired"
        : "This round is closed to players",
    });
  }
  if (gated) {
    if (round.joinCode !== supplied) {
      failures.record(ip);
      return res
        .status(401)
        .json({ error: "That code doesn't match this round" });
    }
    failures.reset(ip);
  }

  (req as RoundCodeRequest).round = round;
  next();
}
