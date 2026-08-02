import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCode, normalizeCode, CODE_LENGTH } from "./roundCode.js";

test("generated codes avoid glyphs people mishear", () => {
  // 0/O/1/I/L are the ones that get mistranscribed when a code is read aloud
  // across a parking lot. If they ever creep back into the alphabet, the codes
  // still "work" — they just start failing for humans, which is why this is a
  // test and not a comment. Digits are excluded outright for the same reason:
  // a letters-only code is unambiguous to say out loud.
  for (let i = 0; i < 500; i++) {
    assert.match(generateCode(), /^[A-Z]+$/);
    assert.doesNotMatch(generateCode(), /[OIL]/);
  }
});

test("generated codes are the advertised length and shape", () => {
  for (let i = 0; i < 100; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.equal(normalizeCode(code), code, "a fresh code must survive normalize");
  }
});

test("generated codes are not obviously biased", () => {
  // Not a randomness proof — just a guard against a broken generator that
  // returns a constant or ignores part of the alphabet.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generateCode());
  assert.ok(seen.size > 1900, `expected mostly-distinct codes, got ${seen.size}`);
});

test("normalizeCode accepts what a human actually types", () => {
  assert.equal(normalizeCode("abcd"), "ABCD");
  assert.equal(normalizeCode("AB-CD"), "ABCD");
  assert.equal(normalizeCode(" abcd "), "ABCD");
  assert.equal(normalizeCode("a-b c d"), "ABCD");
});

test("normalizeCode rejects anything that can't be a code", () => {
  assert.equal(normalizeCode("ABC"), null, "too short");
  assert.equal(normalizeCode("ABCDE"), null, "too long");
  assert.equal(normalizeCode("ABCO"), null, "excluded glyph");
  assert.equal(normalizeCode("ABC2"), null, "digits are no longer codes");
  assert.equal(normalizeCode("ABC!"), null, "punctuation");
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
  assert.equal(normalizeCode(1234), null, "non-string");
  assert.equal(normalizeCode({}), null);
});
