import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tags } from "../db/schema.js";

const STATUSES = ["active", "lost", "retired"] as const;
type TagStatus = (typeof STATUSES)[number];

// Public read routes, mounted at /tags.
export const tagsRouter = Router();

// List all tags, ordered by number.
tagsRouter.get("/", async (_req, res) => {
  const all = await db.select().from(tags).orderBy(tags.number);
  res.json(all);
});

// Get one tag.
tagsRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [tag] = await db.select().from(tags).where(eq(tags.id, id));
  if (!tag) return res.status(404).json({ error: "Tag not found" });
  res.json(tag);
});

// Admin write routes, mounted at /admin/tags (behind requireAdmin).
export const tagsAdminRouter = Router();

// Create a tag.
tagsAdminRouter.post("/", async (req, res) => {
  const number = Number(req.body?.number);
  if (!Number.isInteger(number) || number < 1 || number > 300) {
    return res.status(400).json({ error: "number must be an integer 1–300" });
  }
  try {
    const [created] = await db.insert(tags).values({ number }).returning();
    res.status(201).json(created);
  } catch {
    res.status(409).json({ error: `Tag #${number} already exists` });
  }
});

// Update a tag's status.
tagsAdminRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status as TagStatus;
  if (!STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `status must be one of: ${STATUSES.join(", ")}` });
  }
  const [updated] = await db
    .update(tags)
    .set({ status })
    .where(eq(tags.id, id))
    .returning();
  if (!updated) return res.status(404).json({ error: "Tag not found" });
  res.json(updated);
});

// Delete a tag.
tagsAdminRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [deleted] = await db.delete(tags).where(eq(tags.id, id)).returning();
  if (!deleted) return res.status(404).json({ error: "Tag not found" });
  res.status(204).end();
});
