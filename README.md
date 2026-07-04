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
- **Finalize** — computes tag assignments, snapshots them, and updates standings.
- **Export/import** — run a round with no admin present, then hand it to an admin to review and finalize.

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
- **Reads are public**; **writes require admin auth** via Cloudflare Access (an email allowlist at the edge), re-checked against an `admins` table in the API.

### Data model (6 tables)

| Table | Purpose |
|---|---|
| `players` | League roster |
| `tags` | The pool of tag numbers (1–300) |
| `tag_holders` | Who currently holds each tag |
| `rounds` | Each sanctioned round |
| `round_entries` | One row per player per round (incoming tag, score, assigned tag) |
| `admins` | Email allowlist for write access |

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
```

Set `DATABASE_URL` in the environment (see `.env.example`).

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

The API and database containers bind to `127.0.0.1` only — they're reachable
solely through the tunnel, which is what makes the admin auth model safe.

## License

MIT — see [LICENSE](LICENSE).
