import { db, closeDb } from "./client.js";
import { players, tags, tagHolders } from "./schema.js";
import {
  foldTagEvents,
  loadTagEvents,
  replayTagHolders,
  type Holding,
} from "../lib/tagHolders.js";

// One-shot: rebuild tag_holders from the event log, or show what rebuilding
// would change.
//
// Exists for the migration to the derived model. Every write path replays on
// its own now, so the only reason to run this by hand is to inspect a database
// that was last written by the old code — read the dry-run diff against a copy
// of prod before deploying, since the epoch-seeded adjustments mean the first
// replay recomputes standings from full history and can move them.

const dryRun = process.argv.includes("--dry-run");

// Names and numbers, so the diff reads as tags and people rather than ids.
async function labels() {
  const [tagRows, playerRows] = await Promise.all([
    db.select({ id: tags.id, number: tags.number }).from(tags),
    db.select({ id: players.id, name: players.name }).from(players),
  ]);
  return {
    tagNumber: new Map(tagRows.map((t) => [t.id, t.number])),
    player: new Map(playerRows.map((p) => [p.id, p.name])),
  };
}

const before = new Map<number, Holding>(
  (await db.select().from(tagHolders)).map((h) => [
    h.tagId,
    { playerId: h.playerId, since: h.since },
  ])
);

const events = await loadTagEvents(db);
const after = foldTagEvents(events);
const { tagNumber, player } = await labels();

const name = (id: number | undefined) =>
  id === undefined ? "nobody" : player.get(id) ?? `player ${id}`;

// Only holder changes. A `since` that shifts without the holder changing is
// expected everywhere — the old column recorded when the row was written, the
// new one records the date the tag was won — and printing it would bury the
// changes that matter.
const moved: { number: number; line: string }[] = [];
for (const tagId of new Set([...before.keys(), ...after.keys()])) {
  const from = before.get(tagId)?.playerId;
  const to = after.get(tagId)?.playerId;
  if (from === to) continue;
  const number = tagNumber.get(tagId) ?? tagId;
  moved.push({ number, line: `  #${number}: ${name(from)} → ${name(to)}` });
}
moved.sort((a, b) => a.number - b.number);

console.log(
  `${events.length} events → ${after.size} holdings (was ${before.size})`
);
if (moved.length === 0) {
  console.log("no tag changes hands");
} else {
  console.log(`${moved.length} tag(s) change hands:`);
  console.log(moved.map((m) => m.line).join("\n"));
}

if (dryRun) {
  console.log("\ndry run — nothing written");
} else {
  await db.transaction(async (tx) => {
    await replayTagHolders(tx);
  });
  console.log("\ntag_holders rebuilt");
}

await closeDb();
