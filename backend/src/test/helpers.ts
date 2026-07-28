import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { createApp } from "../app.js";
import { db } from "../db/client.js";
import {
  tags,
  admins,
  players,
  rounds,
  roundEntries,
  tagHolders,
} from "../db/schema.js";

// Test support. DB-backed tests run locally against a throwaway Postgres in a
// container on 127.0.0.1:55433 — `npm run test:db` starts it, migrates it, and
// runs the suite with DATABASE_URL pointed at it. The db/client module reads
// DATABASE_URL at import time, so it must already be set before anything here
// is imported (the npm script handles that).

export const ADMIN_EMAIL = "admin@test.local";

let server: Server | null = null;
let baseUrl = "";

export async function startTestServer(): Promise<string> {
  if (server) return baseUrl;
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

export async function stopTestServer() {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((e) => (e ? reject(e) : resolve()))
  );
  server = null;
}

// Wipe everything the tests write, then restore the reference data the app
// assumes exists (the tag pool and the admin allowlist). RESTART IDENTITY keeps
// ids small and predictable across cases; CASCADE handles the FK web.
export async function resetDb() {
  await db.execute(
    sql`truncate table ${admins}, ${players}, ${tags}, ${tagHolders}, ${rounds}, ${roundEntries} restart identity cascade`
  );
  await db.insert(tags).values(
    Array.from({ length: 300 }, (_, i) => ({ number: i + 1 }))
  );
  await db.insert(admins).values({ email: ADMIN_EMAIL });
}

type FetchOpts = {
  admin?: boolean;
  code?: string;
  ip?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

// Thin fetch wrapper: adds the Cloudflare Access identity header for admin
// calls, the round code header for live-round calls, and a per-caller IP so
// rate-limit tests don't collide with each other.
export async function api(
  method: string,
  path: string,
  opts: FetchOpts = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.admin) headers["Cf-Access-Authenticated-User-Email"] = ADMIN_EMAIL;
  if (opts.code) headers["X-Round-Code"] = opts.code;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ---- Fixtures ----

export async function addPlayer(name: string, tagNumber: number) {
  const res = await api("POST", "/api/admin/players", {
    admin: true,
    body: { name, tagNumber },
  });
  if (res.status !== 201) {
    throw new Error(`addPlayer(${name}) failed: ${JSON.stringify(res.body)}`);
  }
  return res.body as { id: number; name: string; tagNumber: number };
}

export async function openRound(
  body: Record<string, unknown> = { date: "2026-07-28", course: "Maple Hill" }
) {
  const res = await api("POST", "/api/admin/rounds", { admin: true, body });
  if (res.status !== 201) {
    throw new Error(`openRound failed: ${JSON.stringify(res.body)}`);
  }
  return res.body as {
    id: number;
    joinCode: string | null;
    codeExpiresAt: string | null;
    status: string;
  };
}
