# Live rounds — working notes

Join-code check-in and scoring, so players at the course can enter their own
scores without an admin. Delete this file when Phase 4 lands.

**Phases 1 (backend) and 2 (live mode in the UI) are shipped and deployed.**
Phases 3–4 remain.

---

## Phase 1 — done

Commit `8d7e182`, merged to `main` and deployed to the Pi on 2026-07-28.
Migration 0002 applied in production; 50/50 tests green.

Verified live: `/api/rounds/live` returns `200` through `tags.duncanfish.co`
while `/api/admin/*` returns `302` to the Access login. Player routes are
reachable without an Access identity, admin routes are not. **That split is
load-bearing — see [Constraints](#constraints-that-must-not-be-broken).**

### Running things

Node v22.23.1 is installed but **not on `PATH`**:

```bash
export PATH="$HOME/.local/share/node-v22.23.1-linux-x64/bin:$PATH"
cd backend
npm run typecheck     # no output = clean
npm run test:db       # throwaway PG on 127.0.0.1:55433 + migrate + 50 tests (~7s)
npm run test:db:down  # destroy it
```

`resetDb()` truncates every table in whatever `DATABASE_URL` points at. Never
aim the suite at dev or production.

Production is `dfish@raspberrypi.local`, checked out at **`~/tags-app`** (not
`~/docker/tags-app`; confirm with `docker compose ls`). The two halves deploy
differently:

- **Backend** — `docker compose up -d --build api`. The container entrypoint is
  `migrate.js && seed.js && index.js`, so **deploying applies migrations
  automatically**. Previous image stays tagged, e.g.
  `tags-app-api:rollback-f34bfb2`.
- **Frontend** — `index.html` is served straight off the checkout by
  `python3 -m http.server 8080 --bind 127.0.0.1`, so **`git pull` alone ships
  it** — no rebuild, no restart. (nginx runs on the Pi but serves an unrelated
  site; it isn't in this path.)

So check `git diff --stat <deployed> origin/main` first and skip the rebuild
when nothing under `backend/` changed — that's what made Phase 2 a pull.

No cache-bust step is needed either: [sw.js](sw.js) serves navigations
network-first, so a new `index.html` is live immediately and the cache is only
an offline fallback. Don't bump `CACHE` reflexively on a frontend deploy.

---

## The API Phase 2 codes against

Player routes take the code in an **`X-Round-Code` header** — never a query
string, so codes stay out of logs and `Referer`. Admin routes use Cloudflare
Access cookies (`credentials: 'include'`), which is what the existing
`postAdmin`/`patchAdmin` helpers already do.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/rounds/live` | none | `[]` or rounds with a code. Drives the Home card |
| `POST /api/rounds/join` | body `{code}` | Code → full round. Rate-limited |
| `GET /api/rounds/:id` | none | Poll target. Round + enriched entries |
| `POST /api/rounds/:id/checkin` | code | `{playerId, tagNumber, acePool, ctp}` → `201` entry. **`open` only** |
| `PATCH /api/rounds/:id/entries/:entryId` | code | `{score, acePool, ctp, tagNumber}`. `open` or `scoring`; `tagNumber` is `open` only |
| `DELETE /api/rounds/:id/entries/:entryId` | code | **`open` only** |
| `POST /api/admin/rounds` | Access | Mints a code (12h; `withCode:false` to skip) |
| `GET\|POST /api/admin/rounds/:id/code` | Access | Read / rotate / revoke |
| `POST /api/admin/rounds/:id/finalize` | Access | Redistributes tags, clears the code |

A round object is **only** `{id, date, course, status, joinable}` — plus
`playerCount` on `/live` and `entries` on `/:id` and `/join`. `joinable` is a
computed boolean; **the join code's value is never in any response**, by
design and with a test asserting it. The UI only ever knows a code because
someone typed it or an admin just minted it.

Each entry is `{id, playerId, playerName, score, acePool, ctp, incomingNumber,
assignedNumber, updatedAt}`.

### Status codes the UI has to handle

| Code | Meaning | What the player should see |
|---|---|---|
| `401` | Bad or missing code | "That code doesn't match" — re-prompt |
| `403` | Code expired | "This round's code has expired" — needs a new one from the admin |
| `404` | Round gone / no round with that code | Drop out of live mode |
| `409` | Finalized, check-in closed, or duplicate tag/player | Message varies — **show the server's `error` string**, it's written for this |
| `429` | Too many wrong codes | Honor the `Retry-After` header |

`status` is `open` → `scoring` → `finalized`. The `open`/`scoring` split is
load-bearing: a late check-in changes the tag pool and therefore what everyone
else can win, so closing check-in has to be possible without finalizing.

---

## Frontend as it stands

Everything is one file: [index.html](index.html), 2862 lines, no build step,
no framework. Line numbers below are post-Phase-2 and will drift — grep the
name if one is off.

| What | Where | Note |
|---|---|---|
| `state`, `blankState()`, `normalizeState()` | [index.html:576](index.html:576) | `KEY = 'tags-round-v1'`; `isLive()` lives here |
| Routing (`route`/`step`) | [index.html:653](index.html:653) | `#/`, `#/round`, `#/admin`, `#/stats` |
| `addPlayer()` | [index.html:714](index.html:714) | Branches to `checkInPlayer()` when live |
| Typeahead + tag autofill | [index.html:759](index.html:759)–[819](index.html:819) | `pickSuggestion()` prefills the tag from `r.tagNumber` |
| `setScore()` | [index.html:881](index.html:881) | Calls `saveLiveScore()` when live |
| `computeResults()` | [index.html:918](index.html:918) | Reads the `state.players` global, both modes |
| `render()` | [index.html:930](index.html:930) | One big re-render; owns the finalize button |
| `adminEmail` / `refreshAdminAuth()` | [index.html:1072](index.html:1072) | Gates admin-only UI |
| `postAdmin()` / `patchAdmin()` | [index.html:1199](index.html:1199) | Access-cookie writes |
| **Live-round module** | [index.html:1242](index.html:1242)–[1830](index.html:1830) | Everything Phase 2 added, in one block |
| `liveFetch()` | [index.html:1270](index.html:1270) | The `X-Round-Code` sibling of `postAdmin` — Phase 3's outbox wraps this |
| `pollLiveRound()` / `mergeLiveRound()` | [index.html:1657](index.html:1657), [1682](index.html:1682) | Poll guard + merge rules |
| `renderLiveUi()` | [index.html:1770](index.html:1770) | Every piece of mode-dependent chrome |
| `exportRound()` / `importRound()` | [index.html:1837](index.html:1837), [1880](index.html:1880) | Unchanged, still verified working |

---

## Phase 2 — live mode in the UI (done)

Commit `035fd0f`, merged to `main` as PR #1 (`17ddc60`) and deployed to the Pi
on 2026-07-28. Frontend-only, so nothing was rebuilt and no migration ran.

Verified in production: the served `index.html` matches `main` byte-for-byte,
the page loads with no console errors, and the auth split still holds
(`/api/rounds/live` → `200`, `/api/admin/*` → `302`). **The join/check-in flow
itself is unexercised in prod** — minting a code needs an admin behind
Cloudflare Access. Smoke-test a throwaway round before relying on it.

Everything below was the plan; all of it landed. What the code actually does,
for whoever picks up Phase 3:

- `blankState()` + `normalizeState()` replaced the two round-shape literals, so
  a new field is added in one place instead of three.
- Joining stashes the local round under `tags-round-local-v1` and leaving
  restores it verbatim — that's what keeps live mode additive.
- Server entries are mapped to the local player shape at the boundary
  (`entryToPlayer`), with the **server entry id as the local id** — that's what
  the PATCH/DELETE routes are given.
- Writes go through `liveFetch` (`X-Round-Code` header, surfaces the server's
  `error` string). Failures are shown, never retried — see the Phase 3 note on
  the failure budget.
- Poll merge keeps local values for entries that are pending/failed **or
  focused**, since a score isn't in state until the field fires `change`.
- Entries are sorted by incoming tag on every merge: `selectEntries` has no
  `ORDER BY`, so unsorted rows visibly reshuffle between polls.

Two things worth knowing that only showed up on the way:

- **Two renders follow leaving a round** (the direct one and the `hashchange`
  one), so a one-shot "that code stopped working" message is wiped before it's
  read. `joinNotice` is sticky and cleared when the player acts on it.
- **`render()` owns the finalize button** in both its branches, so anything
  setting that button's visibility earlier in the same pass gets overwritten.
  `canFinalize()` is consulted inside `render()` for that reason.

### Original plan


`state` gains `mode: 'local'|'live'`, `roundId`, `code`. **The local flow and
export/import are untouched** — live mode is an additional path, not a
replacement.

- **Home** shows a "Live round at ⟨course⟩ — Join" card when `/rounds/live` is
  non-empty.
- **Setup** becomes a check-in list + form, reusing the existing typeahead and
  its tag autofill from `tag_holders`.
- **Scores** PATCH on change, with a per-row saved/pending/failed indicator.
- **Results** uses the existing `computeResults()` preview; finalize is visible
  only to admins.
- **Poll** `/rounds/:id` every 15s, plus on `visibilitychange` and `online`.
  Server wins on merge **except** for entries with unflushed local edits —
  never clobber what someone is mid-typing.

### Four things found while reading the code

**1. `load()` must learn the new fields.** [index.html:537](index.html:537)
defensively patches each missing key on the stored object. Adding `mode`,
`roundId`, and `code` to the initial literal alone leaves them `undefined` for
every existing user, because `load()` returns the stored object when
`s.players` is an array. Add them to the normalization block too.

**2. Server and local entries use different field names.** `computeResults()`
expects `{id, name, tag, score, ace, ctp}`; the API returns `{playerName,
incomingNumber, acePool, ctp, score}`. Map server entries into the local shape
at the boundary rather than teaching `computeResults()` two vocabularies —
that keeps one ranking implementation, which is the point of having it.

**3. Player writes need their own fetch helper.** `postAdmin`/`patchAdmin`
send Access cookies, not `X-Round-Code`. Live writes need a sibling helper that
sets the header and surfaces the `error` string from the body.

**4. The service worker will cache your polls.** [sw.js:38](sw.js:38) caches
`/api/*` GETs network-first, so an offline poll of `/rounds/:id` returns a
**cached response that looks like a normal 200**. The merge logic must not
treat that as fresh server truth and overwrite local edits with stale data.
Either check `navigator.onLine` before merging, or have the SW skip
`/api/rounds/` — the former is less invasive.

---

## Phase 3 — outbox

`tags-outbox-v1` in `localStorage`: pending ops coalesced per entry+field
(latest value wins), flushed with backoff on reconnect.

Phase 2 left the seams for this: every live write goes through `liveFetch`
(one wrap point), and each row already carries a `pending`/`saved`/`failed`
state in `liveSave` that the merge treats as "don't overwrite". Today a failed
write just says so and stops — the outbox is what makes it survive a reload.

**The service worker stays out of it entirely.** It already refuses to
intercept non-GET ([sw.js:32](sw.js:32)), which is exactly right — a write must
never fake success.

**Do not blindly retry on `401`/`403`.** The limiter at
[rateLimit.ts](backend/src/lib/rateLimit.ts) counts *failures* only, so a
legitimate card PATCHing scores all afternoon is never throttled — but an
outbox that retries a rejected code on a backoff loop will burn the IP's budget
and lock the group out of the round. Retry transport failures; on `401`/`403`
stop and re-prompt for the code. On `409` stop too — the round moved on, and
replaying won't fix it.

---

## Phase 4 — admin UI + docs

- "Open a live round" card: date + course → **big readable code**, plus Close
  check-in and Finalize. The code alphabet already omits `0 O 1 I L` because
  codes get read aloud in a parking lot; the display should be sized to match
  that reality.
- README section on live rounds — it still documents 6 tables and says nothing
  about the third auth tier.
- A note in the deployment docs that `/api/rounds/*` is **intentionally**
  reachable without Access.

---

## Constraints that must not be broken

- **The Cloudflare Access policy stays scoped to `/api/admin/*`.** Widening it
  to `/api/*` breaks player check-in entirely. Nothing to configure — this is
  already correct in production; it's a trap for a future tidy-up.
- **Never put a code in a URL.** Header or body only.
- **Never surface a join code in a public response.** `roundPublicColumns`
  exists for this and a test enforces it.
- **A write must never fake success offline.** The whole point of the outbox.

## Known gaps

- `POST /api/admin/rounds/:id/code` has the same read-then-write race that
  `finalize` had (fixed there with `SELECT … FOR UPDATE`). Concurrent code
  rotation is near-harmless — last write wins and both callers hold a valid
  code — so it was left alone. Same pattern if it ever matters.
- `.env.example` untouched; no new env vars were needed.
