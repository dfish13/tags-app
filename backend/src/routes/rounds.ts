import { Router } from "express";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { rounds, roundEntries, tags, tagHolders, players } from "../db/schema.js";

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

// Get one round with its entries, enriched with player names and tag numbers
// (incoming + assigned) so clients can display it without extra lookups.
roundsRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(rounds).where(eq(rounds.id, id));
  if (!round) return res.status(404).json({ error: "Round not found" });

  const incoming = alias(tags, "incoming_tag");
  const assigned = alias(tags, "assigned_tag");
  const entries = await db
    .select({
      id: roundEntries.id,
      playerId: roundEntries.playerId,
      playerName: players.name,
      score: roundEntries.score,
      acePool: roundEntries.acePool,
      ctp: roundEntries.ctp,
      incomingNumber: incoming.number,
      assignedNumber: assigned.number,
    })
    .from(roundEntries)
    .innerJoin(players, eq(players.id, roundEntries.playerId))
    .leftJoin(incoming, eq(incoming.id, roundEntries.incomingTagId))
    .leftJoin(assigned, eq(assigned.id, roundEntries.assignedTagId))
    .where(eq(roundEntries.roundId, id));
  res.json({ ...round, entries });
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

// Load a round with entries enriched for display (names + tag numbers).
async function loadRound(tx: typeof db, roundId: number) {
  const [round] = await tx.select().from(rounds).where(eq(rounds.id, roundId));
  const incoming = alias(tags, "incoming_tag");
  const assigned = alias(tags, "assigned_tag");
  const entries = await tx
    .select({
      id: roundEntries.id,
      playerId: roundEntries.playerId,
      playerName: players.name,
      score: roundEntries.score,
      acePool: roundEntries.acePool,
      ctp: roundEntries.ctp,
      incomingNumber: incoming.number,
      assignedNumber: assigned.number,
    })
    .from(roundEntries)
    .innerJoin(players, eq(players.id, roundEntries.playerId))
    .leftJoin(incoming, eq(incoming.id, roundEntries.incomingTagId))
    .leftJoin(assigned, eq(assigned.id, roundEntries.assignedTagId))
    .where(eq(roundEntries.roundId, roundId));
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

      const now = new Date();
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

      // Release every participant's current holding first, then take the new
      // ones — same invariant as the step-by-step finalize (one tag each).
      await tx.delete(tagHolders).where(inArray(tagHolders.playerId, playerIds));
      for (const { entry, assignedNumber } of assignments) {
        await tx
          .insert(tagHolders)
          .values({
            tagId: tagIdByNumber.get(assignedNumber)!,
            playerId: entry.playerId,
            since: now,
          })
          .onConflictDoUpdate({
            target: tagHolders.tagId,
            set: { playerId: entry.playerId, since: now },
          });
      }

      return { roundId: round.id, replayed: false };
    });

    const full = await loadRound(db, roundId);
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
        const full = await loadRound(db, existing.id);
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

// Create a round.
roundsAdminRouter.post("/", async (req, res) => {
  const date = String(req.body?.date ?? "").trim();
  if (!date) return res.status(400).json({ error: "date is required" });
  const course = req.body?.course ? String(req.body.course).trim() : null;
  const [created] = await db
    .insert(rounds)
    .values({ date, course })
    .returning();
  res.status(201).json(created);
});

// Update a round (date, course, status).
roundsAdminRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const patch: Partial<typeof rounds.$inferInsert> = {};
  if (req.body?.date !== undefined) patch.date = String(req.body.date).trim();
  if (req.body?.course !== undefined)
    patch.course = req.body.course ? String(req.body.course).trim() : null;
  if (req.body?.status !== undefined) patch.status = req.body.status;
  const [updated] = await db
    .update(rounds)
    .set(patch)
    .where(eq(rounds.id, id))
    .returning();
  if (!updated) return res.status(404).json({ error: "Round not found" });
  res.json(updated);
});

// Delete a round (entries cascade).
roundsAdminRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [deleted] = await db
    .delete(rounds)
    .where(eq(rounds.id, id))
    .returning();
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

// Remove an entry.
roundsAdminRouter.delete("/:id/entries/:entryId", async (req, res) => {
  const roundId = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  const [deleted] = await db
    .delete(roundEntries)
    .where(
      and(eq(roundEntries.id, entryId), eq(roundEntries.roundId, roundId))
    )
    .returning();
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
      const [round] = await tx
        .select()
        .from(rounds)
        .where(eq(rounds.id, roundId));
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

      const now = new Date();

      // Release every participating player's current tag holding(s) first, so
      // that after reassignment each player holds exactly one tag. Without
      // this, a player's pre-round tag can linger if it isn't part of this
      // round's redistributed pool, leaving them holding two tags.
      const participantIds = assignments.map((a) => a.entry.playerId);
      await tx
        .delete(tagHolders)
        .where(inArray(tagHolders.playerId, participantIds));

      for (const { entry, assignedNumber } of assignments) {
        const assignedTagId = tagIdByNumber.get(assignedNumber)!;

        // Snapshot the assignment on the entry.
        await tx
          .update(roundEntries)
          .set({ assignedTagId })
          .where(eq(roundEntries.id, entry.id));

        // Set the current tag holder. onConflict covers a tag previously held
        // by a NON-participant (whose row we didn't just delete).
        await tx
          .insert(tagHolders)
          .values({ tagId: assignedTagId, playerId: entry.playerId, since: now })
          .onConflictDoUpdate({
            target: tagHolders.tagId,
            set: { playerId: entry.playerId, since: now },
          });
      }

      const [finalized] = await tx
        .update(rounds)
        .set({ status: "finalized" })
        .where(eq(rounds.id, roundId))
        .returning();

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
