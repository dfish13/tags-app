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

// Integration tests for roster writes. The interesting case is a tag being
// recycled: a new player is issued a number the app still has against whoever
// held it last, which used to be an outright refusal. These need a database —
// see `npm test`.

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

// Current tag per player name, straight off the public roster response.
async function tagsByName() {
  const res = await api("GET", "/api/players");
  const out: Record<string, number | null> = {};
  for (const p of res.body as { name: string; tagNumber: number | null }[]) {
    out[p.name] = p.tagNumber;
  }
  return out;
}

describe("creating a player on a tag someone already holds", () => {
  test("refuses by default, and names the holder", async () => {
    const jane = await addPlayer("Jane Doe", 42);

    const res = await api("POST", "/api/admin/players", {
      admin: true,
      body: { name: "New Player", tagNumber: 42 },
    });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /already held by Jane Doe/);
    // Structured, not just prose: the client prompts on this rather than
    // parsing the message.
    assert.deepEqual(res.body.heldBy, { id: jane.id, name: "Jane Doe" });

    const after = await tagsByName();
    assert.equal(after["Jane Doe"], 42, "a refused create must not move the tag");
    assert.equal(after["New Player"], undefined, "and must not create anyone");
  });

  test("takeTag reissues it and leaves the old holder tagless", async () => {
    await addPlayer("Jane Doe", 42);

    const res = await api("POST", "/api/admin/players", {
      admin: true,
      body: { name: "New Player", tagNumber: 42, takeTag: true },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.tagNumber, 42);
    assert.equal(res.body.displaced, "Jane Doe", "who lost the tag is reported");

    const after = await tagsByName();
    assert.equal(after["New Player"], 42);
    assert.equal(
      after["Jane Doe"],
      null,
      "displaced holder is tagless, not silently left on #42"
    );
  });

  test("takeTag on a free tag is an ordinary create", async () => {
    const res = await api("POST", "/api/admin/players", {
      admin: true,
      body: { name: "New Player", tagNumber: 7, takeTag: true },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.tagNumber, 7);
    assert.equal(res.body.displaced, null, "nobody was displaced");
  });

  test("takeTag does not bypass the admin gate", async () => {
    await addPlayer("Jane Doe", 42);

    const res = await api("POST", "/api/admin/players", {
      body: { name: "New Player", tagNumber: 42, takeTag: true },
    });

    assert.equal(res.status, 401);
    assert.equal((await tagsByName())["Jane Doe"], 42);
  });
});

describe("checking in on a tag the app has against someone else", () => {
  // The record only moves when a round finalizes, so someone arriving with a
  // tag traded outside a sanctioned round is routine. Check-in must accept it.
  test("is allowed, and writes nothing to the roster", async () => {
    const jane = await addPlayer("Jane Doe", 10);
    await addPlayer("John Roe", 42);
    const round = await openRound();

    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: jane.id, tagNumber: 42 },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.incomingNumber, 42);

    // Deliberate: the code tier reaches this round's entries and nothing else,
    // so standings stay put until an admin finalizes.
    const after = await tagsByName();
    assert.equal(after["John Roe"], 42, "check-in must not touch tag_holders");
    assert.equal(after["Jane Doe"], 10);
  });

  test("finalizing is what takes the tag off the old holder", async () => {
    const jane = await addPlayer("Jane Doe", 10);
    await addPlayer("John Roe", 42);
    const ann = await addPlayer("Ann Poe", 11);
    const round = await openRound();

    // Jane turns up holding #42 — the app thinks John Roe has it.
    const janeEntry = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: jane.id, tagNumber: 42 },
    });
    const annEntry = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: ann.id, tagNumber: 11 },
    });
    // Jane wins, so she takes the lower tag of the pool {11, 42}.
    await api("PATCH", `/api/rounds/${round.id}/entries/${janeEntry.body.id}`, {
      code: round.joinCode!,
      body: { score: 50 },
    });
    await api("PATCH", `/api/rounds/${round.id}/entries/${annEntry.body.id}`, {
      code: round.joinCode!,
      body: { score: 60 },
    });

    const fin = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(fin.status, 200);

    const after = await tagsByName();
    assert.equal(after["Jane Doe"], 11);
    assert.equal(after["Ann Poe"], 42);
    assert.equal(
      after["John Roe"],
      null,
      "the non-participant whose tag was brought in is left tagless"
    );
  });
});
