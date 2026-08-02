// Shared constants and the safety gate for the local test stack.
//
// Everything under src/dev/ is for clicking through the app on a laptop. It is
// excluded from the build (see tsconfig.json) so it can never ship in the API
// image — the dev server forges an admin identity, and the fixture truncates
// every table. Both are catastrophic pointed at the Pi.

export const DEV_ADMIN_EMAIL = "dev-admin@example.test";

// Fixed on purpose: a stable code means the check-in flow can be tested without
// first digging the round's code out of the Admin tab. Valid under
// lib/roundCode.ts's alphabet and length (four letters, no O/I/L).
export const DEV_JOIN_CODE = "TAGS";

export const DEV_PORT = Number(process.env.PORT) || 8123;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// The one thing standing between a mistyped DATABASE_URL and the league's real
// history. Requires a loopback host AND a database name ending in `_dev`, so
// this refuses to run against production (`tags`) and against the test
// database (`tags_test`) that `npm run test:db` owns.
export function assertLocalDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — run this through scripts/dev.sh");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const name = parsed.pathname.replace(/^\//, "");
  if (!LOCAL_HOSTS.has(parsed.hostname) || !name.endsWith("_dev")) {
    // Host and database name only — never echo the password back.
    throw new Error(
      `Refusing to run dev tooling against ${parsed.hostname}/${name}. ` +
        "The local test stack requires a loopback host and a database named *_dev."
    );
  }
  return url;
}
