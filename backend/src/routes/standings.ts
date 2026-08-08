import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tagHolders, tags, players } from "../db/schema.js";

// Public read route, mounted at /standings. Current tag leaderboard: who
// holds each tag right now, joined to tag numbers and player names, ordered by
// tag number ascending. tag_holders is derived — see lib/tagHolders.ts — so
// this reflects the whole event log in date order, not just the last write.
export const standingsRouter = Router();

standingsRouter.get("/", async (_req, res) => {
  const rows = await db
    .select({
      tagId: tags.id,
      tagNumber: tags.number,
      playerId: players.id,
      playerName: players.name,
      since: tagHolders.since,
    })
    .from(tagHolders)
    .innerJoin(tags, eq(tagHolders.tagId, tags.id))
    .innerJoin(players, eq(tagHolders.playerId, players.id))
    .orderBy(tags.number);
  res.json(rows);
});
