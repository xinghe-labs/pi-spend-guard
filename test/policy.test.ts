import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOPE_ORDER,
  describeVerdict,
  evaluateBudgets,
  evaluateThresholds,
  formatUsd,
  isBlocking,
  pickCheapest,
} from "../src/policy.ts";

test("allows spend below every threshold", () => {
  const verdict = evaluateThresholds(1, { warn: 2, downgrade: 5, block: 10 });
  assert.equal(verdict.action, "allow");
});

test("warns exactly at the warn threshold", () => {
  const verdict = evaluateThresholds(2, { warn: 2, downgrade: 5, block: 10 });
  assert.equal(verdict.action, "warn");
  assert.equal(verdict.limit, 2);
  assert.equal(verdict.spent, 2);
});

test("downgrades at the downgrade threshold", () => {
  const verdict = evaluateThresholds(5, { warn: 2, downgrade: 5, block: 10 });
  assert.equal(verdict.action, "downgrade");
  assert.equal(verdict.limit, 5);
});

test("blocks at the block threshold", () => {
  const verdict = evaluateThresholds(10, { warn: 2, downgrade: 5, block: 10 });
  assert.equal(verdict.action, "block");
  assert.equal(verdict.limit, 10);
});

test("block wins over warn and downgrade when several are crossed", () => {
  const verdict = evaluateThresholds(100, { warn: 2, downgrade: 5, block: 10 });
  assert.equal(verdict.action, "block");
});

test("treats 0 as a real threshold, not as unset", () => {
  const verdict = evaluateThresholds(0, { block: 0 });
  assert.equal(verdict.action, "block");
  assert.equal(verdict.limit, 0);
});

test("treats null and undefined thresholds as unset", () => {
  assert.equal(evaluateThresholds(1000, { warn: null, downgrade: null, block: null }).action, "allow");
  assert.equal(evaluateThresholds(1000, {}).action, "allow");
  assert.equal(evaluateThresholds(1000, undefined).action, "allow");
});

test("only configured thresholds fire", () => {
  // No block/downgrade configured: spend far past them still only warns.
  const verdict = evaluateThresholds(1000, { warn: 5 });
  assert.equal(verdict.action, "warn");
});

test("ignores non-finite thresholds", () => {
  assert.equal(evaluateThresholds(1000, { block: Number.NaN }).action, "allow");
  assert.equal(evaluateThresholds(1000, { block: Number.POSITIVE_INFINITY }).action, "allow");
});

test("SCOPE_ORDER runs narrowest to widest", () => {
  assert.deepEqual([...SCOPE_ORDER], ["session", "daily", "monthly"]);
});

test("evaluateBudgets reports the most severe scope", () => {
  const verdict = evaluateBudgets(
    { session: 1, daily: 1, monthly: 600 },
    { monthly: { warn: 100, downgrade: 250, block: 500 } },
  );
  assert.equal(verdict.action, "block");
  assert.equal(verdict.scope, "monthly");
});

test("evaluateBudgets breaks severity ties by scope order", () => {
  const limits = {
    session: { warn: 2 },
    daily: { warn: 2 },
    monthly: { warn: 2 },
  };
  const verdict = evaluateBudgets({ session: 3, daily: 3, monthly: 3 }, limits);
  assert.equal(verdict.action, "warn");
  assert.equal(verdict.scope, "session");
});

test("evaluateBudgets returns allow when nothing is configured", () => {
  assert.equal(evaluateBudgets({ session: 1e6, daily: 1e6, monthly: 1e6 }, {}).action, "allow");
});

test("evaluateBudgets tolerates missing scope spend", () => {
  const verdict = evaluateBudgets({}, { daily: { block: 1 } });
  assert.equal(verdict.action, "allow");
});

test("isBlocking only reports true for block", () => {
  assert.equal(isBlocking({ action: "block" }), true);
  assert.equal(isBlocking({ action: "warn" }), false);
  assert.equal(isBlocking({ action: "downgrade" }), false);
  assert.equal(isBlocking({ action: "allow" }), false);
});

test("formatUsd keeps sub-cent precision", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.0005), "$0.0005");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(12.345), "$12.35");
  assert.equal(formatUsd(Number.NaN), "$0.00");
});

test("describeVerdict names the scope, spend, and limit", () => {
  const text = describeVerdict({ action: "block", scope: "daily", spent: 12, limit: 10 });
  assert.match(text, /Budget exhausted/);
  assert.match(text, /\$12\.00 of \$10\.00/);
  assert.match(text, /daily/);
});

test("pickCheapest ranks by input plus output rate", () => {
  const models = [
    { id: "expensive", cost: { input: 15, output: 75 } },
    { id: "cheap", cost: { input: 0.5, output: 1.5 } },
    { id: "mid", cost: { input: 3, output: 15 } },
  ];
  assert.equal(pickCheapest(models)?.id, "cheap");
});

test("pickCheapest skips the current model", () => {
  const models = [
    { id: "cheap", cost: { input: 0.5, output: 1.5 } },
    { id: "mid", cost: { input: 3, output: 15 } },
  ];
  assert.equal(pickCheapest(models, "cheap")?.id, "mid");
});

test("pickCheapest ignores candidates without usable rates", () => {
  const models = [
    { id: "unknown" },
    { id: "free", cost: { input: 0, output: 0 } },
    { id: "priced", cost: { input: 1, output: 2 } },
  ];
  assert.equal(pickCheapest(models)?.id, "priced");
});

test("pickCheapest returns null when nothing is usable", () => {
  assert.equal(pickCheapest([]), null);
  assert.equal(pickCheapest([{ id: "unknown" }]), null);
});
