import { test } from "node:test";
import assert from "node:assert/strict";
import { createFailureLimiter } from "./rateLimit.js";

// A controllable clock so these run instantly instead of sleeping.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("allows up to the limit, then blocks", () => {
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 3, windowMs: 1000, now: clock.now });

  for (let i = 0; i < 3; i++) {
    assert.equal(rl.isLimited("ip"), null, `attempt ${i + 1} should be allowed`);
    rl.record("ip");
  }
  assert.ok(rl.isLimited("ip"), "the 4th attempt should be blocked");
});

test("reports a sane retry-after", () => {
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
  rl.record("ip");
  const limited = rl.isLimited("ip");
  assert.ok(limited);
  assert.equal(limited.retryAfterSec, 60);

  clock.advance(59_500);
  // Never advertises 0 — a client that honors it would retry immediately and
  // get blocked again.
  assert.equal(rl.isLimited("ip")?.retryAfterSec, 1);
});

test("the window expires", () => {
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 2, windowMs: 1000, now: clock.now });
  rl.record("ip");
  rl.record("ip");
  assert.ok(rl.isLimited("ip"));

  clock.advance(1001);
  assert.equal(rl.isLimited("ip"), null, "a fresh window should allow attempts");
});

test("keys are independent", () => {
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 1, windowMs: 1000, now: clock.now });
  rl.record("a");
  assert.ok(rl.isLimited("a"));
  assert.equal(rl.isLimited("b"), null, "one IP must not throttle another");
});

test("reset clears the count", () => {
  // This is what keeps a card that typo'd the code a few times, then got it
  // right, from being locked out on their next score edit.
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 2, windowMs: 1000, now: clock.now });
  rl.record("ip");
  rl.record("ip");
  assert.ok(rl.isLimited("ip"));
  rl.reset("ip");
  assert.equal(rl.isLimited("ip"), null);
});

test("isLimited does not itself consume budget", () => {
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 1, windowMs: 1000, now: clock.now });
  for (let i = 0; i < 10; i++) assert.equal(rl.isLimited("ip"), null);
  rl.record("ip");
  assert.ok(rl.isLimited("ip"));
});

test("expired buckets are swept", () => {
  const clock = fakeClock();
  const rl = createFailureLimiter({ limit: 1, windowMs: 1000, now: clock.now });
  for (let i = 0; i < 1000; i++) rl.record(`ip-${i}`);
  // Sweeping is internal, so assert on the behavior it protects: after the
  // window passes, every one of those keys is allowed again.
  clock.advance(1001);
  rl.record("trigger-sweep");
  for (let i = 0; i < 1000; i++) {
    assert.equal(rl.isLimited(`ip-${i}`), null);
  }
});
