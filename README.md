# 🥏 Tags League

A mobile-first web app for running a disc golf **tags league** — tracking players, tag numbers, rounds, and standings over time.

In a tags league, each player carries a numbered tag. After each round, tags are
redistributed by score: the lowest score takes the lowest tag. This app runs that
workflow and keeps a persistent record of who holds which tag, plus a history of
past rounds.

## Features

- **League Home** — public, no login. Current tag standings and round history.
- **Play** — run a round: register players, enter scores, preview results, and finalize.
- **Admin** — manage the roster (add/edit/remove players and their tags). Admin-gated.
- **New players mid-round** — an admin adding someone who isn't on the roster yet can create them and add them to the round in one step, after being shown every roster player who might already be them.
- **Finalize** — computes tag assignments, snapshots them, and updates standings.
- **Export/import** — run a round with no admin present, then hand it to an admin to review and finalize.
- **Live rounds** — an admin opens a round with a join code; players at the course check themselves in and enter their own scores from their own phones.

## Architecture

```
Browser (index.html — single-file HTML/CSS/JS, no build step)
      │  same-origin /api/*
      ▼
Express + TypeScript API (Docker)  ──►  PostgreSQL (Docker)
      ▲
      │  Cloudflare Tunnel + Access (email allowlist gates /api/admin/*)
```

- **Frontend**: one self-contained `index.html`. Hash-routed views (`#/`, `#/round`, `#/admin`). No framework, no build.
- **Backend**: Express + TypeScript, [Drizzle ORM](https://orm.drizzle.team/) over PostgreSQL. Runs in Docker via `docker-compose`.
Access comes in **three tiers**, not two:

| Tier | Routes | Who |
|---|---|---|
| Public read | `GET /api/*` except `/api/admin/*` | anyone |
| Round code | `/api/rounds/:id/*` writes | anyone holding the round's join code |
| Admin | `/api/admin/*` | Cloudflare Access email allowlist, re-checked against the `admins` table |

The middle tier is what lets players score a live round with no admin present.
It is a **write** tier without an identity, so it is deliberately narrow: it
reaches only the entries of one round, and only while that round is open.

### Data model (6 tables)

| Table | Purpose |
|---|---|
| `players` | League roster |
| `tags` | The pool of tag numbers (1–300) |
| `tag_holders` | Who currently holds each tag |
| `rounds` | Each sanctioned round |
| `round_entries` | One row per player per round (incoming tag, score, assigned tag) |
| `admins` | Email allowlist for write access |

## Live rounds

Normally one person runs a round on one phone. A live round instead puts the
round on the server and lets everyone write to it, so a group can spread out
and still be entering scores into the same round.

**Running one** (Admin tab, signed in):

1. **Open a live round** — pick the date and course. The app mints a
   six-character join code and shows it large, because it gets read aloud on a
   first tee. The alphabet omits `0 O 1 I L`, which are the glyphs people
   mishear.
2. **Read the code out.** Players go to Home, tap **Join**, and type it. They
   check themselves in — picking their name from the roster autofills the tag
   they currently hold — and enter their own scores as they play.
3. **Close check-in** once everyone is in. Scores keep saving; nobody new can
   join. This is a separate step from finalizing because a late check-in
   changes the tag pool, and therefore what everyone else can win.
4. **Finalize** from the Results step, as usual. Tags are redistributed and the
   code stops working.

**New code** reissues the code and kills the old one — for when it has been
read to the wrong group. **Revoke** closes the round to player writes without
finalizing it. Both are on the same Admin card.

The code is never in any API response a non-admin can read, and never in a URL
— it travels in an `X-Round-Code` header, so it stays out of server logs and
`Referer`. An admin who reloads mid-round reads it back from
`GET /api/admin/rounds/:id/code`.

Scores go through an **outbox** rather than straight to the network, so a write
that fails isn't lost. The row reads *not saved*, and the queue retries with
backoff as soon as the connection is back — including across a reload, since it
is stored alongside the round. Re-editing a row replaces what's queued for it
rather than stacking another write behind it, so the server only ever receives
the latest value.

**A write is never faked.** Nothing reads as saved until the server confirms it,
and the service worker never intercepts non-GET requests, so an offline write
cannot be answered from cache. Two cases deliberately do *not* retry:

- **A rejected or expired code.** Retrying would spend the shared per-IP failure
  budget and lock the whole group out of the round. The queue stops and asks for
  the current code instead.
- **A round that has moved on** — finalized, or the entry deleted. Replaying
  can't fix that, so the write is dropped and the next poll reconciles the row.

Leaving a live round is non-destructive — the round and its entries stay on the
server, and the same code rejoins it. Anything still queued is discarded along
with the round, so an unsent score never follows you into a different one.

## Adding a player who isn't on the roster

Only roster players can be put in a round, which used to mean stopping
mid-setup, going to the Admin tab, adding them, and coming back. Now typing a
name with no exact roster match opens a resolver in place.

It lists **every roster player who might already be them**, each with the
current tag and why it was suggested — *near-identical name*, *same surname*,
*shares a name*. Picking one corrects the spelling to the roster's and fills in
their current tag. Below that, and **only for a signed-in admin**, is the option
to create the player: it adds them to the league roster with the tag number in
the form and puts them in the round in one action.

Matching is deliberately loose. Player names have **no uniqueness constraint**,
so wrongly concluding someone is new creates a second entry and permanently
splits their tag history — while a wrong suggestion costs one glance. It
normalises case, accents and punctuation (`Renee` = `Renée`, `OBrien` =
`O'Brien`), handles two letters typed in the wrong order (`Doe` for `Ode`),
reversed order (`Doe, Jane`), initials (`J Doe`), short forms (`Chris` →
`Christopher`) and a table of nicknames no string metric can connect (`Mike` →
`Michael`, `Bob` → `Robert`).

That normalisation also applies to the *exact* match, so typing `Renee Doe`
now resolves to an existing `Renée Doe` rather than silently creating a
duplicate.

Non-admins see the same candidate list — useful on its own for finding the
right spelling — but are told to ask an admin rather than offered the create
option. `POST /api/admin/players` is Access-gated regardless.

The hint under the name field says which of those two you are looking at, so a
signed-in admin isn't told to go to the Admin tab for something they can do
right there.

## Bringing a tag the app thinks someone else has

`tag_holders` only moves when a round is **finalized**, so it goes stale the
moment a tag changes hands outside a sanctioned round — someone quits and passes
their tag on, or a casual round redistributes tags nobody entered. Turning up
holding a tag the app has against another player is therefore routine, not an
error. **The physical tag in someone's hand is the truth**, so both paths say
whose tag the record thinks it is, and then let it through.

They differ in *when* the old holder loses it:

- **Checking in an existing roster player** writes nothing to `tag_holders`.
  Finalizing redistributes this round's pool, and that is what takes the tag off
  the old holder — they end up with **no tag**, because a displaced holder's real
  tag is genuinely unknowable. Deliberate: check-in is a **join-code** write, and
  that tier reaches one round's entries and nothing else. Letting it edit
  `tag_holders` would let anyone holding the code rewrite league standings.
- **Creating a new roster player** has to record a holding, so it takes the tag
  immediately, and the response names who was `displaced` so the app can say so.
  That is an **admin** write, and it matches what `PATCH /api/admin/players/:id/tag`
  has always done. It needs `takeTag: true`, which the app sends only after the
  admin has been shown the holder's name and agreed — so a mistyped number in the
  Admin tab's roster form still bounces with a plain `409`.

The `409` carries a structured `heldBy` alongside the message, which is what
lets the check-in flow offer "reissue it anyway" instead of dead-ending an admin
at a first tee — the case this whole path exists for, since a new player is
almost always issued a **recycled** number.

## Courses

`rounds.course` is **free text — there is no `courses` table.** Both course
fields (round setup, and the admin's open-a-live-round card) offer a typeahead
whose list is derived from the distinct course names on existing rounds, read
from `GET /api/rounds`, which the app already fetches. Nothing to migrate, and
the list populates itself from history.

Names are deduped on a normalised form with the most recently played spelling
winning, so if `Oak Ridge` and `oak  ridge` both exist in history the typeahead
offers one entry, not two. Typing a course that is *close to* an existing one
raises an inline "did you mean…?" — free text means a typo would otherwise
become a permanent suggestion and split a course's history the same way a
duplicate roster entry splits a player's.

Typing something genuinely new is still fine: the field accepts anything, and
the new name simply joins the list once that round exists.

If a course ever needs data of its own — holes, par, location, per-course
scoring on the Stats page — that is the point to promote it to a real table
with a foreign key from `rounds`. Until then the derived list carries no schema
cost.

## Running locally

### Backend + database (Docker)

```bash
cp .env.example .env      # then edit POSTGRES_PASSWORD to something real
docker compose up -d --build
```

This starts PostgreSQL and the API. On boot the API runs migrations, seeds the
tag pool (1–300) and admin allowlist, then serves on port 3001.

### Frontend

The frontend is a single static file. Serve it any way you like, e.g.:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. The page calls the API at same-origin `/api`
in production; for local dev you'll want the static server and the API behind
one origin (e.g. a reverse proxy), or adjust `API_BASE` in `index.html`.

### Backend development (without Docker)

```bash
cd backend
npm install
npm run dev            # tsx watch
npm run db:generate    # generate a migration from schema changes
npm run db:migrate     # apply migrations
npm run db:seed        # seed tags + admin

npm run typecheck      # no output = clean
npm run test:db        # throwaway Postgres on 127.0.0.1:55433 + migrate + suite
npm run test:db:down   # destroy it
```

Set `DATABASE_URL` in the environment (see `.env.example`).

⚠️ The suite's `resetDb()` truncates **every table in whatever `DATABASE_URL`
points at**. `npm run test:db` aims it at its own throwaway container on an
odd port for that reason — never point the suite at a dev or production
database.

## Running your own league

This app is **single-tenant by design**: one deployment = one league. A league's
tags are physical objects it owns, and its admins, standings, and history are
entirely its own — there's no cross-league data to share. So instead of a
`league` dimension in the data model, each league runs its own copy of the site
and database. The codebase is identical across leagues; only configuration
differs.

To stand up a new league (e.g. "Mile Hi Tags"):

1. **Clone the repo** and copy the env template:
   ```bash
   git clone https://github.com/dfish13/tags-app.git
   cd tags-app
   cp .env.example .env
   ```
2. **Edit `.env`** for your league:
   - `LEAGUE_NAME` — shown in the header and page title (e.g. `Mile Hi Tags`).
   - `POSTGRES_PASSWORD` — a strong, unique password.
   - `ADMIN_EMAILS` — comma-separated admin emails (they get write access).
   - *(Optional)* `THEME_PRIMARY` / `THEME_ACCENT` / `THEME_SECONDARY` /
     `THEME_BG` / `THEME_FONT` — brand the app with your own colors and font.
     Leave blank to use the default look. Colors are CSS hex; the font is any
     CSS `font-family` (the pressed-button shade is derived from the primary).
3. **Start it:**
   ```bash
   docker compose up -d --build
   ```
   On boot the API migrates, seeds the tag pool (1–300) and admins, and serves
   on port 3001. Serve `index.html` alongside it (same origin as the API).
4. **Put it behind your own domain + auth.** The admin model relies on the API
   being reachable *only* through a trusted proxy that injects the
   `Cf-Access-Authenticated-User-Email` header. The reference setup uses a
   Cloudflare Tunnel + Cloudflare Access (see Deployment below); replicate that
   with your own hostname, tunnel, and Access application scoped to
   `your-host/api/admin/*` with your admin email allowlist. **Do not expose the
   API port directly** — bind it to `127.0.0.1` (as the compose file does) so
   the auth header can't be spoofed.

That's it — same code, your config, your data, your host.

## Deployment

The reference instance runs on a Raspberry Pi behind a Cloudflare Tunnel:

- `tags.duncanfish.co/api/*` → the API container (localhost:3001)
- `tags.duncanfish.co/*` → the static `index.html`
- Cloudflare Access protects `/api/admin/*` with an email allowlist.

**The Access policy must stay scoped to `/api/admin/*`.** The rest of
`/api/rounds/*` is reachable without an Access identity *on purpose* — that is
what lets a player at the course check in and enter a score without being on
the admin allowlist. Those routes are gated by the round's join code instead
(see [Live rounds](#live-rounds)). Widening the Access policy to `/api/*` looks
like a tightening but breaks player check-in entirely.

The API and database containers bind to `127.0.0.1` only — they're reachable
solely through the tunnel, which is what makes the admin auth model safe.

### Deploying a change

The two halves deploy differently, and most changes only need one of them:

- **Backend** — `docker compose up -d --build api`. The container entrypoint is
  `migrate.js && seed.js && index.js`, so **deploying applies migrations
  automatically**. Keep the previous image tagged (e.g.
  `tags-app-api:rollback-<sha>`) so a rollback is one `docker tag` away.
- **Frontend** — `index.html` is served straight off the checkout by a plain
  static server, so **`git pull` alone ships it**: no rebuild, no restart.

So check `git diff --stat <deployed-sha> origin/main` first and skip the
rebuild entirely when nothing under `backend/` changed.

**No cache-busting step is needed.** [sw.js](sw.js) serves navigations
network-first, so a new `index.html` is live on the next load and the cache is
only an offline fallback — don't bump `CACHE` reflexively on a frontend deploy.

Worth verifying after any deploy: that the served `index.html` matches the
deployed commit, and that the auth split still holds — `/api/rounds/live`
returns `200` while `/api/admin/*` returns `302` to the Access login.

## License

MIT — see [LICENSE](LICENSE).
