import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCode, normalizeCode, CODE_LENGTH } from "./roundCode.js";

test("generated codes avoid glyphs people mishear", () => {
  // 0/O/1/I/L are the ones that get mistranscribed when a code is read aloud
  // across a parking lot. If they ever creep back into the alphabet, the codes
  // still "work" — they just start failing for humans, which is why this is a
  // test and not a comment.
  for (let i = 0; i < 500; i++) {
    assert.doesNotMatch(generateCode(), /[01OIL]/);
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
  assert.equal(normalizeCode("abc234"), "ABC234");
  assert.equal(normalizeCode("ABC-234"), "ABC234");
  assert.equal(normalizeCode(" abc 234 "), "ABC234");
  assert.equal(normalizeCode("a-b c2 3 4"), "ABC234");
});

test("normalizeCode rejects anything that can't be a code", () => {
  assert.equal(normalizeCode("ABC23"), null, "too short");
  assert.equal(normalizeCode("ABC2345"), null, "too long");
  assert.equal(normalizeCode("ABC23O"), null, "excluded glyph");
  assert.equal(normalizeCode("ABC23!"), null, "punctuation");
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
  assert.equal(normalizeCode(123456), null, "non-string");
  assert.equal(normalizeCode({}), null);
});
