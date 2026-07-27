import express from "express";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { playersRouter, playersAdminRouter } from "./routes/players.js";
import { tagsRouter, tagsAdminRouter } from "./routes/tags.js";
import { roundsRouter, roundsAdminRouter } from "./routes/rounds.js";
import { standingsRouter } from "./routes/standings.js";
import { statsRouter } from "./routes/stats.js";

const app = express();
app.use(express.json());

// Everything is served under /api so the cloudflared tunnel can path-route
// tags.duncanfish.co/api/* → this API, and tags.duncanfish.co/* → the
// static site (a separate service on :8080). Same origin, no CORS.
const api = express.Router();

api.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Public site config. Lets one codebase serve any league — the frontend reads
// the league name and theme from here instead of hardcoding them. Set these
// per deployment (see .env.example). Any unset theme value is returned as null
// and the frontend keeps its built-in default for that slot.
const LEAGUE_NAME = process.env.LEAGUE_NAME?.trim() || "Tags League";
const env = (k: string) => process.env[k]?.trim() || null;
api.get("/config", (_req, res) => {
  res.json({
    leagueName: LEAGUE_NAME,
    theme: {
      primary: env("THEME_PRIMARY"),     // header, buttons
      accent: env("THEME_ACCENT"),       // tag badges, tab underline
      secondary: env("THEME_SECONDARY"), // CTP accent
      bg: env("THEME_BG"),               // page background
      font: env("THEME_FONT"),           // body font-family
    },
  });
});

// PWA manifest, served by the API so the install name and colors follow the
// per-deployment theme. Icons are static files at the site root (served by
// the static-site service). scope/start_url are "/" — explicitly widened
// past this file's /api/ directory default.
api.get("/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").json({
    name: LEAGUE_NAME,
    short_name: LEAGUE_NAME.length <= 12 ? LEAGUE_NAME : "Tags",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: env("THEME_BG") ?? "#eef3f3",
    theme_color: env("THEME_PRIMARY") ?? "#042a2b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
});

// Public read routes — no auth. Anyone can view players, tags, rounds, stats.
api.use("/players", playersRouter);
api.use("/tags", tagsRouter);
api.use("/rounds", roundsRouter);
api.use("/standings", standingsRouter);
api.use("/stats", statsRouter);

// Admin write routes — all under /api/admin/*, gated by requireAdmin.
// Cloudflare Access protects /api/admin/* at the edge with its own email
// allowlist policy; requireAdmin re-checks the identity against the DB.
const admin = express.Router();
admin.use(requireAdmin);
// Post-login landing: hitting this under Access triggers the login flow, and
// once authenticated it bounces the browser back to the app's Admin tab.
// (The frontend's "Sign in as admin" button navigates here.)
admin.get("/login", (_req, res) => {
  res.redirect("/#/admin");
});
// Lightweight identity echo for the frontend if it wants to confirm who's in.
admin.get("/whoami", (req, res) => {
  res.json({ email: (req as typeof req & { adminEmail?: string }).adminEmail });
});
admin.use("/players", playersAdminRouter);
admin.use("/tags", tagsAdminRouter);
admin.use("/rounds", roundsAdminRouter);
api.use("/admin", admin);

app.use("/api", api);

// Error handler (must come last, and must take 4 args to be recognized).
// Turns an unexpected failure into a 500 instead of a dead process.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  }
);

// Last-resort guard: an async handler that throws without passing the error to
// next() would otherwise take the whole API down (Express 4 doesn't catch
// those). Log and keep serving — one bad request must not deny service to the
// league.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err);
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`tags-app API listening on :${port}`);
});
