import { Router } from "express";
import { eq, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { rounds, roundEntries, tags, players } from "../db/schema.js";

// Public read routes, mounted at /stats. Aggregates over finalized rounds
// for the Stats page visualizations.
export const statsRouter = Router();

// Tag movement history: every finalized round (ordered by date) plus each
// entry's assigned tag number, joined to player names. The frontend groups
// entries by player to draw one line per player over time. Entries whose
// round predates finalization (assignedTagId null) can't match the inner
// join and are naturally excluded.
statsRouter.get("/tag-history", async (_req, res) => {
  const finalized = await db
    .select({ id: rounds.id, date: rounds.date, course: rounds.course })
    .from(rounds)
    .where(eq(rounds.status, "finalized"))
    .orderBy(asc(rounds.date), asc(rounds.id));

  const entries = await db
    .select({
      roundId: roundEntries.roundId,
      playerId: roundEntries.playerId,
      playerName: players.name,
      tagNumber: tags.number,
    })
    .from(roundEntries)
    .innerJoin(rounds, eq(roundEntries.roundId, rounds.id))
    .innerJoin(players, eq(players.id, roundEntries.playerId))
    .innerJoin(tags, eq(tags.id, roundEntries.assignedTagId))
    .where(eq(rounds.status, "finalized"));

  res.json({ rounds: finalized, entries });
});
