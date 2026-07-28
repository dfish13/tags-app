import { randomInt } from "node:crypto";

// Alphabet for round join codes. Deliberately excludes 0/O/1/I/L — these codes
// get read aloud in a parking lot and written on a scorecard, and those glyphs
// are the ones people mishear or mistranscribe. 31 symbols.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;

// ~8.9e8 possible codes. Combined with per-IP rate limiting on the join route,
// guessing an active code is not a practical attack.
export function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

// Accept what a human actually types: lowercase, spaces, dashes. Returns null
// for anything that can't be a code, so callers reject it without a DB lookup.
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}
