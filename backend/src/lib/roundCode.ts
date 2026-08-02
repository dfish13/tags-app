import { randomInt } from "node:crypto";

// Alphabet for round join codes. Deliberately excludes 0/O/1/I/L — these codes
// get read aloud in a parking lot and written on a scorecard, and those glyphs
// are the ones people mishear or mistranscribe. Digits went too: a code with no
// digits in it needs no "letter or number?" pause when it's spoken, and four
// letters is short enough to hold in your head between the tee and your phone.
// 23 symbols.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

// ~280k possible codes, down from ~8.9e8 when this was six mixed characters.
// That is a real reduction and it is deliberate: typing the code is the friction
// players actually feel, and the prize for guessing one is the ability to edit
// a disc golf scorecard for the few hours before the round finalizes.
//
// What keeps it sound is the failure budget in requireRoundCode (10 per IP per
// 15 minutes), which puts even odds at ~3,500 IP-hours; that a code dies on
// finalize, expiry, or revoke; and that an admin can rotate one the moment
// anything looks wrong. If any of those three goes away, this length has to be
// reconsidered with it.
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
