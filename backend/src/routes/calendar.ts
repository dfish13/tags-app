import { Router, type Request, type Response, type NextFunction } from "express";
import { and, asc, desc, eq, gte, lte, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { calendarEvents, rounds } from "../db/schema.js";
import { isClockTime, isIsoDate, isoDaysFromToday, optionalText } from "../lib/validate.js";
import { insertLiveRound } from "./rounds.js";

// The league calendar — planned rounds and other dates. Reads are public;
// writes are admin-only under /admin/calendar. See calendarEvents in schema.ts
// for why this is not the rounds table.
//
// An admin can START a round from an entry (POST /admin/calendar/:id/start),
// which opens a live round from its date and course and links the two. From
// then on the ROUND owns the date and course: they decide where the round sits
// in the tag history, so the calendar refuses to edit them and edits made under
// Admin → Rounds are copied back here (see the PATCH in rounds.ts). Time,
// title and notes stay the calendar's own.

const LIMITS = { title: 80, course: 100, notes: 500 };

// Serializes Start. The "is another round still in progress?" check is a read
// followed by a write, so two entries started at the same moment would both
// pass it without this. Any fixed bigint; distinct from tagHolders' key.
const START_LOCK_KEY = 8_147_320_155_302;

// What a calendar response carries. The linked round is reported by state
// only — id, status, and whether players can currently join — and NEVER its
// join code, which lives on the same row. Built column by column for the same
// reason roundPublicColumns is.
const eventColumns = {
  id: calendarEvents.id,
  date: calendarEvents.date,
  startTime: calendarEvents.startTime,
  title: calendarEvents.title,
  course: calendarEvents.course,
  notes: calendarEvents.notes,
  tagsRound: calendarEvents.tagsRound,
  roundId: calendarEvents.roundId,
  roundStatus: rounds.status,
  roundJoinable: sql<boolean | null>`(${rounds.joinCode} is not null)`,
};

type EventRow = {
  id: number;
  date: string;
  startTime: string | null;
  title: string | null;
  course: string | null;
  notes: string | null;
  tagsRound: boolean;
  roundId: number | null;
  roundStatus: string | null;
  roundJoinable: boolean | null;
};

// Flatten the join into `round: {id, status, joinable} | null`.
function shape(r: EventRow) {
  const { roundId, roundStatus, roundJoinable, ...ev } = r;
  return {
    ...ev,
    round:
      roundId === null
        ? null
        : { id: roundId, status: roundStatus, joinable: !!roundJoinable },
  };
}

async function selectEvents(where: SQL | undefined) {
  const rows = await db
    .select(eventColumns)
    .from(calendarEvents)
    .leftJoin(rounds, eq(calendarEvents.roundId, rounds.id))
    .where(where)
    .orderBy(
      asc(calendarEvents.date),
      sql`${calendarEvents.startTime} asc nulls last`,
      asc(calendarEvents.id)
    );
  return (rows as EventRow[]).map(shape);
}

async function selectEvent(id: number) {
  const [ev] = await selectEvents(eq(calendarEvents.id, id));
  return ev ?? null;
}

// 'YYYY-MM-DD' → 'Nov 8', for messages an admin reads. Sliced, not parsed,
// so no timezone can shift it.
function shortDate(d: string) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

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
    res.json(await selectEvents(where));
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
  tagsRound?: boolean;
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
  if (body?.tagsRound !== undefined) {
    if (typeof body.tagsRound !== "boolean") return { error: "tagsRound must be true or false" };
    fields.tagsRound = body.tagsRound;
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
      .returning({ id: calendarEvents.id });
    res.status(201).json(await selectEvent(created.id));
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
    const f = parsed.fields;
    if (!Object.keys(f).length) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    const [current] = await db
      .select({ roundId: calendarEvents.roundId })
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id));
    if (!current) return res.status(404).json({ error: "Event not found" });
    // Started: the round owns these. Editing them here would either be a lie
    // the round doesn't know about or — for the date — a silent move in the
    // tag history, so the change has to go through the round instead.
    if (
      current.roundId !== null &&
      (f.date !== undefined || f.course !== undefined || f.tagsRound !== undefined)
    ) {
      return res.status(409).json({
        error:
          "This round has started, so its date and course belong to the round — change them under Admin → Rounds.",
        roundId: current.roundId,
      });
    }
    await db
      .update(calendarEvents)
      .set({ ...f, updatedAt: new Date() })
      .where(eq(calendarEvents.id, id));
    res.json(await selectEvent(id));
  } catch (err) {
    next(err);
  }
});

// Deleting an entry never touches its round: the round is history, and
// standings are replayed from it. The calendar just stops announcing it.
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

// Start the round this entry announces: open a live round from its date and
// course, exactly as Admin's "Open round" would, and link the two. Refused when:
//
//   - it's already started (one round per entry — a double tap lands here);
//   - it isn't a tags round (finalizing one would move tags);
//   - it isn't the day. The browser only offers Start on the entry's own date,
//     judged by the phone; the server can't know the league's timezone, so it
//     only refuses dates more than a day from its own UTC today. That still
//     stops the real problem: a join code expires 12 hours after it is minted,
//     so a round opened the night before would lock players out mid-round;
//   - another round is still in progress. Admin's live card, and every phone,
//     manage one round at a time, so a second one would be unmanageable.
//
// Responds with the new round — including its join code, as POST /admin/rounds
// does — so the admin can go straight to reading it out.
calendarAdminRouter.post("/:id/start", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Event not found" });
    const createdBy = (req as Request & { adminEmail?: string }).adminEmail ?? null;

    const round = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${START_LOCK_KEY})`);
      const [ev] = await tx
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, id))
        .for("update");
      if (!ev) throw new HttpError(404, "Event not found");
      if (ev.roundId !== null) {
        throw new HttpError(409, "This round has already been started.", {
          roundId: ev.roundId,
        });
      }
      if (!ev.tagsRound) {
        throw new HttpError(409, "This date isn't a tags round, so there's no round to start.");
      }
      if (ev.date < isoDaysFromToday(-1) || ev.date > isoDaysFromToday(1)) {
        throw new HttpError(409, "A round can only be started on the day it's scheduled.");
      }
      const [open] = await tx
        .select({ id: rounds.id, date: rounds.date, course: rounds.course })
        .from(rounds)
        .where(ne(rounds.status, "finalized"))
        .orderBy(desc(rounds.id))
        .limit(1);
      if (open) {
        throw new HttpError(
          409,
          `Another round is still in progress (${shortDate(open.date)}${
            open.course ? " at " + open.course : ""
          }). Finalize or delete it under Admin first.`,
          { openRound: open }
        );
      }
      const created = await insertLiveRound(tx, {
        date: ev.date,
        course: ev.course,
        createdBy,
      });
      await tx
        .update(calendarEvents)
        .set({ roundId: created.id, updatedAt: new Date() })
        .where(eq(calendarEvents.id, id));
      return created;
    });
    res.status(201).json(round);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    next(err);
  }
});
