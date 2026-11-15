import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// League roster. Players persist across rounds.
export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// The pool of physical tag numbers (1–300) the league distributes.
export const tags = pgTable("tags", {
  id: serial("id").primaryKey(),
  number: integer("number").notNull().unique(),
  // active = in circulation, lost = misplaced, retired = pulled from play
  status: text("status", { enum: ["active", "lost", "retired"] })
    .default("active")
    .notNull(),
});

// Current tag assignment: who holds each tag right now.
//
// DERIVED, not authoritative. Every row here is produced by replaying the
// event log — finalized rounds in date order, plus tag_adjustments — through
// replayTagHolders() (lib/tagHolders.ts). Nothing else may write to this
// table: a direct write survives only until the next replay, which is any
// round finalize, round delete, or manual tag change.
export const tagHolders = pgTable("tag_holders", {
  tagId: integer("tag_id")
    .primaryKey()
    .references(() => tags.id),
  playerId: integer("player_id")
    .references(() => players.id)
    .notNull(),
  // The DATE the tag was won or issued, not when the row was written — the
  // replay that produced this row could have run months later.
  since: date("since").notNull(),
});

// Manual tag assignments: a player given a tag by an admin rather than by
// winning it in a round. The other half of the event log.
//
// These exist because the log has to explain tags that no round accounts for
// — the league's original issue, a player joining mid-season, a correction
// after someone traded tags in the parking lot. Keeping them OUT of
// tag_holders is what lets that table be rebuilt from scratch without losing
// them.
//
// Ordered against rounds by effectiveDate, so an adjustment beats every round
// dated before it and loses to every round after — a correction made today is
// not meant to freeze a player's tag through next week's round.
export const tagAdjustments = pgTable("tag_adjustments", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id")
    .references(() => players.id, { onDelete: "cascade" })
    .notNull(),
  tagId: integer("tag_id")
    .references(() => tags.id)
    .notNull(),
  effectiveDate: date("effective_date").notNull(),
  // Free text for the audit trail — why someone's tag was set by hand.
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One record per sanctioned tags-round event.
export const rounds = pgTable("rounds", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  course: text("course"),
  // open = accepting check-ins AND score edits, scoring = check-in closed but
  // scores still editable, finalized = locked. Closing check-in matters: the
  // redistributed tag pool IS the set of participants' incoming tags, so a
  // late joiner changes what everyone else can win.
  status: text("status", { enum: ["open", "scoring", "finalized"] })
    .default("open")
    .notNull(),
  // Short code an admin reads out at the course. Bearing it authorizes writes
  // to THIS round's entries only (see middleware/requireRoundCode) — the third
  // auth tier, alongside public reads and Cloudflare Access admin writes.
  // Cleared on finalize so the code recycles and a locked round is unwritable.
  // NEVER include this in a public response; see selectRoundPublic().
  joinCode: text("join_code").unique(),
  codeExpiresAt: timestamp("code_expires_at"),
  // Which admin opened the round. Audit only.
  createdBy: text("created_by"),
  // Idempotency key for the one-shot finalize endpoint. The client mints it
  // once per local round and resends it on retry, so an interrupted request
  // whose transaction actually committed returns THAT round instead of
  // redistributing tags a second time. Null for rounds built incrementally
  // through the step-by-step admin routes.
  clientKey: text("client_key").unique(),
});

// One row per player per round: their incoming tag, score, and (once
// finalized) the tag they were assigned.
//
// A row is created by SIGNING UP and becomes real by being CHECKED IN. Those
// are two different acts by two different people: any player at the course can
// sign themselves (or their group) up, but somebody is standing there
// collecting physical tags and pool money, and only they can say who is
// actually playing. See checkedInAt below — a row without it is an
// announcement, not a participant.
export const roundEntries = pgTable(
  "round_entries",
  {
    id: serial("id").primaryKey(),
    roundId: integer("round_id")
      .references(() => rounds.id, { onDelete: "cascade" })
      .notNull(),
    playerId: integer("player_id")
      .references(() => players.id)
      .notNull(),
    incomingTagId: integer("incoming_tag_id")
      .references(() => tags.id)
      .notNull(),
    score: integer("score"), // null = DNF
    assignedTagId: integer("assigned_tag_id").references(() => tags.id), // null until finalized
    acePool: boolean("ace_pool").default(false).notNull(),
    ctp: boolean("ctp").default(false).notNull(),
    // Bumped on every score/pool edit. Lets a live round's pollers tell what
    // changed, and gives the UI a "saved at" to show per row.
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // Null until the person collecting tags and pool money confirms this
    // player is really here with the tag and the cash. A row with no timestamp
    // is a SIGNUP: it holds the player's place and claims their tag number,
    // but it is not in the field — not in the redistributed pool, not in the
    // ace/CTP totals, not ranked at finalize, and it takes no score.
    checkedInAt: timestamp("checked_in_at"),
    // Which admin checked them in. Audit only, and NEVER served in any
    // response: it is an email address. Mirrors rounds.createdBy.
    checkedInBy: text("checked_in_by"),
  },
  (t) => ({
    // A player appears at most once per round.
    uniquePlayerPerRound: unique().on(t.roundId, t.playerId),
    // No two players bring the same incoming tag. The one-shot /complete path
    // checks this in JS, but concurrent check-ins on a live round race past any
    // application-level check — two people claiming #42 would corrupt the
    // redistribution, so the constraint has to live in the database.
    uniqueTagPerRound: unique().on(t.roundId, t.incomingTagId),
  })
);

// Email allowlist for admin (write) access, checked against the
// Cloudflare Access identity.
export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
});

// The league calendar: rounds that are PLANNED, as opposed to rounds that
// exist. Deliberately not rows in `rounds` — a round there is a live,
// writable thing with a tag pool and a join code, and a date three weeks out
// is neither. When the day comes an admin opens a live round as usual; the
// calendar entry is just the announcement, and it simply drops off the
// upcoming list once its date passes.
//
// Once an admin STARTS a round from an entry, roundId links the two and the
// round becomes the source of truth for date and course (see
// routes/calendar.ts). The link lives here, not on `rounds`, on purpose: the
// table standings are replayed from doesn't change shape, and a round with no
// calendar entry — opened from Admin, run on one phone, imported — stays the
// ordinary case it has always been.
export const calendarEvents = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  // "HH:MM", 24-hour, in the league's own local time. Text rather than a
  // time/timestamptz column because it is wall-clock time at the course —
  // there is no instant to convert, and nobody wants 10:00 shifted by a
  // server's TZ. Null = time not announced yet.
  startTime: text("start_time"),
  // Null renders as the default ("Tags round"); set for anything else —
  // doubles, a tournament, a work day.
  title: text("title"),
  // Free text, like rounds.course — see "Courses" in the README.
  course: text("course"),
  notes: text("notes"),
  // False for anything that doesn't move tags — a work day, a tournament with
  // its own format. Only a tags round can be started as a live round, since
  // finalizing one redistributes tags.
  tagsRound: boolean("tags_round").default(true).notNull(),
  // The round this entry became, once started. Unique: one round per entry,
  // which is also what makes a double-tapped Start harmless. Deleting the
  // round clears it, putting the entry back to "not started".
  roundId: integer("round_id")
    .references(() => rounds.id, { onDelete: "set null" })
    .unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// The one site-wide announcement banner, or no row at all. A single row
// (id pinned to 1 by the check constraint) because the site shows one message
// at a time — two banners stacked above the standings is a page about banners.
//
// startsOn / endsOn are optional and inclusive. Visibility is decided by the
// BROWSER against its own local date, not here: the server runs on UTC and
// would end "closed through Sunday" at 6pm Saturday in Colorado.
export const siteBanner = pgTable(
  "site_banner",
  {
    id: integer("id").primaryKey().default(1),
    message: text("message").notNull(),
    // http(s) URL, or an in-app path like "#/calendar". Validated on write —
    // this lands in an href, so javascript: must never get through.
    linkUrl: text("link_url"),
    linkLabel: text("link_label"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // Audit only, and NEVER served — it is an email address.
    updatedBy: text("updated_by"),
  },
  (t) => ({
    singleton: check("site_banner_singleton", sql`${t.id} = 1`),
  })
);
