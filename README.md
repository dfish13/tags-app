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

## Deployment

The production instance runs on a Raspberry Pi behind a Cloudflare Tunnel:

- `tags.duncanfish.co/api/*` → the API container (localhost:3001)
- `tags.duncanfish.co/*` → the static `index.html`
- Cloudflare Access protects `/api/admin/*` with an email allowlist.

The API and database containers bind to `127.0.0.1` only — they're reachable
solely through the tunnel, which is what makes the admin auth model safe.

## License

MIT — see [LICENSE](LICENSE).
