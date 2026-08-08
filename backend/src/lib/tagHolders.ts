import { asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  roundEntries,
  rounds,
  tagAdjustments,
  tagHolders,
} from "../db/schema.js";

// Accepts the pool or a transaction. `typeof db` alone won't do: drizzle hands
// the callback a PgTransaction, which is a different type, and every caller
// here replays inside the transaction that produced the event.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

// One thing that happened to a tag, in the order it happened.
//
// A round moves several tags at once and has to be applied as a unit — the
// pool is released before any of it is taken, so a tag can pass between two
// participants within one event. An adjustment moves exactly one.
export type TagEvent =
  | {
      kind: "round";
      id: number;
      date: string;
      assignments: { playerId: number; tagId: number }[];
    }
  | {
      kind: "adjustment";
      id: number;
      date: string;
      playerId: number;
      tagId: number;
    };

export type Holding = { playerId: number; since: string };

// Rounds before adjustments on the same date: a manual correction entered the
// same day as a round is almost always correcting that round, so it has to
// land after it. Ties beyond that break on id, which is insertion order.
const KIND_ORDER = { round: 0, adjustment: 1 } as const;

function compareEvents(a: TagEvent, b: TagEvent): number {
  return (
    a.date.localeCompare(b.date) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.id - b.id
  );
}

// Fold the event log into current holdings. Pure, and separate from the write
// below so the dry-run can diff a proposed state against the live table.
//
// Every step here reproduces exactly what the corresponding write path used to
// do inline, so replaying the whole log yields what you'd have gotten by
// entering the events in date order in the first place. It introduces no new
// conflict rules — ordering is the only thing it changes.
export function foldTagEvents(events: TagEvent[]): Map<number, Holding> {
  const byTag = new Map<number, Holding>();
  // Reverse index so "release this player's tag" doesn't scan the map. The two
  // must stay in lockstep; that's why nothing below touches byTag directly.
  const tagOfPlayer = new Map<number, number>();

  const release = (playerId: number) => {
    const held = tagOfPlayer.get(playerId);
    if (held === undefined) return;
    tagOfPlayer.delete(playerId);
    byTag.delete(held);
  };

  const take = (tagId: number, playerId: number, since: string) => {
    // The tag's previous holder loses it and gets nothing back. That's the
    // league's real rule for a displaced non-participant: their actual tag is
    // unknown, so tagless is the honest answer until they declare one.
    const previous = byTag.get(tagId);
    if (previous) tagOfPlayer.delete(previous.playerId);
    release(playerId);
    byTag.set(tagId, { playerId, since });
    tagOfPlayer.set(playerId, tagId);
  };

  for (const event of [...events].sort(compareEvents)) {
    if (event.kind === "adjustment") {
      take(event.tagId, event.playerId, event.date);
      continue;
    }
    // Release the whole field before taking anything. Without the two passes a
    // participant's pre-round tag can survive when it isn't part of this
    // round's pool, leaving them holding two.
    for (const a of event.assignments) release(a.playerId);
    for (const a of event.assignments) take(a.tagId, a.playerId, event.date);
  }

  return byTag;
}

// Read the whole log: finalized rounds with their recorded assignments, plus
// every manual adjustment.
export async function loadTagEvents(tx: DbOrTx): Promise<TagEvent[]> {
  const assignedEntries = await tx
    .select({
      roundId: roundEntries.roundId,
      date: rounds.date,
      playerId: roundEntries.playerId,
      tagId: roundEntries.assignedTagId,
    })
    .from(roundEntries)
    .innerJoin(rounds, eq(rounds.id, roundEntries.roundId))
    .where(isNotNull(roundEntries.assignedTagId))
    .orderBy(asc(roundEntries.id));

  // Grouped rather than one event per entry, because a round's releases all
  // precede its takes. Rounds whose entries carry no assignment never appear
  // here at all — legacy rounds that predate finalization contribute nothing,
  // not even the release of their participants' tags.
  const roundEvents = new Map<number, Extract<TagEvent, { kind: "round" }>>();
  for (const e of assignedEntries) {
    let event = roundEvents.get(e.roundId);
    if (!event) {
      event = { kind: "round", id: e.roundId, date: e.date, assignments: [] };
      roundEvents.set(e.roundId, event);
    }
    event.assignments.push({ playerId: e.playerId, tagId: e.tagId! });
  }

  const adjustments = await tx
    .select({
      id: tagAdjustments.id,
      date: tagAdjustments.effectiveDate,
      playerId: tagAdjustments.playerId,
      tagId: tagAdjustments.tagId,
    })
    .from(tagAdjustments);

  return [
    ...roundEvents.values(),
    ...adjustments.map((a) => ({ kind: "adjustment" as const, ...a })),
  ];
}

// Arbitrary constant; the only requirement is that every replay uses the same
// one. Advisory locks share a namespace across the database, and this is the
// only lock the app takes.
const REPLAY_LOCK_KEY = 8_147_320_155_301;

// Serialize replays. Two of them at once corrupt the table: both DELETE, the
// second blocks, and when it resumes its scan snapshot predates the first's
// INSERT — so it deletes nothing new and its own INSERT trips the primary key
// on a tag the other just wrote. READ COMMITTED can't see the phantom, and
// rebuilding a whole table is inherently serial anyway.
//
// Take this before touching tag_holders by hand, not just before replaying:
// holding a row lock while waiting for this lock is a deadlock against a
// replay that already has it. Re-acquiring within one transaction is free.
export async function lockTagHolders(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${REPLAY_LOCK_KEY})`);
}

// Rebuild tag_holders from the event log. Call this as the last step of any
// transaction that touches a finalized round or an adjustment — it is the only
// thing permitted to write the table.
//
// Two statements rather than per-event SQL: the league runs to hundreds of
// rounds, which is nothing to fold in memory and a lot of round trips to do in
// the database.
export async function replayTagHolders(
  tx: DbOrTx
): Promise<Map<number, Holding>> {
  await lockTagHolders(tx);
  const holdings = foldTagEvents(await loadTagEvents(tx));
  await tx.delete(tagHolders);
  if (holdings.size > 0) {
    await tx.insert(tagHolders).values(
      [...holdings].map(([tagId, { playerId, since }]) => ({
        tagId,
        playerId,
        since,
      }))
    );
  }
  return holdings;
}
