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
  // open = registering, scoring = entering scores, finalized = locked
  status: text("status", { enum: ["open", "scoring", "finalized"] })
    .default("open")
    .notNull(),
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
  },
  (t) => ({
    // A player appears at most once per round.
    uniquePlayerPerRound: unique().on(t.roundId, t.playerId),
  })
);

// Email allowlist for admin (write) access, checked against the
// Cloudflare Access identity.
export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
});
