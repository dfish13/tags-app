import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { players, tags, tagHolders } from "../db/schema.js";

// Public read routes, mounted at /players.
export const playersRouter = Router();

// List all players with their current tag number (from tag_holders), if any.
playersRouter.get("/", async (_req, res) => {
  const all = await db
    .select({
      id: players.id,
      name: players.name,
      createdAt: players.createdAt,
      tagNumber: tags.number,
    })
    .from(players)
    .leftJoin(tagHolders, eq(tagHolders.playerId, players.id))
    .leftJoin(tags, eq(tags.id, tagHolders.tagId))
    .orderBy(players.name);
  res.json(all);
});

// Get one player.
playersRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [player] = await db.select().from(players).where(eq(players.id, id));
  if (!player) return res.status(404).json({ error: "Player not found" });
  res.json(player);
});

// Admin write routes, mounted at /admin/players (behind requireAdmin).
export const playersAdminRouter = Router();

// Create a player and assign their current tag. Every player always has a
// known tag (their existing one, or a newly issued number), so tagNumber is
// required and recorded in tag_holders — the single source of truth for
// current tag ownership (same table round finalize updates).
playersAdminRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const tagNumber = Number(req.body?.tagNumber);
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!Number.isInteger(tagNumber) || tagNumber < 1 || tagNumber > 300) {
    return res
      .status(400)
      .json({ error: "tagNumber must be an integer 1–300" });
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [tag] = await tx.select().from(tags).where(eq(tags.number, tagNumber));
      if (!tag) throw new HttpError(400, `Tag #${tagNumber} does not exist`);

      // Enforce one-player-per-tag: reject if already held.
      const [held] = await tx
        .select({ playerId: tagHolders.playerId, holderName: players.name })
        .from(tagHolders)
        .innerJoin(players, eq(players.id, tagHolders.playerId))
        .where(eq(tagHolders.tagId, tag.id));
      if (held) {
        throw new HttpError(
          409,
          `Tag #${tagNumber} is already held by ${held.holderName}`
        );
      }

      const [player] = await tx.insert(players).values({ name }).returning();
      await tx
        .insert(tagHolders)
        .values({ tagId: tag.id, playerId: player.id });
      return { ...player, tagNumber };
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Update a player.
playersAdminRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const [updated] = await db
    .update(players)
    .set({ name })
    .where(eq(players.id, id))
    .returning();
  if (!updated) return res.status(404).json({ error: "Player not found" });
  res.json(updated);
});

// Change a player's current tag. "Take the tag" semantics: if another player
// already holds it, the tag moves to this player and the previous holder is
// left tagless. We deliberately do NOT swap tags: in an untracked multi-player
// round tags can permutate arbitrarily, so a displaced holder's new tag is
// genuinely unknown — leaving them tagless honestly represents that until they
// declare a tag later. This differs from add-player, which rejects on conflict.
playersAdminRouter.patch("/:id/tag", async (req, res) => {
  const id = Number(req.params.id);
  const tagNumber = Number(req.body?.tagNumber);
  if (!Number.isInteger(tagNumber) || tagNumber < 1 || tagNumber > 300) {
    return res
      .status(400)
      .json({ error: "tagNumber must be an integer 1–300" });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, id));
      if (!player) throw new HttpError(404, "Player not found");

      const [tag] = await tx.select().from(tags).where(eq(tags.number, tagNumber));
      if (!tag) throw new HttpError(400, `Tag #${tagNumber} does not exist`);

      // Release this player's current tag (if any), then take the target tag,
      // displacing its previous holder.
      await tx.delete(tagHolders).where(eq(tagHolders.playerId, id));
      await tx
        .insert(tagHolders)
        .values({ tagId: tag.id, playerId: id })
        .onConflictDoUpdate({
          target: tagHolders.tagId,
          set: { playerId: id, since: new Date() },
        });
      return { ...player, tagNumber };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Delete a player. Their current tag holding is released first (the
// tag_holders FK has no cascade). A player with finalized round history
// can't be deleted — the round_entries FK will block it (409), which is the
// desired behavior since past results reference them.
playersAdminRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const deleted = await db.transaction(async (tx) => {
      await tx.delete(tagHolders).where(eq(tagHolders.playerId, id));
      const [player] = await tx
        .delete(players)
        .where(eq(players.id, id))
        .returning();
      return player;
    });
    if (!deleted) return res.status(404).json({ error: "Player not found" });
    res.status(204).end();
  } catch {
    res.status(409).json({
      error: "Cannot delete a player who has round history.",
    });
  }
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
