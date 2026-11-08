import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../db/client.js";
import { api, resetDb, startTestServer, stopTestServer } from "../test/helpers.js";

// Integration tests for the league calendar and the site banner — both are
// public to read and admin-only to write. These need a database; see `npm test`.

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

async function addEvent(body: Record<string, unknown>) {
  const res = await api("POST", "/api/admin/calendar", { admin: true, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: number };
}

describe("calendar", () => {
  test("lists events from the given date, soonest first, untimed last", async () => {
    await addEvent({ date: "2026-11-20", course: "Later" });
    await addEvent({ date: "2026-11-14" }); // no time
    await addEvent({ date: "2026-11-14", startTime: "10:00", course: "Morning" });
    await addEvent({ date: "2026-11-01", course: "Already past" });

    const res = await api("GET", "/api/calendar?from=2026-11-08");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((e: any) => [e.date, e.startTime, e.course]),
      [
        ["2026-11-14", "10:00", "Morning"],
        ["2026-11-14", null, null],
        ["2026-11-20", null, "Later"],
      ]
    );
  });

  test("honours an upper bound", async () => {
    await addEvent({ date: "2026-11-14" });
    await addEvent({ date: "2026-12-14" });
    const res = await api("GET", "/api/calendar?from=2026-11-01&to=2026-11-30");
    assert.deepEqual(res.body.map((e: any) => e.date), ["2026-11-14"]);
  });

  test("rejects a malformed from", async () => {
    const res = await api("GET", "/api/calendar?from=next-tuesday");
    assert.equal(res.status, 400);
  });

  test("writes need an admin", async () => {
    const anon = await api("POST", "/api/admin/calendar", { body: { date: "2026-11-14" } });
    assert.equal(anon.status, 401);
    const stranger = await api("POST", "/api/admin/calendar", {
      body: { date: "2026-11-14" },
      headers: { "Cf-Access-Authenticated-User-Email": "someone@else.test" },
    });
    assert.equal(stranger.status, 403);
  });

  test("validates the date, time and field lengths", async () => {
    for (const body of [
      {},
      { date: "2026-02-31" },
      { date: "2026-11-14", startTime: "25:00" },
      { date: "2026-11-14", startTime: "9am" },
      { date: "2026-11-14", notes: "x".repeat(501) },
    ]) {
      const res = await api("POST", "/api/admin/calendar", { admin: true, body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  test("blank optional fields are stored as null", async () => {
    const res = await api("POST", "/api/admin/calendar", {
      admin: true,
      body: { date: "2026-11-14", startTime: "", title: "  ", course: "", notes: "" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.startTime, null);
    assert.equal(res.body.title, null);
    assert.equal(res.body.course, null);
    assert.equal(res.body.notes, null);
  });

  test("edit changes only the fields sent, and can clear one", async () => {
    const { id } = await addEvent({
      date: "2026-11-14",
      startTime: "10:00",
      course: "Valley",
      notes: "Bring $2",
    });
    const res = await api("PATCH", `/api/admin/calendar/${id}`, {
      admin: true,
      body: { startTime: "11:30", notes: null },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.date, "2026-11-14");
    assert.equal(res.body.course, "Valley");
    assert.equal(res.body.startTime, "11:30");
    assert.equal(res.body.notes, null);

    const empty = await api("PATCH", `/api/admin/calendar/${id}`, { admin: true, body: {} });
    assert.equal(empty.status, 400);
    const missing = await api("PATCH", "/api/admin/calendar/999", {
      admin: true,
      body: { course: "x" },
    });
    assert.equal(missing.status, 404);
  });

  test("delete removes it", async () => {
    const { id } = await addEvent({ date: "2026-11-14" });
    const del = await api("DELETE", `/api/admin/calendar/${id}`, { admin: true });
    assert.equal(del.status, 204);
    const again = await api("DELETE", `/api/admin/calendar/${id}`, { admin: true });
    assert.equal(again.status, 404);
    const list = await api("GET", "/api/calendar?from=2026-01-01");
    assert.deepEqual(list.body, []);
  });
});

describe("site banner", () => {
  test("is null until one is set", async () => {
    const res = await api("GET", "/api/banner");
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });

  test("set, replace and remove", async () => {
    const set = await api("PUT", "/api/admin/banner", {
      admin: true,
      body: {
        message: "Valley course closed Nov 10–12",
        linkUrl: "#/calendar",
        linkLabel: "See calendar",
        startsOn: "2026-11-08",
        endsOn: "2026-11-12",
      },
    });
    assert.equal(set.status, 200);
    let got = await api("GET", "/api/banner");
    assert.equal(got.body.message, "Valley course closed Nov 10–12");
    assert.equal(got.body.linkUrl, "#/calendar");
    assert.equal(got.body.endsOn, "2026-11-12");
    assert.equal("updatedBy" in got.body, false, "the admin's email is never served");

    // A second PUT replaces the whole thing — omitted fields become null.
    await api("PUT", "/api/admin/banner", {
      admin: true,
      body: { message: "Sign up for the turkey shoot" },
    });
    got = await api("GET", "/api/banner");
    assert.equal(got.body.message, "Sign up for the turkey shoot");
    assert.equal(got.body.linkUrl, null);
    assert.equal(got.body.startsOn, null);

    const del = await api("DELETE", "/api/admin/banner", { admin: true });
    assert.equal(del.status, 204);
    got = await api("GET", "/api/banner");
    assert.equal(got.body, null);
    // Removing nothing is fine too.
    assert.equal((await api("DELETE", "/api/admin/banner", { admin: true })).status, 204);
  });

  test("writes need an admin", async () => {
    const put = await api("PUT", "/api/admin/banner", { body: { message: "hi" } });
    assert.equal(put.status, 401);
    const del = await api("DELETE", "/api/admin/banner");
    assert.equal(del.status, 401);
  });

  test("refuses links that could run script", async () => {
    for (const linkUrl of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "//evil.example",
      "calendar",
    ]) {
      const res = await api("PUT", "/api/admin/banner", {
        admin: true,
        body: { message: "hi", linkUrl },
      });
      assert.equal(res.status, 400, `expected ${linkUrl} to be refused`);
    }
    for (const linkUrl of ["https://example.com/signup", "#/calendar", "/sw.js"]) {
      const res = await api("PUT", "/api/admin/banner", {
        admin: true,
        body: { message: "hi", linkUrl },
      });
      assert.equal(res.status, 200, `expected ${linkUrl} to be accepted`);
    }
  });

  test("validates message and dates", async () => {
    for (const body of [
      { message: "   " },
      { message: "x".repeat(281) },
      { message: "hi", startsOn: "soon" },
      { message: "hi", startsOn: "2026-11-12", endsOn: "2026-11-10" },
    ]) {
      const res = await api("PUT", "/api/admin/banner", { admin: true, body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  test("a link label without a link is dropped", async () => {
    const res = await api("PUT", "/api/admin/banner", {
      admin: true,
      body: { message: "hi", linkLabel: "Tap here" },
    });
    assert.equal(res.body.linkLabel, null);
  });
});
