import { Router } from "express";
import { eq, and, asc, gte, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import {
  rounds,
  roundEntries,
  tags,
  players,
  tagHolders,
} from "../db/schema.js";

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

// ── Individual player stats ──────────────────────────────
//
// Per-round facts for one player, over finalized rounds only. The SUMMARY
// (best tag, averages, attendance rate) is deliberately NOT computed here —
// the client derives it from `rounds`. What lives server-side is the part that
// needs the whole field and is worth testing: finish rank and the field
// average. Mean-of-an-array is not.

// Competition ranking, ties sharing the best place: 1, 2, 2, 4. Scores are
// ascending — disc golf, low is good.
function finishPlace(scores: number[], mine: number): number {
  return 1 + scores.filter((s) => s < mine).length;
}

// The field average EXCLUDING the player, which is the whole point: in a
// six-person field, counting yourself damps your own differential by ~17%.
// Null below two scorers — there is no field to compare against.
function fieldAverage(scores: number[], mine: number): number | null {
  if (scores.length < 2) return null;
  const sum = scores.reduce((a, b) => a + b, 0);
  return (sum - mine) / (scores.length - 1);
}

// 1st of 12 and 1st of 30 both read 100; last reads 0. That comparability is
// why the page headlines percentile and leaves raw place to the table, where
// the field size is visible beside it.
function percentile(place: number, size: number): number | null {
  if (size < 2) return null;
  return Math.round(((size - place) / (size - 1)) * 100);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

statsRouter.get("/player/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: "No such player" });
  }

  const [player] = await db
    .select({ id: players.id, name: players.name })
    .from(players)
    .where(eq(players.id, id));
  // 404 is for a player who does not exist. A real player with no finalized
  // rounds is a 200 with an empty list — "hasn't played yet" is a state the
  // page renders, not an error.
  if (!player) return res.status(404).json({ error: "No such player" });

  const [current] = await db
    .select({ tagNumber: tags.number, since: tagHolders.since })
    .from(tagHolders)
    .innerJoin(tags, eq(tags.id, tagHolders.tagId))
    .where(eq(tagHolders.playerId, id));

  // Two aliases because a round entry references the tag table twice — the tag
  // carried in and the tag won.
  const inTag = alias(tags, "in_tag");
  const outTag = alias(tags, "out_tag");

  // Oldest first here; reversed for the response. The ascending order is what
  // makes rows[0].date the player's first round, which the attendance
  // denominator below needs.
  const mine = await db
    .select({
      roundId: rounds.id,
      date: rounds.date,
      course: rounds.course,
      incomingTag: inTag.number,
      assignedTag: outTag.number,
      score: roundEntries.score,
      ctp: roundEntries.ctp,
      acePool: roundEntries.acePool,
    })
    .from(roundEntries)
    .innerJoin(rounds, eq(roundEntries.roundId, rounds.id))
    .innerJoin(inTag, eq(inTag.id, roundEntries.incomingTagId))
    // LEFT, unlike /tag-history: a finalized round always has an assigned tag,
    // so an inner join here would silently drop a row rather than show the gap.
    .leftJoin(outTag, eq(outTag.id, roundEntries.assignedTagId))
    .where(and(eq(roundEntries.playerId, id), eq(rounds.status, "finalized")))
    .orderBy(asc(rounds.date), asc(rounds.id));

  // Every score in the rounds this player appeared in — one query, not one per
  // round. DNFs (null score) are dropped: they rank nobody and skew no average.
  const byRound = new Map<number, number[]>();
  if (mine.length) {
    const field = await db
      .select({ roundId: roundEntries.roundId, score: roundEntries.score })
      .from(roundEntries)
      .where(
        inArray(
          roundEntries.roundId,
          mine.map((r) => r.roundId)
        )
      );
    for (const e of field) {
      if (e.score === null) continue;
      const arr = byRound.get(e.roundId);
      if (arr) arr.push(e.score);
      else byRound.set(e.roundId, [e.score]);
    }
  }

  const rows = mine.map((r) => {
    const scores = byRound.get(r.roundId) ?? [];
    // A DNF keeps its tag columns — not finishing still redistributes a tag —
    // and nulls everything score-derived.
    if (r.score === null) {
      return {
        ...r,
        fieldAvg: null,
        diff: null,
        finish: null,
        fieldSize: scores.length,
        percentile: null,
      };
    }
    const place = finishPlace(scores, r.score);
    const avg = fieldAverage(scores, r.score);
    return {
      ...r,
      fieldAvg: avg === null ? null : round2(avg),
      diff: avg === null ? null : round2(r.score - avg),
      finish: place,
      fieldSize: scores.length,
      percentile: percentile(place, scores.length),
    };
  });

  // Attendance denominator: finalized rounds from this player's FIRST round
  // onward. Someone who joined in August is not charged for missing June.
  let roundsAvailable = 0;
  if (mine.length) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rounds)
      .where(
        and(eq(rounds.status, "finalized"), gte(rounds.date, mine[0].date))
      );
    roundsAvailable = row?.n ?? 0;
  }

  res.json({
    player,
    current: current ?? null,
    context: { roundsAvailable },
    rounds: rows.reverse(), // newest first — the order the page reads in
  });
});
