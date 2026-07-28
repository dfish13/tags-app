# Live round — Phase 1 (backend) status

Working notes for the join-code live-round feature. Delete this file when the
feature lands.

## Where it stands

Phase 1 backend is **written, typechecked, and green**: 50/50 tests pass,
`npm run build` is clean, and migration 0002 has been applied to a test
database (still **not** to the real one).

```bash
cd /home/duncan/git/tags-app/backend
export PATH="$HOME/.local/share/node-v22.23.1-linux-x64/bin:$PATH"
npm run typecheck     # expect: no output
npm run test:db       # db up + migrate + full suite (~7s)
npm run test:unit     # no DB needed (~0.2s)
npm run test:db:down  # destroy the test db when done
```

### Test environment

Node **v22.23.1** lives at `~/.local/share/node-v22.23.1-linux-x64/bin` and is
**not on `PATH`** — export it as above, or add it to `~/.bashrc`.

Tests run locally under node. Only the database is containerized, because
there is no Postgres on this host and installing one needs sudo:
`scripts/test-db.sh` runs a throwaway `postgres:16-alpine` published on
**127.0.0.1:55433** — loopback only, no volume, destroyed by `down`. The odd
port keeps it clear of the app's compose stack on 5432 and of the other
projects' Postgres containers on this machine.

`resetDb()` truncates every table in whatever `DATABASE_URL` points at, so
never run the suite against the dev or production database.

## What changed

### New files
| File | Purpose |
|---|---|
| `src/lib/roundCode.ts` | 6-char code gen/normalize. Alphabet omits `0 O 1 I L` — codes get read aloud in a parking lot |
| `src/lib/rateLimit.ts` | In-memory per-IP **failure** counter. Only failed attempts count, so a card PATCHing scores all afternoon is never throttled |
| `src/middleware/requireRoundCode.ts` | The code gate. Holds the shared `codeFailureLimiter` |
| `src/app.ts` | `createApp()` extracted from `index.ts` so tests can drive it in process |
| `src/test/helpers.ts` | Test server, `resetDb()`, `api()` fetch wrapper, fixtures |
| `src/lib/*.test.ts` | Unit tests — no DB needed (`npm run test:unit`) |
| `src/routes/liveRound.test.ts` | Integration tests — needs a DB |
| `scripts/test-db.sh` | Starts/destroys the throwaway test Postgres |
| `tsconfig.test.json` | Typecheck incl. tests; `tsconfig.json` now excludes them from the build so they don't ship in the image |
| `drizzle/0002_robust_falcon.sql` | Migration (generated, **not yet applied anywhere**) |

### Schema (migration 0002)
- `rounds.join_code` (unique, nullable), `rounds.code_expires_at`, `rounds.created_by`
- `round_entries.updated_at`
- `unique(round_id, incoming_tag_id)` on `round_entries`

That last constraint closed a real hole: `/complete` validated tag uniqueness
in JS only, and concurrent check-ins race straight past an application-level
check. A duplicated incoming tag corrupts redistribution, because the pool of
tags handed out **is** the set of incoming tags.

### Leak fixed
`GET /api/rounds/:id` did `select().from(rounds)` and spread the whole row into
the response. Once `join_code` became a column that would have published it.
Now every public response is built from `roundPublicColumns`, which names its
columns and exposes `joinable: boolean` computed in SQL — the code's *value*
never enters a public query. There's a test asserting no public response
contains it.

### Routes
Code-gated, at `/api/rounds/*` — **not** under `/api/admin/*`, because
Cloudflare Access would bounce the players they exist for:

| Route | Rule |
|---|---|
| `GET /rounds/live` | public, no code. A live round's existence is league news; only writing to it is secret |
| `POST /rounds/join` | code → round. Rate-limited: this route maps the whole code space |
| `POST /rounds/:id/checkin` | status `open` only |
| `PATCH /rounds/:id/entries/:entryId` | `open` or `scoring`; `tagNumber` edits are `open` only |
| `DELETE /rounds/:id/entries/:entryId` | `open` only |

Admin: `POST /admin/rounds` mints a code (12h default, `withCode:false` to
skip), `GET|POST /admin/rounds/:id/code` reads/rotates/revokes, and finalize
now clears the code.

The `open` → `scoring` distinction is load-bearing: a late check-in changes the
tag pool and therefore what every other player can win, so closing check-in has
to be possible without finalizing.

## Found by running the tests

Two things the suite caught the first time it ever executed.

**Concurrent finalize redistributed three times.** `POST /:id/finalize` read the
round with a plain `SELECT`, checked `status`, then did the work. A transaction
gives atomicity, not mutual exclusion: under READ COMMITTED all three
concurrent requests read `status='open'` from their own snapshots, all passed
the guard, and all redistributed. The closing `UPDATE` serialized them, but
only after the damage. The guard read is now `SELECT … FOR UPDATE`, so the
losers block until the winner commits, re-read the fresh row, and 409.

This is the bug the "Make finalize atomic and idempotent" commit was aiming at
— atomic it was, idempotent it wasn't, and only a concurrent test could tell
the difference.

*Note:* `POST /:id/code` has the same read-then-write shape. Rotating a code
twice concurrently is near-harmless (last write wins, both callers hold a valid
code), so it's left alone — but it's the same pattern if it ever matters.

**The runner hung after every test passed.** `client.ts` kept the postgres.js
pool private, so nothing could release it; idle sockets keep Node's event loop
alive and the process never exited. Now `closeDb()` is exported and the `after`
hook calls it alongside `stopTestServer()`. `--test-timeout=30000` is baked
into the `test` scripts so a future hang fails loudly instead of wedging.

## Not done

- Migration 0002 has run only against the throwaway test database — **not**
  against dev or production.
- Phase 2 (frontend live mode), Phase 3 (offline outbox), Phase 4 (admin UI + README).
- `README.md` still documents 6 tables and says nothing about live rounds or
  the third auth tier.
- `.env.example` untouched (no new env vars were needed).

## Deployment note for later

`/api/rounds/*` now accepts writes without an Access identity, by design. The
Cloudflare Access policy must stay scoped to `/api/admin/*` only — widening it
to `/api/*` would break player check-in entirely.
