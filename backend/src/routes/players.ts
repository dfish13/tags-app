import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { players, tags, tagHolders, tagAdjustments } from "../db/schema.js";
import { lockTagHolders, replayTagHolders } from "../lib/tagHolders.js";

// An admin tag change is an event in the log, not a direct write to
// tag_holders. Dated rather than sticky on purpose: a permanent override would
// freeze a player's tag through every round they went on to play.
//
// Which date depends on what the admin is saying, and the two routes here say
// different things:
//
// - Changing an existing player's tag is a CORRECTION of what they hold now,
//   so it's dated today and beats every round dated today or earlier — the
//   same visible result as the direct write it replaces.
// - Issuing a tag to a NEW player is a BASELINE, not a correction. It's the
//   floor of what we know about them, so it's dated at the beginning of time
//   and loses to every round they play. Dating it today would break the two
//   commonest flows: adding a player at the tee and then finalizing that
//   afternoon's round, and adding a player while backfilling old rounds. In
//   both, the round is the real answer and a today-dated baseline would
//   silently beat it.
const BEGINNING_OF_TIME = "1970-01-01";

// en-CA formats as YYYY-MM-DD. Local, not toISOString(): round dates are the
// calendar dates an admin typed, so an evening tag change has to sort as today
// and not as tomorrow's UTC date.
function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

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
// required and recorded as a tag adjustment — the event that explains a tag no
// round accounts for. tag_holders then follows from the log.
playersAdminRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const tagNumber = Number(req.body?.tagNumber);
  // Opt-in: issue the tag even though another player is recorded as holding it,
  // leaving that player tagless — the same "take the tag" semantics as
  // PATCH /:id/tag, and for the same reason (a displaced holder's real tag is
  // genuinely unknown). Off by default so a mistyped number in the Admin tab's
  // roster form still bounces; the mid-round check-in flow names the holder,
  // asks, and only then retries with it set.
  const takeTag = Boolean(req.body?.takeTag);
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

      // One player per tag. Who holds it now decides whether this is a typo to
      // bounce or a tag being recycled to someone new — `heldBy` is what lets
      // the caller ask that question instead of just reporting a dead end.
      const [held] = await tx
        .select({ playerId: tagHolders.playerId, holderName: players.name })
        .from(tagHolders)
        .innerJoin(players, eq(players.id, tagHolders.playerId))
        .where(eq(tagHolders.tagId, tag.id));
      if (held && !takeTag) {
        throw new HttpError(
          409,
          `Tag #${tagNumber} is already held by ${held.holderName}`,
          { heldBy: { id: held.playerId, name: held.holderName } }
        );
      }

      const [player] = await tx.insert(players).values({ name }).returning();
      await tx.insert(tagAdjustments).values({
        playerId: player.id,
        tagId: tag.id,
        effectiveDate: BEGINNING_OF_TIME,
        note: "Issued when the player was added to the roster",
      });
      await replayTagHolders(tx);
      // `displaced` so the caller can say who just lost their tag — silently
      // unassigning someone is exactly the surprise this flow exists to avoid.
      return { ...player, tagNumber, displaced: held?.holderName ?? null };
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message, ...err.extra });
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

      // Recorded as an event dated today rather than written straight to
      // tag_holders. Replaying it releases this player's current tag and takes
      // the target one, displacing its previous holder — the same outcome as
      // the direct write it replaces, now survivable across later replays.
      await tx.insert(tagAdjustments).values({
        playerId: id,
        tagId: tag.id,
        effectiveDate: today(),
        note: "Tag set by hand from the roster",
      });
      await replayTagHolders(tx);
      return { ...player, tagNumber };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Delete a player. Their adjustments go with them (FK cascade), so the replay
// below sees a log that no longer mentions them and their tag returns to
// whoever the remaining events say — usually nobody. The tag_holders row has
// to be cleared by hand first: that FK has no cascade, so it would block the
// delete. A player with finalized round history can't be deleted at all — the
// round_entries FK blocks it (409), which is the desired behavior since past
// results reference them.
playersAdminRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const deleted = await db.transaction(async (tx) => {
      // Before the delete below, not after: holding a tag_holders row lock
      // while waiting on the replay lock deadlocks against a replay that
      // already holds it. replayTagHolders re-takes it for free.
      await lockTagHolders(tx);
      await tx.delete(tagHolders).where(eq(tagHolders.playerId, id));
      const [player] = await tx
        .delete(players)
        .where(eq(players.id, id))
        .returning();
      if (player) await replayTagHolders(tx);
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
  constructor(
    public status: number,
    message: string,
    // Merged into the JSON body alongside `error`, for a failure the client
    // has to act on rather than just display.
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}
