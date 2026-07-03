import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { tags, admins } from "./schema.js";

// Seeds foundational reference data: the full tag pool (#1–300) and the
// admin email allowlist. Idempotent — safe to run repeatedly; existing
// rows are left untouched.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

// Admin allowlist comes from the ADMIN_EMAILS env var (comma-separated) so no
// personal email is committed to the repo. Set it in .env / the environment.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const tagRows = Array.from({ length: 300 }, (_, i) => ({ number: i + 1 }));

await db.insert(tags).values(tagRows).onConflictDoNothing({ target: tags.number });
if (ADMIN_EMAILS.length > 0) {
  await db
    .insert(admins)
    .values(ADMIN_EMAILS.map((email) => ({ email })))
    .onConflictDoNothing({ target: admins.email });
}

await client.end();
console.log(`seeded ${tagRows.length} tags and ${ADMIN_EMAILS.length} admin(s)`);
