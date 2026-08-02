import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { DEV_ADMIN_EMAIL, DEV_JOIN_CODE, DEV_PORT, assertLocalDatabase } from "./config.js";

// The local stand-in for production's edge. In production, cloudflared
// path-routes ONE hostname to two services — /api/* to this API, /* to a static
// server — and Cloudflare Access gates /api/admin/*. The frontend depends on
// both: it calls location.origin + '/api', and it decides whether to show any
// admin UI by asking /cdn-cgi/access/get-identity who you are.
//
// So a plain static server is not enough to click through the app, and neither
// is the API alone. This serves both halves on one port and fakes the Access
// layer, which is why it is dev-only and never built into the image.

assertLocalDatabase();

// backend/src/dev/server.ts → repo root
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const outer = express();

// Whether the fake Access session is signed in. Starts on, because most of what
// needs testing lives behind the Admin tab; the app's own sign-out button flips
// it off, so the signed-out player view is reachable without a restart.
let signedIn = process.env.DEV_SIGNED_OUT !== "1";

// --- Cloudflare Access, faked ---------------------------------------------

// What the frontend polls to decide if you're an admin (fetchAdminIdentity).
outer.get("/cdn-cgi/access/get-identity", (_req, res) => {
  if (!signedIn) return res.status(403).json({ error: "Not signed in" });
  res.json({ email: DEV_ADMIN_EMAIL });
});

// The app's "Sign out" link. Access clears its cookie and bounces to returnTo.
outer.get("/cdn-cgi/access/logout", (req, res) => {
  signedIn = false;
  const to = String(req.query.returnTo ?? "/");
  // Only ever bounce somewhere on this server, even though it's loopback-only.
  res.redirect(to.startsWith("/") || to.startsWith(`http://127.0.0.1:${DEV_PORT}`)
    ? to
    : "/");
});

// The app's "Sign in as admin" button navigates here. In production Access
// intercepts this path with its login page before the API ever sees it, then
// the API's own /login handler redirects back to the Admin tab.
outer.get("/api/admin/login", (_req, res) => {
  signedIn = true;
  res.redirect("/#/admin");
});

// The header Access injects, and the only thing requireAdmin trusts. Deleted
// when signed out so an "admin" request from the browser really does 401 —
// otherwise the signed-out view would silently keep working and hide bugs.
outer.use((req, _res, next) => {
  if (signedIn) {
    req.headers["cf-access-authenticated-user-email"] = DEV_ADMIN_EMAIL;
  } else {
    delete req.headers["cf-access-authenticated-user-email"];
  }
  next();
});

// --- The two real services -------------------------------------------------

outer.use(createApp());

// The frontend, straight off the working tree. no-store because the whole point
// is to reload and see the edit you just made; a cached index.html sends you
// debugging a change that was never served.
outer.use(
  express.static(REPO_ROOT, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  })
);

// Loopback only. This server hands out an admin identity to anyone who asks.
outer.listen(DEV_PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${DEV_PORT}`;
  console.log(`
  tags-app dev stack
    app        ${url}
    api        ${url}/api/health
    admin      signed in as ${DEV_ADMIN_EMAIL}${signedIn ? "" : " (currently signed out)"}
    join code  ${DEV_JOIN_CODE}

    reseed:    scripts/dev.sh reseed
    shut down: scripts/dev.sh down
`);
});
