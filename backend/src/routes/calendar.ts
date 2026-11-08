import { Router, type Request, type Response, type NextFunction } from "express";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { calendarEvents } from "../db/schema.js";
import { isClockTime, isIsoDate, isoDaysFromToday, optionalText } from "../lib/validate.js";

// The league calendar — planned rounds and other dates. Reads are public;
// writes are admin-only under /admin/calendar. See calendarEvents in schema.ts
// for why this is not the rounds table.

const LIMITS = { title: 80, course: 100, notes: 500 };

const publicColumns = {
  id: calendarEvents.id,
  date: calendarEvents.date,
  startTime: calendarEvents.startTime,
  title: calendarEvents.title,
  course: calendarEvents.course,
  notes: calendarEvents.notes,
};

// Public read routes, mounted at /calendar.
export const calendarRouter = Router();

// Upcoming events, soonest first; events with no time sort after timed ones on
// the same day.
//
// `from` should be the CALLER's local date — the server is on UTC, so its own
// "today" ticks over at 5 or 6pm in Colorado and would drop tonight's event
// while it's still tonight. Without one, the default reaches back a day so the
// same thing can't happen to a client that didn't send it.
calendarRouter.get("/", async (req, res, next) => {
  try {
    const from = req.query.from ?? isoDaysFromToday(-1);
    const to = req.query.to;
    if (!isIsoDate(from)) {
      return res.status(400).json({ error: "from must be a date (YYYY-MM-DD)" });
    }
    if (to !== undefined && !isIsoDate(to)) {
      return res.status(400).json({ error: "to must be a date (YYYY-MM-DD)" });
    }
    const where = to
      ? and(gte(calendarEvents.date, from), lte(calendarEvents.date, to))
      : gte(calendarEvents.date, from);
    const rows = await db
      .select(publicColumns)
      .from(calendarEvents)
      .where(where)
      .orderBy(
        asc(calendarEvents.date),
        sql`${calendarEvents.startTime} asc nulls last`,
        asc(calendarEvents.id)
      );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Admin write routes, mounted at /admin/calendar (behind requireAdmin).
export const calendarAdminRouter = Router();

type EventFields = {
  date?: string;
  startTime?: string | null;
  title?: string | null;
  course?: string | null;
  notes?: string | null;
};

// Validates whichever fields are present. `requireDate` is the difference
// between create (date mandatory) and edit (anything may be omitted).
function parseEvent(
  body: any,
  requireDate: boolean
): { fields: EventFields } | { error: string } {
  const fields: EventFields = {};
  if (body?.date !== undefined || requireDate) {
    if (!isIsoDate(body?.date)) return { error: "date is required (YYYY-MM-DD)" };
    fields.date = body.date;
  }
  if (body?.startTime !== undefined) {
    const t = body.startTime;
    if (t === null || t === "") fields.startTime = null;
    else if (isClockTime(t)) fields.startTime = t;
    else return { error: "startTime must be HH:MM (24-hour)" };
  }
  for (const key of ["title", "course", "notes"] as const) {
    const r = optionalText(body?.[key], LIMITS[key], key);
    if ("error" in r) return { error: r.error };
    if (r.value !== undefined) fields[key] = r.value;
  }
  return { fields };
}

calendarAdminRouter.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = parseEvent(req.body, true);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const [created] = await db
      .insert(calendarEvents)
      .values({ ...parsed.fields, date: parsed.fields.date! })
      .returning(publicColumns);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

calendarAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Event not found" });
    const parsed = parseEvent(req.body, false);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    if (!Object.keys(parsed.fields).length) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    const [updated] = await db
      .update(calendarEvents)
      .set({ ...parsed.fields, updatedAt: new Date() })
      .where(eq(calendarEvents.id, id))
      .returning(publicColumns);
    if (!updated) return res.status(404).json({ error: "Event not found" });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

calendarAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Event not found" });
    const [deleted] = await db
      .delete(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .returning({ id: calendarEvents.id });
    if (!deleted) return res.status(404).json({ error: "Event not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
