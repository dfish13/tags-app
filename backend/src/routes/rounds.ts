import { Router } from "express";
import { eq, and, inArray, desc, asc, sql, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { rounds, roundEntries, tags, players } from "../db/schema.js";
import {
  requireRoundCode,
  codeFailureLimiter,
  type RoundCodeRequest,
} from "../middleware/requireRoundCode.js";
import { generateCode, normalizeCode } from "../lib/roundCode.js";
import { clientIp } from "../lib/rateLimit.js";
import { replayTagHolders } from "../lib/tagHolders.js";

// Columns of `rounds` safe to serve publicly. Spelled out rather than
// `select()` because the table carries `join_code` (and `client_key`), and
// spreading a whole row into a response would hand the join code to anyone who
// asks for the round. `joinable` reports whether a code EXISTS without ever
// carrying its value. Every public/code-gated response builds from this.
const roundPublicColumns = {
  id: rounds.id,
  date: rounds.date,
  course: rounds.course,
  status: rounds.status,
  joinable: sql<boolean>`(${rounds.joinCode} is not null)`,
};

// ---- Public read routes, mounted at /rounds ----

export const roundsRouter = Router();

// List all rounds, newest first, each with its entry (player) count.
roundsRouter.get("/", async (_req, res) => {
  const all = await db
    .select({
      id: rounds.id,
      date: rounds.date,
      course: rounds.course,
      status: rounds.status,
      playerCount: sql<number>`count(${roundEntries.id})::int`,
    })
    .from(rounds)
    .leftJoin(roundEntries, eq(roundEntries.roundId, rounds.id))
    .groupBy(rounds.id)
    .orderBy(desc(rounds.date), desc(rounds.id));
  res.json(all);
});

// Rounds currently open for check-in, soonest first. Public and code-free: the
// EXISTENCE of a live round is league news ("we're playing at Maple Hill"),
// only the code to write to it is secret. Drives the Join card on Home.
roundsRouter.get("/live", async (_req, res) => {
  const live = await db
    .select({
      ...roundPublicColumns,
      playerCount: sql<number>`count(${roundEntries.id})::int`,
    })
    .from(rounds)
    .leftJoin(roundEntries, eq(roundEntries.roundId, rounds.id))
    .where(and(ne(rounds.status, "finalized"), sql`${rounds.joinCode} is not null`))
    .groupBy(rounds.id)
    .orderBy(asc(rounds.date), asc(rounds.id));
  res.json(live);
});

// Exchange a code for the round it belongs to. Discovery step for a player who
// has been read a code at the course and doesn't know the round id — every
// write after this uses /rounds/:id/* with the same code. Rate-limited on the
// same per-IP failure budget as the code gate, since this route is the one
// that maps the whole code space.
roundsRouter.post("/join", async (req, res) => {
  const ip = clientIp(req);
  const limited = codeFailureLimiter.isLimited(ip);
  if (limited) {
    res.set("Retry-After", String(limited.retryAfterSec));
    return res.status(429).json({
      error: "Too many incorrect codes. Try again in a few minutes.",
    });
  }

  const code = normalizeCode((req.body as { code?: unknown })?.code);
  if (!code) {
    codeFailureLimiter.record(ip);
    return res.status(401).json({ error: "A valid round code is required" });
  }

  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.joinCode, code));
  // A code that matches nothing and a code on a finalized round are the same
  // answer on purpose — neither confirms that a code exists.
  if (!round || round.status === "finalized") {
    codeFailureLimiter.record(ip);
    return res.status(404).json({ error: "No open round with that code" });
  }
  if (round.codeExpiresAt && round.codeExpiresAt.getTime() <= Date.now()) {
    return res.status(403).json({ error: "This round's code has expired" });
  }

  codeFailureLimiter.reset(ip);
  res.json(await loadRound(db, round.id));
});

// Get one round with its entries, enriched with player names and tag numbers
// (incoming + assigned) so clients can display it without extra lookups.
// Public — this is also how a live round's clients poll for each other's
// scores, so it must never leak the join code (see roundPublicColumns).
roundsRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid round id" });
  }
  const full = await loadRound(db, id);
  if (!full) return res.status(404).json({ error: "Round not found" });
  res.json(full);
});

// ---- Live-round write routes, mounted at /rounds (behind requireRoundCode) ----
//
// Anyone holding the round's code can check players in and edit scores —
// including someone else's, because one person keeps the card for a whole
// group. The code scopes writes to this round's entries and nothing else;
// creating and finalizing rounds stay behind Cloudflare Access.

// Check a player in. Only while status is "open": the redistributed tag pool
// IS the set of participants' incoming tags, so admitting someone after
// scoring starts silently changes what every other player can win.
roundsRouter.post("/:id/checkin", requireRoundCode, async (req, res, next) => {
  const round = (req as RoundCodeRequest).round!;
  if (round.status !== "open") {
    return res
      .status(409)
      .json({ error: "Check-in is closed for this round" });
  }

  const playerId = Number((req.body as { playerId?: unknown })?.playerId);
  const tagNumber = Number((req.body as { tagNumber?: unknown })?.tagNumber);
  if (!Number.isInteger(playerId)) {
    return res.status(400).json({ error: "playerId is required" });
  }
  if (!Number.isInteger(tagNumber) || tagNumber < 1 || tagNumber > 300) {
    return res.status(400).json({ error: "tagNumber must be an integer 1–300" });
  }
  const acePool = Boolean((req.body as { acePool?: unknown })?.acePool);
  const ctp = Boolean((req.body as { ctp?: unknown })?.ctp);

  try {
    const [tag] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.number, tagNumber));
    if (!tag) {
      return res.status(400).json({ error: `Tag #${tagNumber} does not exist` });
    }
    const [player] = await db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.id, playerId));
    if (!player) {
      return res.status(400).json({ error: "That player is not on the roster" });
    }

    const [created] = await db
      .insert(roundEntries)
      .values({ roundId: round.id, playerId, incomingTagId: tag.id, acePool, ctp })
      .returning({ id: roundEntries.id });
    const [entry] = await selectEntries(db, eq(roundEntries.id, created.id));
    res.status(201).json(entry);
  } catch (err) {
    // Two people checking in at once can both pass the checks above and race
    // to the insert; the DB constraints are what actually decide. Translate
    // each into the message that tells the loser what to do.
    const which = uniqueViolationConstraint(err);
    if (which?.includes("incoming_tag")) {
      return res.status(409).json({
        error: `Tag #${tagNumber} is already checked in on this round`,
      });
    }
    if (which?.includes("player_id")) {
      return res
        .status(409)
        .json({ error: "That player is already checked in" });
    }
    next(err); // never throw from an async handler — see /complete below
  }
});

// Edit an entry: score, and the pools. Allowed while "open" or "scoring" —
// entering scores is the whole point of the scoring phase.
roundsRouter.patch(
  "/:id/entries/:entryId",
  requireRoundCode,
  async (req, res, next) => {
    const round = (req as RoundCodeRequest).round!;
    const entryId = Number(req.params.entryId);
    if (!Number.isInteger(entryId)) {
      return res.status(400).json({ error: "Invalid entry id" });
    }

    const body = req.body as {
      score?: unknown;
      acePool?: unknown;
      ctp?: unknown;
      tagNumber?: unknown;
    };
    const patch: Partial<typeof roundEntries.$inferInsert> = {};

    if (body?.score !== undefined) {
      if (body.score === null || body.score === "") {
        patch.score = null; // DNF / not finished
      } else {
        const score = Number(body.score);
        // Integer, not just finite: the column is an int, so a fractional
        // value would fail in the database instead of at the door.
        if (!Number.isInteger(score)) {
          return res
            .status(400)
            .json({ error: "score must be a whole number or null" });
        }
        patch.score = score;
      }
    }
    if (body?.acePool !== undefined) patch.acePool = Boolean(body.acePool);
    if (body?.ctp !== undefined) patch.ctp = Boolean(body.ctp);

    // Correcting a mistyped incoming tag is a pool change, so it follows the
    // same rule as check-in: only while the round is still open.
    if (body?.tagNumber !== undefined) {
      if (round.status !== "open") {
        return res
          .status(409)
          .json({ error: "Incoming tags are locked once check-in closes" });
      }
      const tagNumber = Number(body.tagNumber);
      if (!Number.isInteger(tagNumber) || tagNumber < 1 || tagNumber > 300) {
        return res
          .status(400)
          .json({ error: "tagNumber must be an integer 1–300" });
      }
      const [tag] = await db
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.number, tagNumber));
      if (!tag) {
        return res.status(400).json({ error: `Tag #${tagNumber} does not exist` });
      }
      patch.incomingTagId = tag.id;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    patch.updatedAt = new Date();

    try {
      const [updated] = await db
        .update(roundEntries)
        .set(patch)
        .where(
          and(eq(roundEntries.id, entryId), eq(roundEntries.roundId, round.id))
        )
        .returning({ id: roundEntries.id });
      if (!updated) return res.status(404).json({ error: "Entry not found" });
      const [entry] = await selectEntries(db, eq(roundEntries.id, updated.id));
      res.json(entry);
    } catch (err) {
      if (uniqueViolationConstraint(err)?.includes("incoming_tag")) {
        return res
          .status(409)
          .json({ error: "Another player is already checked in with that tag" });
      }
      next(err);
    }
  }
);

// Remove an entry — a mis-check-in, or someone who bailed before teeing off.
// Only while "open", for the same pool reason as check-in.
roundsRouter.delete("/:id/entries/:entryId", requireRoundCode, async (req, res) => {
  const round = (req as RoundCodeRequest).round!;
  const entryId = Number(req.params.entryId);
  if (!Number.isInteger(entryId)) {
    return res.status(400).json({ error: "Invalid entry id" });
  }
  if (round.status !== "open") {
    return res
      .status(409)
      .json({ error: "Players can't be removed once check-in closes" });
  }
  const [deleted] = await db
    .delete(roundEntries)
    .where(and(eq(roundEntries.id, entryId), eq(roundEntries.roundId, round.id)))
    .returning({ id: roundEntries.id });
  if (!deleted) return res.status(404).json({ error: "Entry not found" });
  res.status(204).end();
});

// ---- Admin write routes, mounted at /admin/rounds (behind requireAdmin) ----

export const roundsAdminRouter = Router();

// Rank a round's participants and pair them with the redistributed tag pool.
// Lowest score takes the lowest tag in the pool; ties break on the lower
// incoming tag; DNFs (no score) rank last among themselves by incoming tag.
// Shared by the one-shot and step-by-step finalize paths so they can't drift.
function assignTags<T extends { tagNumber: number; score: number | null }>(
  entries: T[]
): { entry: T; assignedNumber: number }[] {
  const scored = entries
    .filter((e) => e.score !== null)
    .sort((a, b) => a.score! - b.score! || a.tagNumber - b.tagNumber);
  const dnf = entries
    .filter((e) => e.score === null)
    .sort((a, b) => a.tagNumber - b.tagNumber);
  const ranked = [...scored, ...dnf];
  const pool = entries.map((e) => e.tagNumber).sort((a, b) => a - b);
  return ranked.map((entry, i) => ({ entry, assignedNumber: pool[i] }));
}

// One entry enriched for display. Shared by loadRound and the single-entry
// responses of the live-round write routes.
function selectEntries(tx: typeof db, where: ReturnType<typeof eq>) {
  const incoming = alias(tags, "incoming_tag");
  const assigned = alias(tags, "assigned_tag");
  return tx
    .select({
      id: roundEntries.id,
      playerId: roundEntries.playerId,
      playerName: players.name,
      score: roundEntries.score,
      acePool: roundEntries.acePool,
      ctp: roundEntries.ctp,
      incomingNumber: incoming.number,
      assignedNumber: assigned.number,
      updatedAt: roundEntries.updatedAt,
    })
    .from(roundEntries)
    .innerJoin(players, eq(players.id, roundEntries.playerId))
    .leftJoin(incoming, eq(incoming.id, roundEntries.incomingTagId))
    .leftJoin(assigned, eq(assigned.id, roundEntries.assignedTagId))
    .where(where);
}

// Load a round with entries enriched for display (names + tag numbers).
// Returns null when the round doesn't exist. Public-safe: selects named
// columns, never the join code.
async function loadRound(tx: typeof db, roundId: number) {
  const [round] = await tx
    .select(roundPublicColumns)
    .from(rounds)
    .where(eq(rounds.id, roundId));
  if (!round) return null;
  const entries = await selectEntries(tx, eq(roundEntries.roundId, roundId));
  return { ...round, entries };
}

// One-shot finalize: create the round, its entries, the tag assignments, and
// the new tag_holders state in a SINGLE transaction. Replaces a ~35-request
// client sequence whose interruption stranded half-built rounds.
//
// `clientKey` makes it idempotent: the client mints one per local round and
// resends it on retry, so a request whose transaction committed but whose
// response was never seen returns THAT round (replayed: true) instead of
// redistributing tags twice. The unique index is the real guard — a
// concurrent duplicate loses the insert race and is served the winner's row.
type RoundPlayerInput = {
  playerId: number;
  tagNumber: number;
  score: number | null;
  acePool: boolean;
  ctp: boolean;
};

roundsAdminRouter.post("/complete", async (req, res, next) => {
  const date = String(req.body?.date ?? "").trim();
  if (!date) return res.status(400).json({ error: "date is required" });
  const course = req.body?.course ? String(req.body.course).trim() : null;
  const clientKey = req.body?.clientKey
    ? String(req.body.clientKey).trim()
    : null;

  const raw = Array.isArray(req.body?.players) ? req.body.players : null;
  if (!raw || raw.length === 0) {
    return res.status(400).json({ error: "players are required" });
  }
  const input: RoundPlayerInput[] = raw.map((p: Record<string, unknown>) => ({
    playerId: Number(p?.playerId),
    tagNumber: Number(p?.tagNumber),
    score:
      p?.score === null || p?.score === undefined ? null : Number(p.score),
    acePool: Boolean(p?.acePool),
    ctp: Boolean(p?.ctp),
  }));
  for (const p of input) {
    if (!Number.isInteger(p.playerId) || !Number.isInteger(p.tagNumber)) {
      return res
        .status(400)
        .json({ error: "each player needs playerId and tagNumber" });
    }
    // Integer, not just finite: the score column is an int, so a fractional
    // value would fail mid-transaction instead of at the door.
    if (p.score !== null && !Number.isInteger(p.score)) {
      return res
        .status(400)
        .json({ error: "score must be a whole number or null" });
    }
  }
  if (new Set(input.map((p) => p.playerId)).size !== input.length) {
    return res.status(400).json({ error: "a player appears twice" });
  }
  if (new Set(input.map((p) => p.tagNumber)).size !== input.length) {
    return res
      .status(400)
      .json({ error: "two players brought the same tag number" });
  }

  try {
    const { roundId, replayed } = await db.transaction(async (tx) => {
      if (clientKey) {
        const [existing] = await tx
          .select()
          .from(rounds)
          .where(eq(rounds.clientKey, clientKey));
        if (existing) return { roundId: existing.id, replayed: true };
      }

      // Resolve tag numbers → ids, and confirm every player exists, before
      // writing anything, so failures produce a clear message rather than a
      // raw FK violation.
      const numbers = input.map((p) => p.tagNumber);
      const tagRows = await tx
        .select({ id: tags.id, number: tags.number })
        .from(tags)
        .where(inArray(tags.number, numbers));
      const tagIdByNumber = new Map(tagRows.map((t) => [t.number, t.id]));
      const missingTag = numbers.find((n) => !tagIdByNumber.has(n));
      if (missingTag !== undefined) {
        throw new HttpError(400, `Tag #${missingTag} does not exist`);
      }
      const playerIds = input.map((p) => p.playerId);
      const playerRows = await tx
        .select({ id: players.id })
        .from(players)
        .where(inArray(players.id, playerIds));
      const knownPlayers = new Set(playerRows.map((p) => p.id));
      const missingPlayer = playerIds.find((id) => !knownPlayers.has(id));
      if (missingPlayer !== undefined) {
        throw new HttpError(400, `Player ${missingPlayer} is not on the roster`);
      }

      const [round] = await tx
        .insert(rounds)
        .values({ date, course, status: "finalized", clientKey })
        .returning();

      const assignments = assignTags(input);
      await tx.insert(roundEntries).values(
        assignments.map(({ entry, assignedNumber }) => ({
          roundId: round.id,
          playerId: entry.playerId,
          incomingTagId: tagIdByNumber.get(entry.tagNumber)!,
          score: entry.score,
          acePool: entry.acePool,
          ctp: entry.ctp,
          assignedTagId: tagIdByNumber.get(assignedNumber)!,
        }))
      );

      // The entries above ARE the record of what this round did; tag_holders
      // is derived from them and every other round, in date order. A round
      // backfilled from last season lands in its own place in the log rather
      // than overwriting today's standings.
      await replayTagHolders(tx);

      return { roundId: round.id, replayed: false };
    });

    const full = (await loadRound(db, roundId))!; // just committed — it exists
    res.status(replayed ? 200 : 201).json({ ...full, replayed });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Lost the insert race on client_key: the winner's round is the answer.
    if (clientKey && isUniqueViolation(err)) {
      const [existing] = await db
        .select()
        .from(rounds)
        .where(eq(rounds.clientKey, clientKey));
      if (existing) {
        const full = (await loadRound(db, existing.id))!;
        return res.json({ ...full, replayed: true });
      }
    }
    // Hand to Express's error middleware. Never `throw` from an async handler
    // — Express 4 doesn't catch those, and the unhandled rejection kills the
    // process (the transaction still rolls back, but the API goes down).
    next(err);
  }
});

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

// Name of the constraint a unique violation tripped, or null if the error
// isn't one. `round_entries` has two unique constraints and the caller needs
// to know which fired to say anything useful about it.
function uniqueViolationConstraint(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  return (err as { constraint_name?: string })?.constraint_name ?? "";
}

// How long a freshly minted join code stays valid. A round is an afternoon;
// 12 hours covers a late start and a long back nine without leaving a working
// code lying around for days.
const DEFAULT_CODE_HOURS = 12;

// Mint a join code that isn't already taken. The column is globally unique, but
// only unfinalized rounds hold a code and there is rarely more than one, so a
// clash is a ~1-in-280k event rather than something to design around. Retry
// rather than surface a 500 for it.
async function mintCode(expiresInHours: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const [clash] = await db
      .select({ id: rounds.id })
      .from(rounds)
      .where(eq(rounds.joinCode, code));
    if (!clash) {
      return {
        joinCode: code,
        codeExpiresAt: new Date(Date.now() + expiresInHours * 3600 * 1000),
      };
    }
  }
  throw new HttpError(500, "Could not allocate a round code");
}

function codeHours(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CODE_HOURS;
  return Math.min(n, 24 * 7); // cap: a code shouldn't outlive the season
}

// Create a round. Opens it for check-in with a join code by default — that's
// the live-round flow. Pass withCode: false for a round an admin will fill in
// themselves.
roundsAdminRouter.post("/", async (req, res, next) => {
  const date = String(req.body?.date ?? "").trim();
  if (!date) return res.status(400).json({ error: "date is required" });
  const course = req.body?.course ? String(req.body.course).trim() : null;
  const withCode = req.body?.withCode !== false;

  try {
    const code = withCode
      ? await mintCode(codeHours(req.body?.expiresInHours))
      : { joinCode: null, codeExpiresAt: null };
    const [created] = await db
      .insert(rounds)
      .values({
        date,
        course,
        createdBy: (req as typeof req & { adminEmail?: string }).adminEmail ?? null,
        ...code,
      })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Read back the current code. An admin who reloads the app mid-round needs the
// code again to read it out — it isn't in any public response.
roundsAdminRouter.get("/:id/code", async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db
    .select({
      joinCode: rounds.joinCode,
      codeExpiresAt: rounds.codeExpiresAt,
      status: rounds.status,
    })
    .from(rounds)
    .where(eq(rounds.id, id));
  if (!round) return res.status(404).json({ error: "Round not found" });
  res.json(round);
});

// Rotate or revoke the join code. Rotating cuts off anyone who has the old one
// (a code read out to the wrong group, say); revoking closes the round to
// player writes entirely without finalizing it.
//
// Known gap: this has the same read-then-write race `finalize` had, fixed
// there with `SELECT … FOR UPDATE`. Two concurrent rotations are near-harmless
// — last write wins and both callers end up holding a valid code — so it was
// left alone. Apply the same pattern here if that ever stops being true.
roundsAdminRouter.post("/:id/code", async (req, res, next) => {
  const id = Number(req.params.id);
  const action = String(req.body?.action ?? "rotate");
  if (action !== "rotate" && action !== "revoke") {
    return res.status(400).json({ error: "action must be rotate or revoke" });
  }

  try {
    const [round] = await db.select().from(rounds).where(eq(rounds.id, id));
    if (!round) return res.status(404).json({ error: "Round not found" });
    if (round.status === "finalized") {
      return res.status(409).json({ error: "Round is finalized" });
    }
    const next_ =
      action === "revoke"
        ? { joinCode: null, codeExpiresAt: null }
        : await mintCode(codeHours(req.body?.expiresInHours));
    const [updated] = await db
      .update(rounds)
      .set(next_)
      .where(eq(rounds.id, id))
      .returning({
        joinCode: rounds.joinCode,
        codeExpiresAt: rounds.codeExpiresAt,
        status: rounds.status,
      });
    res.json(updated);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Update a round (date, course, status).
roundsAdminRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const patch: Partial<typeof rounds.$inferInsert> = {};
  if (req.body?.date !== undefined) patch.date = String(req.body.date).trim();
  if (req.body?.course !== undefined)
    patch.course = req.body.course ? String(req.body.course).trim() : null;
  if (req.body?.status !== undefined) patch.status = req.body.status;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(rounds)
      .set(patch)
      .where(eq(rounds.id, id))
      .returning();
    // The date is this round's position in the event log, so correcting it can
    // move standings — a round moved from March to today now beats everything
    // in between. Course is inert.
    if (row && patch.date !== undefined) await replayTagHolders(tx);
    return row;
  });
  if (!updated) return res.status(404).json({ error: "Round not found" });
  res.json(updated);
});

// Delete a round (entries cascade). Replaying afterwards is what puts the tags
// back: with the round's assignments gone from the log, every tag it moved
// falls back to whatever the preceding events say.
roundsAdminRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx.delete(rounds).where(eq(rounds.id, id)).returning();
    if (row) await replayTagHolders(tx);
    return row;
  });
  if (!deleted) return res.status(404).json({ error: "Round not found" });
  res.status(204).end();
});

// Add a player entry to a round.
roundsAdminRouter.post("/:id/entries", async (req, res) => {
  const roundId = Number(req.params.id);
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
  if (!round) return res.status(404).json({ error: "Round not found" });
  if (round.status === "finalized")
    return res.status(409).json({ error: "Round is finalized" });

  const playerId = Number(req.body?.playerId);
  const incomingTagId = Number(req.body?.incomingTagId);
  if (!Number.isInteger(playerId) || !Number.isInteger(incomingTagId)) {
    return res
      .status(400)
      .json({ error: "playerId and incomingTagId are required" });
  }
  const acePool = Boolean(req.body?.acePool);
  const ctp = Boolean(req.body?.ctp);

  try {
    const [created] = await db
      .insert(roundEntries)
      .values({ roundId, playerId, incomingTagId, acePool, ctp })
      .returning();
    res.status(201).json(created);
  } catch {
    res
      .status(409)
      .json({ error: "Player already entered in this round" });
  }
});

// Update an entry (score, tag, pools).
roundsAdminRouter.patch("/:id/entries/:entryId", async (req, res) => {
  const roundId = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
  if (!round) return res.status(404).json({ error: "Round not found" });
  if (round.status === "finalized")
    return res.status(409).json({ error: "Round is finalized" });

  const patch: Partial<typeof roundEntries.$inferInsert> = {};
  if (req.body?.score !== undefined)
    patch.score = req.body.score === null ? null : Number(req.body.score);
  if (req.body?.incomingTagId !== undefined)
    patch.incomingTagId = Number(req.body.incomingTagId);
  if (req.body?.acePool !== undefined) patch.acePool = Boolean(req.body.acePool);
  if (req.body?.ctp !== undefined) patch.ctp = Boolean(req.body.ctp);

  const [updated] = await db
    .update(roundEntries)
    .set(patch)
    .where(
      and(eq(roundEntries.id, entryId), eq(roundEntries.roundId, roundId))
    )
    .returning();
  if (!updated) return res.status(404).json({ error: "Entry not found" });
  res.json(updated);
});

// Remove an entry. If it carried an assignment, replaying drops that from the
// log and the tag falls back to its prior event — the rest of the round's
// assignments stand, since they're recorded per entry.
roundsAdminRouter.delete("/:id/entries/:entryId", async (req, res) => {
  const roundId = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(roundEntries)
      .where(
        and(eq(roundEntries.id, entryId), eq(roundEntries.roundId, roundId))
      )
      .returning();
    if (row && row.assignedTagId !== null) await replayTagHolders(tx);
    return row;
  });
  if (!deleted) return res.status(404).json({ error: "Entry not found" });
  res.status(204).end();
});

// Compute tag assignments and permanently lock the round.
// Ranking (ported from index.html): lowest score gets the lowest incoming
// tag from the pool; ties broken by lower incoming tag; DNFs (no score)
// ranked last, ordered among themselves by incoming tag.
roundsAdminRouter.post("/:id/finalize", async (req, res, next) => {
  const roundId = Number(req.params.id);

  try {
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE is what makes this idempotent under concurrency, not the
      // transaction. Three finalize requests land together (an admin
      // double-tapping on a flaky course connection); with a plain SELECT all
      // three read status='open' from their own READ COMMITTED snapshots, all
      // pass the guard, and all redistribute — the tag pool gets shuffled
      // three times and standings are silently wrong. The row lock makes the
      // others block here until the first commits; READ COMMITTED then
      // re-reads the fresh row, they see 'finalized', and they 409.
      const [round] = await tx
        .select()
        .from(rounds)
        .where(eq(rounds.id, roundId))
        .for("update");
      if (!round) throw new HttpError(404, "Round not found");
      if (round.status === "finalized")
        throw new HttpError(409, "Round is already finalized");

      const entries = await tx
        .select({
          id: roundEntries.id,
          playerId: roundEntries.playerId,
          incomingTagId: roundEntries.incomingTagId,
          score: roundEntries.score,
          tagNumber: tags.number,
        })
        .from(roundEntries)
        .innerJoin(tags, eq(roundEntries.incomingTagId, tags.id))
        .where(eq(roundEntries.roundId, roundId));

      if (entries.length === 0)
        throw new HttpError(400, "Round has no entries");

      // Same ranking + pool redistribution as the one-shot endpoint.
      const assignments = assignTags(entries);
      const tagIdByNumber = new Map(entries.map((e) => [e.tagNumber, e.incomingTagId]));

      // Snapshot each assignment on its entry. This is the durable record —
      // tag_holders is rebuilt from it below, and from every other finalized
      // round, in round-DATE order.
      for (const { entry, assignedNumber } of assignments) {
        await tx
          .update(roundEntries)
          .set({ assignedTagId: tagIdByNumber.get(assignedNumber)! })
          .where(eq(roundEntries.id, entry.id));
      }

      await replayTagHolders(tx);

      // Clearing the code is what actually ends player write access: the gate
      // refuses a round with no code, and the number returns to the pool for
      // a future round. Status alone would do it too — belt and braces.
      const [finalized] = await tx
        .update(rounds)
        .set({ status: "finalized", joinCode: null, codeExpiresAt: null })
        .where(eq(rounds.id, roundId))
        .returning({
          id: rounds.id,
          date: rounds.date,
          course: rounds.course,
          status: rounds.status,
        });

      const finalEntries = await tx
        .select()
        .from(roundEntries)
        .where(eq(roundEntries.roundId, roundId));

      return { ...finalized, entries: finalEntries };
    });

    res.json(result);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    next(err); // never throw from an async handler — see /complete above
  }
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
