# Live rounds — working notes

Join-code check-in and scoring, so players at the course can enter their own
scores without an admin. Delete this file when Phase 4 lands.

**Phase 1 (backend) is shipped and deployed.** Phases 2–4 are frontend.

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

Deploy is `git pull && docker compose up -d --build api` on
`dfish@raspberrypi.local`. The container entrypoint is
`migrate.js && seed.js && index.js`, so **deploying applies migrations
automatically**. Previous image is tagged `tags-app-api:rollback-f34bfb2`.

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

Everything is one file: [index.html](index.html), 2153 lines, no build step,
no framework. Phase 2 touches these:

| What | Where | Note |
|---|---|---|
| `state` + `load()`/`save()` | [index.html:535](index.html:535) | `KEY = 'tags-round-v1'` |
| Routing (`route`/`step`) | [index.html:591](index.html:591) | `#/`, `#/round`, `#/admin`, `#/stats` |
| `addPlayer()` | [index.html:647](index.html:647) | Setup's add form |
| Typeahead + tag autofill | [index.html:692](index.html:692)–[752](index.html:752) | `pickSuggestion()` prefills the tag from `r.tagNumber` |
| `setScore()` | [index.html:812](index.html:812) | Where the live PATCH hooks in |
| `computeResults()` | [index.html:847](index.html:847) | Reads the `state.players` global |
| `render()` | [index.html:859](index.html:859) | One big re-render |
| `adminEmail` / `refreshAdminAuth()` | [index.html:985](index.html:985)–[1018](index.html:1018) | Gates admin-only UI |
| `postAdmin()` / `patchAdmin()` | [index.html:1106](index.html:1106) | Access-cookie writes |
| `exportRound()` / `importRound()` | [index.html:1150](index.html:1150), [1193](index.html:1193) | Must keep working untouched |

---

## Phase 2 — live mode in the UI

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
