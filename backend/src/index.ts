import express from "express";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { playersRouter, playersAdminRouter } from "./routes/players.js";
import { tagsRouter, tagsAdminRouter } from "./routes/tags.js";
import { roundsRouter, roundsAdminRouter } from "./routes/rounds.js";
import { standingsRouter } from "./routes/standings.js";

const app = express();
app.use(express.json());

// Everything is served under /api so the cloudflared tunnel can path-route
// tags.duncanfish.co/api/* → this API, and tags.duncanfish.co/* → the
// static site (a separate service on :8080). Same origin, no CORS.
const api = express.Router();

api.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Public read routes — no auth. Anyone can view players, tags, rounds, stats.
api.use("/players", playersRouter);
api.use("/tags", tagsRouter);
api.use("/rounds", roundsRouter);
api.use("/standings", standingsRouter);

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

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`tags-app API listening on :${port}`);
});
