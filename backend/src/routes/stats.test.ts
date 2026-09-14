import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../db/client.js";
import {
  api,
  addPlayer,
  openRound,
  resetDb,
  startTestServer,
  stopTestServer,
} from "../test/helpers.js";

// Integration tests for GET /api/stats/player/:id — the per-round projection
// behind the player page. The summary tiles are derived client-side, so what
// is worth pinning down here is the part that needs the whole field: finish
// rank with ties, the field average with the player taken out of it, and what
// a DNF does to each. These need a database — see `npm test`.

before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
  await closeDb();
});
beforeEach(async () => {
  await resetDb();
});

type Row = {
  roundId: number;
  date: string;
  course: string | null;
  incomingTag: number;
  assignedTag: number | null;
  score: number | null;
  fieldAvg: number | null;
  diff: number | null;
  finish: number | null;
  fieldSize: number;
  percentile: number | null;
  ctp: boolean;
  acePool: boolean;
};
type Body = {
  player: { id: number; name: string };
  current: { tagNumber: number; since: string } | null;
  context: { roundsAvailable: number };
  rounds: Row[];
};

type Play = { playerId: number; tagNumber: number; score: number | null };

// A finalized round in one request. Tag numbers are the INCOMING tags; the
// route redistributes them by finish.
async function playRound(date: string, course: string, players: Play[]) {
  const res = await api("POST", "/api/admin/rounds/complete", {
    admin: true,
    body: {
      date,
      course,
      players: players.map((p) => ({ ...p, acePool: false, ctp: false })),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: number };
}

async function statsFor(playerId: number) {
  const res = await api("GET", `/api/stats/player/${playerId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as Body;
}

// The round every scoring test below reads from: four players, a tie for
// second, spread so every place is distinct enough to check by hand.
//
//   Ada 50 · Bea 52 · Cal 52 · Dot 55
//
async function tieRound() {
  const ada = await addPlayer("Ada Vance", 1);
  const bea = await addPlayer("Bea Marlowe", 2);
  const cal = await addPlayer("Cal Rhodes", 3);
  const dot = await addPlayer("Dot Iverson", 4);
  await playRound("2026-06-01", "Marrow Hill", [
    { playerId: ada.id, tagNumber: 1, score: 50 },
    { playerId: bea.id, tagNumber: 2, score: 52 },
    { playerId: cal.id, tagNumber: 3, score: 52 },
    { playerId: dot.id, tagNumber: 4, score: 55 },
  ]);
  return { ada, bea, cal, dot };
}

describe("finish place", () => {
  test("ties share the better place, and the next place is skipped", async () => {
    const { ada, bea, cal, dot } = await tieRound();

    assert.equal((await statsFor(ada.id)).rounds[0].finish, 1);
    assert.equal((await statsFor(bea.id)).rounds[0].finish, 2);
    assert.equal((await statsFor(cal.id)).rounds[0].finish, 2); // tied, not 3rd
    assert.equal((await statsFor(dot.id)).rounds[0].finish, 4); // 3rd is skipped
  });

  test("percentile runs 100 for the win down to 0 for last", async () => {
    const { ada, bea, dot } = await tieRound();

    assert.equal((await statsFor(ada.id)).rounds[0].percentile, 100);
    assert.equal((await statsFor(bea.id)).rounds[0].percentile, 67); // (4-2)/3
    assert.equal((await statsFor(dot.id)).rounds[0].percentile, 0);
  });
});

describe("field average", () => {
  test("excludes the player from their own comparison", async () => {
    const { ada, dot } = await tieRound();

    // Ada against 52, 52, 55 — not against all four scores including her own.
    const a = (await statsFor(ada.id)).rounds[0];
    assert.equal(a.fieldAvg, 53);
    assert.equal(a.diff, -3);

    // Dot against 50, 52, 52 = 51.333…, so +3.67 and not +3.
    const d = (await statsFor(dot.id)).rounds[0];
    assert.equal(d.fieldAvg, 51.33);
    assert.equal(d.diff, 3.67);
  });

  test("is null when nobody else posted a score", async () => {
    const solo = await addPlayer("Solo Wren", 9);
    await playRound("2026-06-01", "Sable Woods", [
      { playerId: solo.id, tagNumber: 9, score: 48 },
    ]);

    const r = (await statsFor(solo.id)).rounds[0];
    assert.equal(r.fieldSize, 1);
    assert.equal(r.finish, 1);
    assert.equal(r.fieldAvg, null); // no divide by zero
    assert.equal(r.diff, null);
    assert.equal(r.percentile, null);
  });
});

describe("a DNF", () => {
  test("keeps its tags, nulls everything score-derived, and ranks nobody", async () => {
    const ada = await addPlayer("Ada Vance", 1);
    const bea = await addPlayer("Bea Marlowe", 2);
    const cal = await addPlayer("Cal Rhodes", 3);
    await playRound("2026-06-01", "Anvil Creek", [
      { playerId: ada.id, tagNumber: 1, score: 50 },
      { playerId: bea.id, tagNumber: 2, score: 54 },
      { playerId: cal.id, tagNumber: 3, score: null },
    ]);

    const c = (await statsFor(cal.id)).rounds[0];
    assert.equal(c.score, null);
    assert.equal(c.finish, null);
    assert.equal(c.fieldAvg, null);
    assert.equal(c.diff, null);
    assert.equal(c.percentile, null);
    // Not finishing still redistributes a tag, so the round is a real row.
    assert.equal(c.incomingTag, 3);
    assert.notEqual(c.assignedTag, null);

    // And the DNF is invisible to everyone else's numbers: Ada is 1 of 2,
    // compared against Bea alone.
    const a = (await statsFor(ada.id)).rounds[0];
    assert.equal(a.fieldSize, 2);
    assert.equal(a.finish, 1);
    assert.equal(a.fieldAvg, 54);
    assert.equal(a.percentile, 100);
  });
});

describe("which rounds count", () => {
  test("a round that isn't finalized is not history yet", async () => {
    const ada = await addPlayer("Ada Vance", 1);
    await playRound("2026-06-01", "Marrow Hill", [
      { playerId: ada.id, tagNumber: 1, score: 50 },
    ]);

    // Ada is also checked in to a round still in progress.
    const live = await openRound({ date: "2026-06-08", course: "Tamarack" });
    const tagList = (await api("GET", "/api/tags")).body as {
      id: number;
      number: number;
    }[];
    const tag1 = tagList.find((t) => t.number === 1)!;
    const entry = await api("POST", `/api/admin/rounds/${live.id}/entries`, {
      admin: true,
      body: { playerId: ada.id, incomingTagId: tag1.id },
    });
    assert.equal(entry.status, 201, JSON.stringify(entry.body));

    const body = await statsFor(ada.id);
    assert.equal(body.rounds.length, 1);
    assert.equal(body.rounds[0].date, "2026-06-01");
  });

  test("attendance counts from the player's first round, not the league's", async () => {
    const ada = await addPlayer("Ada Vance", 1);
    const bea = await addPlayer("Bea Marlowe", 2);

    // Two rounds before Ada ever showed up.
    await playRound("2026-05-01", "Marrow Hill", [
      { playerId: bea.id, tagNumber: 2, score: 51 },
    ]);
    await playRound("2026-05-15", "Sable Woods", [
      { playerId: bea.id, tagNumber: 2, score: 53 },
    ]);
    // Three she could have played; she played two.
    await playRound("2026-06-01", "Anvil Creek", [
      { playerId: ada.id, tagNumber: 1, score: 50 },
    ]);
    await playRound("2026-06-08", "Tamarack Loop", [
      { playerId: bea.id, tagNumber: 2, score: 52 },
    ]);
    await playRound("2026-06-15", "Kestrel Flats", [
      { playerId: ada.id, tagNumber: 1, score: 49 },
    ]);

    const body = await statsFor(ada.id);
    assert.equal(body.rounds.length, 2);
    assert.equal(body.context.roundsAvailable, 3); // not 5

    // Bea was there for all five.
    assert.equal((await statsFor(bea.id)).context.roundsAvailable, 5);
  });

  test("newest round first, with the current tag alongside", async () => {
    const ada = await addPlayer("Ada Vance", 1);
    await playRound("2026-06-01", "Marrow Hill", [
      { playerId: ada.id, tagNumber: 1, score: 50 },
    ]);
    await playRound("2026-06-15", "Sable Woods", [
      { playerId: ada.id, tagNumber: 1, score: 49 },
    ]);

    const body = await statsFor(ada.id);
    assert.deepEqual(
      body.rounds.map((r) => r.date),
      ["2026-06-15", "2026-06-01"]
    );
    assert.equal(body.rounds[0].course, "Sable Woods");
    assert.equal(body.current?.tagNumber, 1);
  });
});

describe("players with no history", () => {
  test("a real player who has never played is an empty page, not an error", async () => {
    const ada = await addPlayer("Ada Vance", 1);

    const body = await statsFor(ada.id);
    assert.equal(body.player.name, "Ada Vance");
    assert.deepEqual(body.rounds, []);
    assert.equal(body.context.roundsAvailable, 0);
    assert.equal(body.current?.tagNumber, 1); // issued a tag, just hasn't played
  });

  test("an id that is not a player is a 404", async () => {
    assert.equal((await api("GET", "/api/stats/player/999999")).status, 404);
    assert.equal((await api("GET", "/api/stats/player/nope")).status, 404);
  });
});
