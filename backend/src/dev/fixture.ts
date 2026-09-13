import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../app.js";
import { db, closeDb } from "../db/client.js";
import {
  admins,
  players,
  roundEntries,
  rounds,
  tagAdjustments,
  tagHolders,
  tags,
} from "../db/schema.js";
import { DEV_ADMIN_EMAIL, DEV_JOIN_CODE, assertLocalDatabase } from "./config.js";

// Loads the local test dataset. Wipes the dev database and rebuilds it the same
// way every time, so a test run always starts from a known board.
//
// Built by driving the app's own HTTP routes rather than inserting rows: tag
// redistribution, tag_holders, and the live-round check-in path all have real
// logic behind them, and a fixture that bypassed it would drift out of sync
// with the app and quietly stop resembling production data.
//
// EVERY NAME BELOW IS INVENTED. No real league member, and no real course, goes
// in this file — it is committed to a public repo.

const ROSTER = [
  "Alma Bright",
  "Bo Fenwick",
  "Cal Ives",
  "Dara Wren",
  "Ez Marlow",
  "Finn Ockley",
  "Greta Pyle",
  "Hollis Vane",
  "Ines Quarrie",
  "Jory Tamsin",
  "Kit Ableman",
  "Lux Verrall",
  "Mika Doren",
  "Zora Quill",
];

// Past rounds, oldest first. `play` is [roster index, score] — a null score is
// a DNF, which the redistribution sends to the back of the tag pool. Scores are
// hand-picked rather than random so the standings look the same on every run.
//
// The list spans about six months on purpose. Home's round history is windowed
// to this month (or the five most recent, whichever is more) behind a month
// picker, and neither the cutoff nor the picker is clickable on a fixture that
// only holds one or two months. The five oldest rounds are spaced 35 days apart
// — more than any month is long, so they always land in five distinct months
// however the calendar falls.
//
// The recent cluster is dated in days, so how many of them count as "this
// month" depends on the day you load the fixture: from the 13th on there are
// five and Home defaults to "This month", earlier in a month there are fewer
// and it defaults to the five most recent. Both are real states of the app.
const HISTORY = [
  {
    daysAgo: 180,
    course: "Marrow Hill",
    play: [
      [2, 58], [6, 59], [9, 61], [0, 63], [12, 66], [4, 70],
    ] as [number, number | null][],
    acePool: [2, 6, 9],
    ctp: [6],
  },
  {
    daysAgo: 145,
    course: "Sable Woods",
    play: [
      [8, 54], [1, 56], [11, 57], [3, 59], [7, 62], [13, 65], [5, 68],
    ] as [number, number | null][],
    acePool: [8, 1, 11, 3],
    ctp: [11],
  },
  {
    daysAgo: 110,
    course: "Anvil Creek",
    play: [
      [0, 52], [10, 55], [4, 56], [12, 60], [2, 63], [9, null],
    ] as [number, number | null][],
    acePool: [0, 10, 4],
    ctp: [0],
  },
  {
    daysAgo: 75,
    course: "Tamarack Loop",
    play: [
      [5, 51], [3, 53], [13, 54], [6, 58], [1, 61], [8, 62], [11, 67],
    ] as [number, number | null][],
    acePool: [5, 3, 13, 6],
    ctp: [3],
  },
  {
    daysAgo: 40,
    course: "Kestrel Flats",
    play: [
      [7, 50], [0, 52], [2, 55], [10, 57], [4, 59], [12, 64], [9, 69],
    ] as [number, number | null][],
    acePool: [7, 0, 2, 10],
    ctp: [7],
  },
  {
    daysAgo: 21,
    course: "Cedar Hollow",
    play: [
      [3, 51], [7, 53], [0, 54], [11, 55], [5, 57],
      [9, 58], [1, 60], [12, 62], [6, 64], [2, 71],
    ] as [number, number | null][],
    acePool: [3, 7, 0, 11, 5],
    ctp: [7],
  },
  {
    daysAgo: 14,
    course: "Ironwood Park",
    play: [
      [0, 49], [5, 52], [3, 52], [8, 54], [13, 56], [7, 56],
      [10, 59], [2, 61], [4, 63], [9, 65], [12, 68], [6, null],
    ] as [number, number | null][],
    acePool: [0, 5, 3, 8, 13, 7, 10],
    ctp: [0],
  },
  {
    daysAgo: 7,
    course: "Quarry Bend",
    play: [
      [5, 50], [0, 50], [13, 53], [3, 55], [10, 57],
      [1, 58], [8, 60], [11, 62], [4, 66],
    ] as [number, number | null][],
    acePool: [5, 0, 13, 3],
    ctp: [13],
  },
  {
    daysAgo: 5,
    course: "Bramble Ridge",
    play: [
      [3, 49], [10, 51], [0, 54], [7, 55], [12, 58], [2, 60], [6, 63],
    ] as [number, number | null][],
    acePool: [3, 10, 0, 7],
    ctp: [10],
  },
  {
    daysAgo: 3,
    course: "Hollowbrook",
    play: [
      [13, 48], [5, 51], [8, 52], [1, 56], [11, 59], [4, 61], [9, 64],
    ] as [number, number | null][],
    acePool: [13, 5, 8, 1],
    ctp: [5],
  },
  {
    daysAgo: 2,
    course: "Wexford Commons",
    play: [
      [0, 50], [3, 51], [12, 55], [6, 57], [10, 58], [2, 62],
    ] as [number, number | null][],
    acePool: [0, 3, 12],
    ctp: [12],
  },
  {
    daysAgo: 1,
    course: "Pinch Gap",
    play: [
      [7, 47], [0, 50], [5, 53], [13, 54], [8, 56], [11, 60], [4, 65], [9, null],
    ] as [number, number | null][],
    acePool: [7, 0, 5, 13, 8],
    ctp: [0],
  },
];

// The live round: who is checked in, and which of them already have a score.
// A deliberate mix — the score-entry tab styles scored and unscored fields
// differently, and that only shows up with both on screen at once.
const LIVE_COURSE = "Fox Ridge";
const LIVE_CHECKED_IN = [0, 5, 3, 13, 8, 2, 10];
const LIVE_SCORES: Record<number, number> = { 0: 52, 5: 54, 3: 57 };

let baseUrl = "";
let server: Server | null = null;

// A function, not `server?.close()` inline: at module scope TypeScript still
// has `server` narrowed to its initial null.
function stopServer() {
  server?.close();
}

type ApiOpts = { body?: unknown; code?: string };

async function api(method: string, path: string, opts: ApiOpts = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The fixture always speaks as the dev admin; the server does the same
    // thing for the browser (see dev/server.ts).
    "Cf-Access-Authenticated-User-Email": DEV_ADMIN_EMAIL,
  };
  if (opts.code) headers["X-Round-Code"] = opts.code;

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.status >= 400) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

// YYYY-MM-DD in local time. toISOString() would be UTC and can land the round
// on the wrong day for anyone west of Greenwich.
function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-CA");
}

// Who holds which tag right now, straight from the app. Each round's incoming
// tags are whatever the previous round left people holding, so this is read
// fresh before every round rather than tracked in here.
async function currentTags(): Promise<Map<number, number>> {
  const rows: { playerId: number; tagNumber: number }[] =
    await api("GET", "/api/standings");
  return new Map(rows.map((r) => [r.playerId, r.tagNumber]));
}

async function main() {
  assertLocalDatabase();

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  // Same wipe the test suite uses: RESTART IDENTITY so ids are identical on
  // every run, CASCADE for the FK web.
  await db.execute(
    sql`truncate table ${admins}, ${players}, ${tags}, ${tagHolders}, ${tagAdjustments}, ${rounds}, ${roundEntries} restart identity cascade`
  );
  await db
    .insert(tags)
    .values(Array.from({ length: 300 }, (_, i) => ({ number: i + 1 })));
  await db.insert(admins).values({ email: DEV_ADMIN_EMAIL });

  // Roster. Player i starts on tag i+1; the rounds below shuffle that.
  const playerIds: number[] = [];
  for (const [i, name] of ROSTER.entries()) {
    const created = await api("POST", "/api/admin/players", {
      body: { name, tagNumber: i + 1 },
    });
    playerIds.push(created.id);
  }

  // Past rounds, through the one-shot finalize the app itself uses.
  for (const round of HISTORY) {
    const held = await currentTags();
    await api("POST", "/api/admin/rounds/complete", {
      body: {
        date: isoDate(round.daysAgo),
        course: round.course,
        players: round.play.map(([idx, score]) => ({
          playerId: playerIds[idx],
          tagNumber: held.get(playerIds[idx]),
          score,
          acePool: round.acePool.includes(idx),
          ctp: round.ctp.includes(idx),
        })),
      },
    });
  }

  // The live round: open for check-in, dated today.
  const live = await api("POST", "/api/admin/rounds", {
    body: { date: isoDate(0), course: LIVE_COURSE },
  });
  // Overwrite the randomly minted code with the fixed one. Done in SQL because
  // no route will ever let a caller choose a code — and it shouldn't.
  await db
    .update(rounds)
    .set({
      joinCode: DEV_JOIN_CODE,
      codeExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    })
    .where(eq(rounds.id, live.id));

  const held = await currentTags();
  for (const idx of LIVE_CHECKED_IN) {
    const entry = await api("POST", `/api/rounds/${live.id}/checkin`, {
      code: DEV_JOIN_CODE,
      body: {
        playerId: playerIds[idx],
        tagNumber: held.get(playerIds[idx]),
        acePool: idx % 2 === 0,
      },
    });
    if (LIVE_SCORES[idx] !== undefined) {
      await api("PATCH", `/api/rounds/${live.id}/entries/${entry.id}`, {
        code: DEV_JOIN_CODE,
        body: { score: LIVE_SCORES[idx] },
      });
    }
  }

  console.log(
    `fixture loaded: ${ROSTER.length} players, ${HISTORY.length} finalized rounds, ` +
      `1 live round (#${live.id}, ${LIVE_COURSE}) with ${LIVE_CHECKED_IN.length} ` +
      `checked in and ${Object.keys(LIVE_SCORES).length} scored`
  );
}

try {
  await main();
} finally {
  stopServer();
  await closeDb();
}
