import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tagHolders, tags, players } from "../db/schema.js";

// Public read route, mounted at /standings. Current tag leaderboard: who
// holds each tag right now (from tag_holders, updated on round finalize),
// joined to tag numbers and player names, ordered by tag number ascending.
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
