import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { rounds, tags } from "../db/schema.js";
import { codeFailureLimiter } from "../middleware/requireRoundCode.js";
import {
  ADMIN_EMAIL,
  api,
  addPlayer,
  checkIn,
  enterRound,
  openRound,
  resetDb,
  signUp,
  startTestServer,
  stopTestServer,
} from "../test/helpers.js";

// Integration tests for the live-round flow: the write path that lets players
// at the course check in and enter scores without an admin.
// These need a database — see `npm test`.
//
// Everything here runs with REQUIRE_ROUND_CODE ON, which is NOT the shipped
// default (see src/config.ts) — the gate is what most of this file is about,
// and it can only be tested where it exists. The last describe turns it off
// and covers the default config: what a code still does when nobody has to
// type one, and what stops the gate's absence from widening the tier.

before(async () => {
  process.env.REQUIRE_ROUND_CODE = "true";
  await startTestServer();
});
// Both halves matter: the server holds a listening socket and the db holds a
// pool of idle ones, and either keeps the event loop alive forever.
after(async () => {
  delete process.env.REQUIRE_ROUND_CODE;
  await stopTestServer();
  await closeDb();
});
beforeEach(async () => {
  await resetDb();
});

// Each test uses its own client IP so one test's failed-code attempts can't
// exhaust another's budget (the limiter is per-process and per-IP).
let ipCounter = 0;
const freshIp = () => `10.0.0.${++ipCounter % 250}${Date.now() % 1000}`;

describe("the join code never leaks", () => {
  test("no public round response carries it", async () => {
    const round = await openRound();
    assert.ok(round.joinCode, "admin create should return a code");

    const paths = ["/api/rounds", "/api/rounds/live", `/api/rounds/${round.id}`];
    for (const path of paths) {
      const res = await api("GET", path);
      assert.equal(res.status, 200, path);
      const serialized = JSON.stringify(res.body);
      assert.ok(
        !serialized.includes(round.joinCode!),
        `${path} leaked the join code`
      );
      assert.ok(
        !serialized.includes("joinCode"),
        `${path} exposed a joinCode field`
      );
    }
  });

  test("the round detail reports joinability without the code", async () => {
    const round = await openRound();
    const res = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(res.body.joinable, true);
    assert.equal(res.body.status, "open");
  });

  test("joining with a valid code still doesn't echo it back", async () => {
    const round = await openRound();
    const res = await api("POST", "/api/rounds/join", {
      body: { code: round.joinCode },
      ip: freshIp(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, round.id);
    assert.ok(!JSON.stringify(res.body).includes(round.joinCode!));
  });
});

describe("the code gate", () => {
  test("rejects a missing code", async () => {
    const round = await openRound();
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      body: { playerId: 1, tagNumber: 5 },
      ip: freshIp(),
    });
    assert.equal(res.status, 401);
  });

  test("rejects a wrong code", async () => {
    const round = await openRound();
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: "ZZZZ",
      body: { playerId: 1, tagNumber: 5 },
      ip: freshIp(),
    });
    assert.equal(res.status, 401);
  });

  test("a code is scoped to its own round", async () => {
    const a = await openRound({ date: "2026-07-28", course: "A" });
    const b = await openRound({ date: "2026-07-28", course: "B" });
    const player = await addPlayer("Rey", 12);

    const res = await api("POST", `/api/rounds/${b.id}/checkin`, {
      code: a.joinCode!, // valid code, wrong round
      body: { playerId: player.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 401, "round A's code must not write to round B");
  });

  test("rejects an expired code", async () => {
    const round = await openRound();
    await db
      .update(rounds)
      .set({ codeExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(rounds.id, round.id));

    const player = await addPlayer("Rey", 12);
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: player.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /expired/i);
  });

  test("rejects a revoked code", async () => {
    const round = await openRound();
    const player = await addPlayer("Rey", 12);
    const revoked = await api("POST", `/api/admin/rounds/${round.id}/code`, {
      admin: true,
      body: { action: "revoke" },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.joinCode, null);

    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: player.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 403);
  });

  test("rotating invalidates the old code and issues a new one", async () => {
    const round = await openRound();
    const player = await addPlayer("Rey", 12);
    const rotated = await api("POST", `/api/admin/rounds/${round.id}/code`, {
      admin: true,
      body: { action: "rotate" },
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.joinCode, round.joinCode);

    const old = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: player.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(old.status, 401, "the old code must stop working");

    const fresh = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: rotated.body.joinCode,
      body: { playerId: player.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(fresh.status, 201);
  });

  test("code holders cannot reach admin routes", async () => {
    const round = await openRound();
    // The code authorizes entry edits on one round — nothing else. Without an
    // Access identity these are 401 regardless of what code is presented.
    const attempts = [
      api("POST", `/api/rounds/${round.id}/finalize`, { code: round.joinCode! }),
      api("POST", "/api/admin/rounds", {
        code: round.joinCode!,
        body: { date: "2026-07-28" },
      }),
      api("POST", "/api/admin/players", {
        code: round.joinCode!,
        body: { name: "Sneak", tagNumber: 99 },
      }),
      api("POST", `/api/admin/rounds/${round.id}/finalize`, {
        code: round.joinCode!,
      }),
    ];
    const results = await Promise.all(attempts);
    assert.equal(results[0].status, 404, "no player-facing finalize route");
    for (const r of results.slice(1)) {
      assert.equal(r.status, 401, "admin routes need an Access identity");
    }
  });

  test("blocks after repeated wrong codes, then recovers on reset", async () => {
    const round = await openRound();
    const ip = freshIp();
    codeFailureLimiter.reset(ip);

    let sawBlock = false;
    for (let i = 0; i < 12; i++) {
      const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
        code: "ZZZZ",
        body: { playerId: 1, tagNumber: 5 },
        ip,
      });
      if (res.status === 429) {
        sawBlock = true;
        break;
      }
      assert.equal(res.status, 401);
    }
    assert.ok(sawBlock, "guessing should eventually be rate limited");

    // A different IP is unaffected — the block is per client, not global.
    const other = await api("POST", "/api/rounds/join", {
      body: { code: round.joinCode },
      ip: freshIp(),
    });
    assert.equal(other.status, 200);
  });

  test("join rate-limits unknown codes too", async () => {
    const ip = freshIp();
    codeFailureLimiter.reset(ip);
    let sawBlock = false;
    for (let i = 0; i < 12; i++) {
      const res = await api("POST", "/api/rounds/join", {
        body: { code: "ZZZZ" },
        ip,
      });
      if (res.status === 429) {
        sawBlock = true;
        break;
      }
      assert.equal(res.status, 404);
    }
    assert.ok(sawBlock, "the join route maps the code space and must be limited");
  });
});

describe("signing up", () => {
  test("signs a player up and shows them in the public round", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);

    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12, acePool: true, ctp: false },
      ip: freshIp(),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.playerName, "Rey");
    assert.equal(res.body.incomingNumber, 12);
    assert.equal(res.body.acePool, true);
    assert.equal(res.body.checkedIn, false, "signing up is not being in the round");

    const round_ = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(round_.body.entries.length, 1);
  });

  test("rejects a player not on the roster", async () => {
    const round = await openRound();
    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: 9999, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /roster/i);
  });

  test("rejects a tag number outside the pool", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    for (const tagNumber of [0, 301, 1.5, "abc"]) {
      const res = await api("POST", `/api/rounds/${round.id}/signup`, {
        code: round.joinCode!,
        body: { playerId: rey.id, tagNumber },
        ip: freshIp(),
      });
      assert.equal(res.status, 400, `tagNumber=${tagNumber}`);
    }
  });

  test("rejects the same player twice", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const first = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(first.status, 201);

    const second = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 40 },
      ip: freshIp(),
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already signed up/i);
  });

  test("rejects two players bringing the same tag", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);

    await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    const clash = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: sam.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already spoken for/i);
  });

  test("concurrent signups on one tag: exactly one wins", async () => {
    // The real hazard of a live round. Both requests pass the application-level
    // checks before either inserts, so only the database constraint can decide
    // this — a duplicated incoming tag would corrupt the redistribution, since
    // the pool of tags to hand out IS the set of incoming tags.
    const round = await openRound();
    const contenders = await Promise.all([
      addPlayer("Rey", 12),
      addPlayer("Sam", 40),
      addPlayer("Ada", 77),
      addPlayer("Kim", 91),
    ]);

    const results = await Promise.all(
      contenders.map((p) =>
        api("POST", `/api/rounds/${round.id}/signup`, {
          code: round.joinCode!,
          body: { playerId: p.id, tagNumber: 55 },
          ip: freshIp(),
        })
      )
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(created.length, 1, "exactly one signup may claim tag #55");
    assert.equal(rejected.length, 3);

    const detail = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(detail.body.entries.length, 1);
  });
});

describe("score editing", () => {
  // Checked in, not merely signed up: a score is only accepted from a player
  // the tag table has confirmed.
  async function roundWithPlayers() {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);
    const entries = [];
    for (const [p, tag] of [
      [rey, 12],
      [sam, 40],
    ] as const) {
      entries.push(
        await enterRound(
          round.id,
          round.joinCode!,
          { playerId: p.id, tagNumber: tag },
          freshIp()
        )
      );
    }
    return { round, entries };
  }

  test("anyone with the code can edit anyone's score", async () => {
    // One person keeps the card for the whole group, so this is the feature,
    // not a hole.
    const { round, entries } = await roundWithPlayers();
    for (const [i, score] of [54, 61].entries()) {
      const res = await api(
        "PATCH",
        `/api/rounds/${round.id}/entries/${entries[i].id}`,
        { code: round.joinCode!, body: { score }, ip: freshIp() }
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.score, score);
    }
  });

  test("a null score means DNF", async () => {
    const { round, entries } = await roundWithPlayers();
    await api("PATCH", `/api/rounds/${round.id}/entries/${entries[0].id}`, {
      code: round.joinCode!,
      body: { score: 54 },
      ip: freshIp(),
    });
    const res = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { score: null }, ip: freshIp() }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.score, null);
  });

  test("rejects a fractional score at the door", async () => {
    const { round, entries } = await roundWithPlayers();
    const res = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { score: 54.5 }, ip: freshIp() }
    );
    assert.equal(res.status, 400);
  });

  test("bumps updatedAt so pollers can tell something changed", async () => {
    const { round, entries } = await roundWithPlayers();
    const before = entries[0].updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const res = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { score: 54 }, ip: freshIp() }
    );
    assert.notEqual(res.body.updatedAt, before);
  });

  test("won't touch an entry from another round", async () => {
    const { entries } = await roundWithPlayers();
    const other = await openRound({ date: "2026-07-29", course: "Elsewhere" });
    const res = await api(
      "PATCH",
      `/api/rounds/${other.id}/entries/${entries[0].id}`,
      { code: other.joinCode!, body: { score: 1 }, ip: freshIp() }
    );
    assert.equal(res.status, 404);
  });

  test("correcting an incoming tag respects the no-duplicates rule", async () => {
    // Signups, not check-ins: fixing a mistyped tag is what the window before
    // the tag table confirms you is for. Afterwards the number is locked.
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);
    const entries = [
      await signUp(round.id, round.joinCode!, { playerId: rey.id, tagNumber: 12 }, freshIp()),
      await signUp(round.id, round.joinCode!, { playerId: sam.id, tagNumber: 40 }, freshIp()),
    ];
    const clash = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { tagNumber: 40 }, ip: freshIp() }
    );
    assert.equal(clash.status, 409);

    const ok = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { tagNumber: 99 }, ip: freshIp() }
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.incomingNumber, 99);
  });

  test("removing a player frees their tag", async () => {
    const { round, entries } = await roundWithPlayers();
    const del = await api(
      "DELETE",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, ip: freshIp() }
    );
    assert.equal(del.status, 204);

    const ada = await addPlayer("Ada", 77);
    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: ada.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 201, "the freed tag should be claimable again");
  });
});

// The second step: an admin — the person at the round collecting physical tags
// and pool money — confirming who is actually playing. A signup is an
// announcement; only a check-in puts someone in the field.
describe("two-step check-in", () => {
  async function roundWithSignups() {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);
    const entries = [
      await signUp(round.id, round.joinCode!, { playerId: rey.id, tagNumber: 12 }, freshIp()),
      await signUp(round.id, round.joinCode!, { playerId: sam.id, tagNumber: 40 }, freshIp()),
    ];
    return { round, entries, players: { rey, sam } };
  }

  test("a signup is counted apart from the field", async () => {
    const { round, entries } = await roundWithSignups();
    const before = await api("GET", "/api/rounds/live");
    assert.equal(before.body[0].playerCount, 0, "nobody is in the round yet");
    assert.equal(before.body[0].pendingCount, 2);

    await checkIn(round.id, [entries[0].id]);
    const after = await api("GET", "/api/rounds/live");
    assert.equal(after.body[0].playerCount, 1);
    assert.equal(after.body[0].pendingCount, 1);
  });

  test("a code holder cannot score a signup, and can once it's checked in", async () => {
    const { round, entries } = await roundWithSignups();
    const early = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { score: 54 }, ip: freshIp() }
    );
    assert.equal(early.status, 409);
    assert.match(early.body.error, /check in/i);

    await checkIn(round.id, [entries[0].id]);
    const ok = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { score: 54 }, ip: freshIp() }
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.score, 54);
  });

  test("a checked-in player's tag and pools are locked to code holders", async () => {
    // What the person at the table verified: the physical tag they saw and the
    // dollar they took. A player editing either afterwards would put the
    // record out of step with the cash box.
    const { round, entries } = await roundWithSignups();
    await checkIn(round.id, [entries[0].id]);

    for (const body of [{ tagNumber: 99 }, { acePool: true }, { ctp: true }]) {
      const res = await api(
        "PATCH",
        `/api/rounds/${round.id}/entries/${entries[0].id}`,
        { code: round.joinCode!, body, ip: freshIp() }
      );
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.match(res.body.error, /locked/i);
    }

    // An admin still can — corrections are theirs to make.
    const fixed = await api(
      "PATCH",
      `/api/admin/rounds/${round.id}/entries/${entries[0].id}`,
      { admin: true, body: { acePool: true } }
    );
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.acePool, true);
  });

  test("a signup can still fix its own tag and pools", async () => {
    const { round, entries } = await roundWithSignups();
    const res = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entries[0].id}`,
      { code: round.joinCode!, body: { tagNumber: 99, acePool: true }, ip: freshIp() }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.incomingNumber, 99);
    assert.equal(res.body.acePool, true);
  });

  test("an admin patch that names no known field is refused, not fatal", async () => {
    // The admin route takes incomingTagId, not tagNumber. Naming the wrong
    // field used to build an empty patch, and drizzle throws on .set({}) —
    // inside an async handler with no catch, that took the whole API down
    // mid-round. Found by walking this flow by hand on the dev stack.
    const { round, entries } = await roundWithSignups();
    const res = await api(
      "PATCH",
      `/api/admin/rounds/${round.id}/entries/${entries[0].id}`,
      { admin: true, body: { tagNumber: 99 } }
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /nothing to update/i);

    // Still serving.
    const health = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(health.status, 200);
  });

  test("checking in is admin work — a code holder cannot do it", async () => {
    const { round, entries } = await roundWithSignups();
    const res = await api("POST", `/api/admin/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { entryIds: [entries[0].id] },
      ip: freshIp(),
    });
    assert.equal(res.status, 401, "the round code authorizes nothing under /admin");

    const detail = await api("GET", `/api/rounds/${round.id}`);
    assert.ok(detail.body.entries.every((e: any) => e.checkedIn === false));
  });

  test("an admin can undo a mis-tap", async () => {
    const { round, entries } = await roundWithSignups();
    await checkIn(round.id, [entries[0].id]);
    const res = await api("POST", `/api/admin/rounds/${round.id}/checkin`, {
      admin: true,
      body: { entryIds: [entries[0].id], checkedIn: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.entries[0].checkedIn, false);
  });

  test("check-in is scoped to its own round", async () => {
    const { entries } = await roundWithSignups();
    const other = await openRound({ date: "2026-07-29", course: "Elsewhere" });
    const res = await api("POST", `/api/admin/rounds/${other.id}/checkin`, {
      admin: true,
      body: { entryIds: [entries[0].id] },
    });
    assert.equal(res.status, 404);
  });

  test("checking in is refused once check-in closes", async () => {
    const { round, entries } = await roundWithSignups();
    await checkIn(round.id, [entries[0].id]);
    await api("PATCH", `/api/admin/rounds/${round.id}`, {
      admin: true,
      body: { status: "scoring" },
    });
    const res = await api("POST", `/api/admin/rounds/${round.id}/checkin`, {
      admin: true,
      body: { entryIds: [entries[1].id] },
    });
    assert.equal(res.status, 409);
  });

  test("closing check-in drops whoever never checked in", async () => {
    const { round, entries } = await roundWithSignups();
    await checkIn(round.id, [entries[0].id]);

    const closed = await api("PATCH", `/api/admin/rounds/${round.id}`, {
      admin: true,
      body: { status: "scoring" },
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.droppedPending, 1);

    const detail = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(detail.body.entries.length, 1);
    assert.equal(detail.body.entries[0].playerName, "Rey");
  });

  test("finalizing drops them too, and ranks only the field", async () => {
    // The other door out of the check-in phase: an admin can finalize straight
    // from "open" without closing check-in first.
    const { round, entries } = await roundWithSignups();
    await checkIn(round.id, [entries[0].id]);
    await api("PATCH", `/api/rounds/${round.id}/entries/${entries[0].id}`, {
      code: round.joinCode!,
      body: { score: 54 },
      ip: freshIp(),
    });

    const res = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.droppedPending, 1);
    assert.equal(res.body.entries.length, 1);

    // The pool was {12} — Rey's alone. Sam signed up and never checked in, so
    // #40 never entered the redistribution and is still theirs.
    const standings = await api("GET", "/api/standings");
    const byName = new Map(
      standings.body.map((r: any) => [r.playerName, r.tagNumber])
    );
    assert.equal(byName.get("Rey"), 12);
    assert.equal(byName.get("Sam"), 40, "a signup's tag is not in the pool");
  });

  test("refuses to finalize a round of signups nobody checked in", async () => {
    const { round } = await roundWithSignups();
    const res = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /checked in/i);

    // And it left the round alone rather than half-finalizing it.
    const detail = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(detail.body.status, "open");
  });

  test("an admin adding a player checks them in outright", async () => {
    const round = await openRound();
    const ada = await addPlayer("Ada", 77);
    const [tag] = await db.select().from(tags).where(eq(tags.number, 77));
    const res = await api("POST", `/api/admin/rounds/${round.id}/entries`, {
      admin: true,
      body: { playerId: ada.id, incomingTagId: tag.id },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkedIn, true);
  });

  test("the old /checkin path still signs a player up", async () => {
    // A service-worker-cached index.html on somebody's phone is still posting
    // here. It must keep working, and must mean what /signup means.
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkedIn, false);
  });

  test("no response carries who checked a player in", async () => {
    // checked_in_by is an admin's email. Same rule as the join code: the fact
    // is public, the value is not.
    const { round, entries } = await roundWithSignups();
    const confirmed = await checkIn(round.id, [entries[0].id]);
    assert.ok(!JSON.stringify(confirmed).includes(ADMIN_EMAIL));

    const paths = [
      "/api/rounds",
      "/api/rounds/live",
      `/api/rounds/${round.id}`,
    ];
    for (const path of paths) {
      const res = await api("GET", path);
      assert.ok(
        !JSON.stringify(res.body).includes(ADMIN_EMAIL),
        `${path} leaked the checking-in admin`
      );
    }

    const finalized = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.ok(
      !JSON.stringify(finalized.body).includes(ADMIN_EMAIL),
      "finalize leaked the checking-in admin"
    );
  });
});

describe("closing check-in", () => {
  async function scoringRound() {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const entry = await enterRound(
      round.id,
      round.joinCode!,
      { playerId: rey.id, tagNumber: 12 },
      freshIp()
    );
    const patched = await api("PATCH", `/api/admin/rounds/${round.id}`, {
      admin: true,
      body: { status: "scoring" },
    });
    assert.equal(patched.status, 200);
    return { round, entry };
  }

  test("blocks new signups", async () => {
    // A late joiner changes the tag pool, and so what everyone else can win.
    const { round } = await scoringRound();
    const sam = await addPlayer("Sam", 40);
    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: sam.id, tagNumber: 40 },
      ip: freshIp(),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /check-in is closed/i);
  });

  test("blocks removals and incoming-tag edits", async () => {
    const { round, entry } = await scoringRound();
    const del = await api(
      "DELETE",
      `/api/rounds/${round.id}/entries/${entry.id}`,
      { code: round.joinCode!, ip: freshIp() }
    );
    assert.equal(del.status, 409);

    // Two rules point the same way here: the round is past check-in, and this
    // entry is checked in. The check-in lock is what answers first now — any
    // entry that survives into the scoring phase is by definition confirmed,
    // since closing check-in drops the rest.
    const retag = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entry.id}`,
      { code: round.joinCode!, body: { tagNumber: 99 }, ip: freshIp() }
    );
    assert.equal(retag.status, 409);
  });

  test("still allows score entry — that's the point of the phase", async () => {
    const { round, entry } = await scoringRound();
    const res = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entry.id}`,
      { code: round.joinCode!, body: { score: 54 }, ip: freshIp() }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.score, 54);
  });
});

describe("finalizing a live round", () => {
  async function playedRound() {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);
    const ada = await addPlayer("Ada", 77);
    for (const [p, tag, score] of [
      [rey, 12, 61],
      [sam, 40, 54],
      [ada, 77, 58],
    ] as const) {
      const e = await enterRound(
        round.id,
        round.joinCode!,
        { playerId: p.id, tagNumber: tag },
        freshIp()
      );
      await api("PATCH", `/api/rounds/${round.id}/entries/${e.id}`, {
        code: round.joinCode!,
        body: { score },
        ip: freshIp(),
      });
    }
    return { round, players: { rey, sam, ada } };
  }

  test("redistributes tags by score and updates standings", async () => {
    const { round, players } = await playedRound();
    const res = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "finalized");

    // Pool is {12, 40, 77}; best score takes the lowest tag.
    const standings = await api("GET", "/api/standings");
    const byName = new Map(
      standings.body.map((r: any) => [r.playerName, r.tagNumber])
    );
    assert.equal(byName.get("Sam"), 12, "54 was the best score");
    assert.equal(byName.get("Ada"), 40);
    assert.equal(byName.get("Rey"), 77, "61 was the worst score");
    assert.equal(standings.body.length, 3);
    void players;
  });

  test("clears the code, ending player write access", async () => {
    const { round } = await playedRound();
    await api("POST", `/api/admin/rounds/${round.id}/finalize`, { admin: true });

    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      code: round.joinCode!,
      body: { playerId: 1, tagNumber: 5 },
      ip: freshIp(),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /finalized/i);

    const code = await api("GET", `/api/admin/rounds/${round.id}/code`, {
      admin: true,
    });
    assert.equal(code.body.joinCode, null);
  });

  test("a finalized round drops off the live list", async () => {
    const { round } = await playedRound();
    const before = await api("GET", "/api/rounds/live");
    assert.equal(before.body.length, 1);

    await api("POST", `/api/admin/rounds/${round.id}/finalize`, { admin: true });
    const after = await api("GET", "/api/rounds/live");
    assert.equal(after.body.length, 0);
  });

  test("finalizing twice is refused, not applied twice", async () => {
    const { round } = await playedRound();
    const first = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(first.status, 200);

    const second = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(second.status, 409);

    // Standings must reflect one redistribution, not two.
    const standings = await api("GET", "/api/standings");
    const byName = new Map(
      standings.body.map((r: any) => [r.playerName, r.tagNumber])
    );
    assert.equal(byName.get("Sam"), 12);
    assert.equal(byName.get("Ada"), 40);
    assert.equal(byName.get("Rey"), 77);
  });

  test("concurrent finalizes redistribute exactly once", async () => {
    const { round } = await playedRound();
    const results = await Promise.all([
      api("POST", `/api/admin/rounds/${round.id}/finalize`, { admin: true }),
      api("POST", `/api/admin/rounds/${round.id}/finalize`, { admin: true }),
      api("POST", `/api/admin/rounds/${round.id}/finalize`, { admin: true }),
    ]);
    assert.equal(
      results.filter((r) => r.status === 200).length,
      1,
      "only one finalize may succeed"
    );

    const standings = await api("GET", "/api/standings");
    const byName = new Map(
      standings.body.map((r: any) => [r.playerName, r.tagNumber])
    );
    assert.equal(byName.get("Sam"), 12);
    assert.equal(byName.get("Rey"), 77);
  });

  test("refuses to finalize an empty round", async () => {
    const round = await openRound();
    const res = await api("POST", `/api/admin/rounds/${round.id}/finalize`, {
      admin: true,
    });
    assert.equal(res.status, 400);
  });
});

describe("admin round creation", () => {
  test("opens with a code by default and records who opened it", async () => {
    const round = await openRound();
    assert.ok(round.joinCode);
    assert.equal(round.status, "open");
    assert.ok(round.codeExpiresAt, "a code should carry an expiry");

    const [row] = await db.select().from(rounds).where(eq(rounds.id, round.id));
    assert.equal(row.createdBy, "admin@test.local");
  });

  test("can open without a code", async () => {
    const round = await openRound({ date: "2026-07-28", withCode: false });
    assert.equal(round.joinCode, null);

    const live = await api("GET", "/api/rounds/live");
    assert.equal(live.body.length, 0, "a codeless round isn't joinable");
  });

  test("requires an admin identity", async () => {
    const res = await api("POST", "/api/admin/rounds", {
      body: { date: "2026-07-28" },
    });
    assert.equal(res.status, 401);
  });

  test("issues distinct codes", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const r = await openRound({ date: "2026-07-28" });
      codes.add(r.joinCode!);
    }
    assert.equal(codes.size, 15);
  });
});

// The shipped default: REQUIRE_ROUND_CODE unset. Players write without a code,
// and the code keeps its OTHER job — marking a round open to players — so the
// flag can be flipped back on a round that is already running.
describe("with the code gate off", () => {
  before(() => {
    delete process.env.REQUIRE_ROUND_CODE;
  });
  after(() => {
    process.env.REQUIRE_ROUND_CODE = "true";
  });

  test("/api/config tells the frontend which join flow to paint", async () => {
    const off = await api("GET", "/api/config");
    assert.equal(off.body.requireRoundCode, false);

    process.env.REQUIRE_ROUND_CODE = "true";
    const on = await api("GET", "/api/config");
    assert.equal(on.body.requireRoundCode, true);
    delete process.env.REQUIRE_ROUND_CODE;
  });

  test("signup, scoring and removal need no code", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);

    const entry = await api("POST", `/api/rounds/${round.id}/signup`, {
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(entry.status, 201);
    // Checking in is admin work either way — the code gate was never what
    // guarded it, so dropping the code doesn't hand it to a player.
    await checkIn(round.id, [entry.body.id]);

    const scored = await api(
      "PATCH",
      `/api/rounds/${round.id}/entries/${entry.body.id}`,
      { body: { score: 54 }, ip: freshIp() }
    );
    assert.equal(scored.status, 200);
    assert.equal(scored.body.score, 54);

    const removed = await api(
      "DELETE",
      `/api/rounds/${round.id}/entries/${entry.body.id}`,
      { ip: freshIp() }
    );
    assert.equal(removed.status, 204);
  });

  test("a wrong code is ignored rather than counted against the caller", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const ip = freshIp();
    codeFailureLimiter.reset(ip);

    // Well past the 10-failure budget: with nothing to guess there is nothing
    // to rate limit, and a stale code in a bookmarked link must not lock its
    // owner out of a round they're allowed to write to.
    for (let i = 0; i < 12; i++) {
      const res = await api("POST", `/api/rounds/${round.id}/signup`, {
        code: "ZZZZ",
        body: { playerId: rey.id, tagNumber: 12 },
        ip,
      });
      assert.equal(res.status, i === 0 ? 201 : 409, `attempt ${i}`);
    }
  });

  test("revoking still closes the round to players", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    await api("POST", `/api/admin/rounds/${round.id}/code`, {
      admin: true,
      body: { action: "revoke" },
    });

    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 403, "no code on the round means no player writes");
  });

  test("an expired code still closes the round to players", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    await db
      .update(rounds)
      .set({ codeExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(rounds.id, round.id));

    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 403, "the expiry is what bounds an open round");
  });

  test("a finalized round takes no more writes", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    await enterRound(round.id, undefined, { playerId: rey.id, tagNumber: 12 }, freshIp());
    await api("POST", `/api/admin/rounds/${round.id}/finalize`, { admin: true });

    const res = await api("POST", `/api/rounds/${round.id}/signup`, {
      body: { playerId: rey.id, tagNumber: 40 },
      ip: freshIp(),
    });
    assert.equal(res.status, 409);
  });

  test("writes still reach one round's entries and nothing else", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const entry = await api("POST", `/api/rounds/${round.id}/signup`, {
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    const other = await openRound({ date: "2026-07-29", course: "Elsewhere" });

    const crossRound = await api(
      "PATCH",
      `/api/rounds/${other.id}/entries/${entry.body.id}`,
      { body: { score: 1 }, ip: freshIp() }
    );
    assert.equal(crossRound.status, 404, "an entry belongs to its own round");

    // The tier is still a tier: dropping the code doesn't hand a player the
    // roster, tag status, or the finalize button.
    const admin = await Promise.all([
      api("POST", `/api/rounds/${round.id}/finalize`, { ip: freshIp() }),
      api("POST", "/api/admin/rounds", {
        body: { date: "2026-07-29" },
        ip: freshIp(),
      }),
      api("POST", "/api/admin/players", {
        body: { name: "Sneak", tagNumber: 99 },
        ip: freshIp(),
      }),
      api("POST", `/api/admin/rounds/${round.id}/finalize`, { ip: freshIp() }),
    ]);
    assert.equal(admin[0].status, 404, "no player-facing finalize route");
    for (const r of admin.slice(1)) {
      assert.equal(r.status, 401, "admin routes still need an Access identity");
    }
  });

  test("the code still isn't in any public response", async () => {
    const round = await openRound();
    for (const path of ["/api/rounds", "/api/rounds/live", `/api/rounds/${round.id}`]) {
      const res = await api("GET", path);
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(round.joinCode!), `${path} leaked the code`);
    }
  });

  test("a link's code is accepted, so old join links keep working", async () => {
    const round = await openRound();
    const res = await api("POST", "/api/rounds/join", {
      body: { code: round.joinCode },
      ip: freshIp(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, round.id);
  });
});
