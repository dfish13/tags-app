import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { rounds } from "../db/schema.js";
import { codeFailureLimiter } from "../middleware/requireRoundCode.js";
import {
  api,
  addPlayer,
  openRound,
  resetDb,
  startTestServer,
  stopTestServer,
} from "../test/helpers.js";

// Integration tests for the live-round flow: the code-gated write path that
// lets players at the course check in and enter scores without an admin.
// These need a database — see `npm test`.

before(async () => {
  await startTestServer();
});
// Both halves matter: the server holds a listening socket and the db holds a
// pool of idle ones, and either keeps the event loop alive forever.
after(async () => {
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
      code: "ZZZZZZ",
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
        code: "ZZZZZZ",
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
        body: { code: "ZZZZZZ" },
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

describe("check-in", () => {
  test("checks a player in and shows them in the public round", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);

    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12, acePool: true, ctp: false },
      ip: freshIp(),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.playerName, "Rey");
    assert.equal(res.body.incomingNumber, 12);
    assert.equal(res.body.acePool, true);

    const round_ = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(round_.body.entries.length, 1);
  });

  test("rejects a player not on the roster", async () => {
    const round = await openRound();
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
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
      const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
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
    const first = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(first.status, 201);

    const second = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 40 },
      ip: freshIp(),
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already checked in/i);
  });

  test("rejects two players bringing the same tag", async () => {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);

    await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    const clash = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: sam.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already checked in/i);
  });

  test("concurrent check-ins on one tag: exactly one wins", async () => {
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
        api("POST", `/api/rounds/${round.id}/checkin`, {
          code: round.joinCode!,
          body: { playerId: p.id, tagNumber: 55 },
          ip: freshIp(),
        })
      )
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(created.length, 1, "exactly one check-in may claim tag #55");
    assert.equal(rejected.length, 3);

    const detail = await api("GET", `/api/rounds/${round.id}`);
    assert.equal(detail.body.entries.length, 1);
  });
});

describe("score editing", () => {
  async function roundWithPlayers() {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const sam = await addPlayer("Sam", 40);
    const entries = [];
    for (const [p, tag] of [
      [rey, 12],
      [sam, 40],
    ] as const) {
      const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
        code: round.joinCode!,
        body: { playerId: p.id, tagNumber: tag },
        ip: freshIp(),
      });
      entries.push(res.body);
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
    const { round, entries } = await roundWithPlayers();
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
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: ada.id, tagNumber: 12 },
      ip: freshIp(),
    });
    assert.equal(res.status, 201, "the freed tag should be claimable again");
  });
});

describe("closing check-in", () => {
  async function scoringRound() {
    const round = await openRound();
    const rey = await addPlayer("Rey", 12);
    const entry = await api("POST", `/api/rounds/${round.id}/checkin`, {
      code: round.joinCode!,
      body: { playerId: rey.id, tagNumber: 12 },
      ip: freshIp(),
    });
    const patched = await api("PATCH", `/api/admin/rounds/${round.id}`, {
      admin: true,
      body: { status: "scoring" },
    });
    assert.equal(patched.status, 200);
    return { round, entry: entry.body };
  }

  test("blocks new check-ins", async () => {
    // A late joiner changes the tag pool, and so what everyone else can win.
    const { round } = await scoringRound();
    const sam = await addPlayer("Sam", 40);
    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
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
    const ids: number[] = [];
    for (const [p, tag, score] of [
      [rey, 12, 61],
      [sam, 40, 54],
      [ada, 77, 58],
    ] as const) {
      const e = await api("POST", `/api/rounds/${round.id}/checkin`, {
        code: round.joinCode!,
        body: { playerId: p.id, tagNumber: tag },
        ip: freshIp(),
      });
      ids.push(e.body.id);
      await api("PATCH", `/api/rounds/${round.id}/entries/${e.body.id}`, {
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

    const res = await api("POST", `/api/rounds/${round.id}/checkin`, {
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
