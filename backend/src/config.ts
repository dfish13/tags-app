// Per-deployment switches read from the environment.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

// Whether a player must present the round's join code to write to a live round.
//
// OFF by default. The gate was built for a public URL that anyone might find;
// in practice a live round is open for one afternoon and the site isn't
// broadcast, so making every player type four letters bought less than it
// cost. What still bounds a live round with the gate off is unchanged: the
// round has to be open for check-in (an admin can revoke that), the code's
// expiry still applies, and writes still reach only that round's entries —
// never the roster, never finalize, never tag status.
//
// Turn it back on with REQUIRE_ROUND_CODE=true in the environment and a
// restart. Nothing else changes: rounds still mint, rotate, revoke and expire
// codes exactly the same way with the gate off, so a flipped flag finds the
// data it expects rather than a round that never had a code.
//
// Read per call, not captured at import: tests flip it between cases, and a
// request-time read costs nothing.
export function roundCodeRequired(): boolean {
  return TRUTHY.has((process.env.REQUIRE_ROUND_CODE ?? "").trim().toLowerCase());
}
