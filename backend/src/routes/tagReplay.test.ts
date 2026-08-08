import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { db, closeDb } from "../db/client.js";
import { replayTagHolders } from "../lib/tagHolders.js";
import {
  api,
  addPlayer,
  openRound,
  resetDb,
  startTestServer,
  stopTestServer,
} from "../test/helpers.js";

// Standings are derived: tag_holders is rebuilt from the event log — finalized
// rounds in round-DATE order, plus manual adjustments — after every write.
// These tests are about ORDER. The headline case is entering rounds backwards,
// which used to leave standings showing the older round's result. Each case
// also pins today's per-event semantics, which replay reproduces exactly.

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

async function tagsByName() {
  const res = await api("GET", "/api/players");
  const out: Record<string, number | null> = {};
  for (const p of res.body as { name: string; tagNumber: number | null }[]) {
    out[p.name] = p.tagNumber;
  }
  return out;
}

type Played = { id: number; tagNumber: number; score: number | null };

async function completeRound(date: string, played: Played[]) {
  const res = await api("POST", "/api/admin/rounds/complete", {
    admin: true,
    body: {
      date,
      course: "Test Course",
      players: played.map((p) => ({
        playerId: p.id,
        tagNumber: p.tagNumber,
        score: p.score,
      })),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: number };
}

describe("rounds entered out of order", () => {
  // The bug this whole change exists for.
  test("the later-DATED round decides standings, not the last one entered", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    // March: Bravo wins, so Bravo takes #1 and Alpha drops to #2.
    await completeRound("2026-03-01", [
      { ...alpha, score: 60 },
      { ...bravo, score: 50 },
    ]);
    // January, entered SECOND: Alpha won that day.
    await completeRound("2026-01-01", [
      { ...alpha, score: 50 },
      { ...bravo, score: 60 },
    ]);

    const standings = await tagsByName();
    assert.equal(standings["Bravo"], 1, "March is the most recent round");
    assert.equal(standings["Alpha"], 2);
  });

  test("editing a finalized round's date reorders standings", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    const january = await completeRound("2026-01-01", [
      { ...alpha, score: 50 },
      { ...bravo, score: 60 },
    ]);
    await completeRound("2026-03-01", [
      { ...alpha, score: 60 },
      { ...bravo, score: 50 },
    ]);
    assert.equal((await tagsByName())["Bravo"], 1, "March leads to start with");

    // The January round was misdated; it actually happened in June.
    const res = await api("PATCH", `/api/admin/rounds/${january.id}`, {
      admin: true,
      body: { date: "2026-06-01" },
    });
    assert.equal(res.status, 200);

    const standings = await tagsByName();
    assert.equal(standings["Alpha"], 1, "the moved round is now the latest");
    assert.equal(standings["Bravo"], 2);
  });
});

describe("manual tag changes against rounds", () => {
  test("an adjustment beats every round dated before it", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    await completeRound("2026-01-01", [
      { ...alpha, score: 50 },
      { ...bravo, score: 60 },
    ]);
    assert.equal((await tagsByName())["Alpha"], 1);

    // Dated today by the route, which is after the round above.
    const res = await api("PATCH", `/api/admin/players/${alpha.id}/tag`, {
      admin: true,
      body: { tagNumber: 7 },
    });
    assert.equal(res.status, 200);

    const standings = await tagsByName();
    assert.equal(standings["Alpha"], 7, "the correction is the newer fact");
    assert.equal(standings["Bravo"], 2, "and nobody else moves");
  });

  test("a round dated after an adjustment beats it", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    await api("PATCH", `/api/admin/players/${alpha.id}/tag`, {
      admin: true,
      body: { tagNumber: 7 },
    });
    assert.equal((await tagsByName())["Alpha"], 7);

    // Far future so the case doesn't depend on the wall clock.
    await completeRound("2099-01-01", [
      { ...alpha, tagNumber: 7, score: 50 },
      { ...bravo, tagNumber: 2, score: 60 },
    ]);

    const standings = await tagsByName();
    assert.equal(
      standings["Alpha"],
      2,
      "an override must not freeze a tag through later rounds"
    );
    assert.equal(standings["Bravo"], 7);
  });
});

describe("removing events", () => {
  test("deleting a finalized round puts the tags back", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    const round = await completeRound("2026-03-01", [
      { ...alpha, score: 60 },
      { ...bravo, score: 50 },
    ]);
    assert.equal((await tagsByName())["Bravo"], 1, "the round moved the tags");

    const res = await api("DELETE", `/api/admin/rounds/${round.id}`, {
      admin: true,
    });
    assert.equal(res.status, 204);

    const standings = await tagsByName();
    assert.equal(standings["Alpha"], 1, "back to the pre-round holdings");
    assert.equal(standings["Bravo"], 2);
  });

  test("deleting a player leaves their tag held by nobody", async () => {
    await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    const res = await api("DELETE", `/api/admin/players/${bravo.id}`, {
      admin: true,
    });
    assert.equal(res.status, 204);

    const standings = await api("GET", "/api/standings");
    const numbers = (standings.body as { tagNumber: number }[]).map(
      (r) => r.tagNumber
    );
    assert.deepEqual(numbers, [1], "#2 is free, not stranded on a ghost row");
  });
});

describe("what replay preserves", () => {
  test("a displaced non-participant is left tagless", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);
    await addPlayer("Charlie", 3);

    // Bravo turns up carrying #3 — Charlie's tag, traded in the parking lot.
    // Charlie played no round, so nothing says what they hold now.
    await completeRound("2026-03-01", [
      { ...alpha, tagNumber: 1, score: 60 },
      { ...bravo, tagNumber: 3, score: 50 },
    ]);

    const standings = await tagsByName();
    assert.equal(standings["Bravo"], 1);
    assert.equal(standings["Alpha"], 3);
    assert.equal(
      standings["Charlie"],
      null,
      "displaced, and their real tag is genuinely unknown"
    );
  });

  test("an unfinalized round contributes nothing", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);

    const round = await openRound({ date: "2099-01-01", course: "Test Course" });
    for (const p of [alpha, bravo]) {
      const res = await api("POST", `/api/admin/rounds/${round.id}/entries`, {
        admin: true,
        body: { playerId: p.id, incomingTagId: p.tagNumber },
      });
      assert.equal(res.status, 201);
    }

    const standings = await tagsByName();
    assert.equal(standings["Alpha"], 1, "entries alone move nothing");
    assert.equal(standings["Bravo"], 2);
  });

  test("replaying twice changes nothing", async () => {
    const alpha = await addPlayer("Alpha", 1);
    const bravo = await addPlayer("Bravo", 2);
    await completeRound("2026-03-01", [
      { ...alpha, score: 60 },
      { ...bravo, score: 50 },
    ]);
    await api("PATCH", `/api/admin/players/${alpha.id}/tag`, {
      admin: true,
      body: { tagNumber: 9 },
    });

    const first = await api("GET", "/api/standings");
    await replayTagHolders(db);
    const second = await api("GET", "/api/standings");
    assert.deepEqual(second.body, first.body);
  });
});
