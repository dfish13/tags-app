import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  unique,
} from "drizzle-orm/pg-core";

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
// Authoritative because only sanctioned-round finalization updates it.
export const tagHolders = pgTable("tag_holders", {
  tagId: integer("tag_id")
    .primaryKey()
    .references(() => tags.id),
  playerId: integer("player_id")
    .references(() => players.id)
    .notNull(),
  since: timestamp("since").defaultNow().notNull(),
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
