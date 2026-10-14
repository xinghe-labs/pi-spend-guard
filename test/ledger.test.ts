import test from "node:test";
import assert from "node:assert/strict";

import {
  capRecords,
  estimateCost,
  prune,
  selectTier,
  spendBetween,
  spendByModel,
  spendSince,
  startOfDay,
  startOfMonth,
  totalCost,
} from "../src/ledger.ts";
import type { SpendRecord, TokenUsage } from "../src/types.ts";

const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...partial,
  };
}

function record(at: number, cost: number, extra: Partial<SpendRecord> = {}): SpendRecord {
  return {
    at,
    provider: "test",
    model: "test-model",
    cost,
    usage: usage({}),
    estimated: false,
    ...extra,
  };
}

test("estimateCost prices each token class per million", () => {
  assert.equal(estimateCost(usage({ input: 1_000_000 }), RATES), 3);
  assert.equal(estimateCost(usage({ output: 1_000_000 }), RATES), 15);
  assert.equal(estimateCost(usage({ cacheRead: 1_000_000 }), RATES), 0.3);
  assert.equal(estimateCost(usage({ cacheWrite: 1_000_000 }), RATES), 3.75);
});

test("estimateCost combines classes and scales below a million", () => {
  const cost = estimateCost(usage({ input: 1_000, output: 2_000 }), RATES);
  assert.equal(cost, (1_000 * 3 + 2_000 * 15) / 1_000_000);
});

test("estimateCost never returns a negative or non-finite value", () => {
  assert.equal(estimateCost(usage({}), RATES), 0);
  assert.equal(estimateCost(usage({ input: Number.NaN }), RATES), 0);
});

test("selectTier picks the highest matching input threshold", () => {
  const tiers = [
    { inputTokensAbove: 100, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    { inputTokensAbove: 1_000, input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
  ];
  assert.equal(selectTier(50, tiers), null);
  assert.equal(selectTier(500, tiers)?.inputTokensAbove, 100);
  assert.equal(selectTier(5_000, tiers)?.inputTokensAbove, 1_000);
});

test("selectTier requires exceeding the threshold, not meeting it", () => {
  const tiers = [{ inputTokensAbove: 100, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }];
  assert.equal(selectTier(100, tiers), null);
  assert.notEqual(selectTier(101, tiers), null);
});

test("estimateCost applies a request-wide tier to the whole request", () => {
  const rates = {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 1_000, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
  };
  // 2000 input tokens at tier rate 1/million.
  assert.equal(estimateCost(usage({ input: 2_000 }), rates), 2_000 / 1_000_000);
});

test("selectTier ignores tiers with non-finite thresholds", () => {
  const tiers = [{ inputTokensAbove: Number.NaN, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }];
  assert.equal(selectTier(1e9, tiers), null);
});

test("totalCost sums every record", () => {
  assert.equal(totalCost([record(1, 1), record(2, 2.5)]), 3.5);
  assert.equal(totalCost([]), 0);
});

test("totalCost ignores non-finite costs", () => {
  assert.equal(totalCost([record(1, 1), record(2, Number.NaN)]), 1);
});

test("startOfDay is local midnight", () => {
  const at = new Date(2026, 4, 15, 13, 45, 30, 500).getTime();
  assert.equal(startOfDay(at), new Date(2026, 4, 15, 0, 0, 0, 0).getTime());
});

test("startOfMonth is local first of month", () => {
  const at = new Date(2026, 4, 15, 13, 45, 30).getTime();
  assert.equal(startOfMonth(at), new Date(2026, 4, 1, 0, 0, 0, 0).getTime());
});

test("spendSince and spendBetween window correctly", () => {
  const records = [record(100, 1), record(200, 2), record(300, 4)];
  assert.equal(spendSince(records, 200), 6);
  assert.equal(spendSince(records, 301), 0);
  assert.equal(spendBetween(records, 150, 300), 2);
  assert.equal(spendBetween(records, 100), 7);
});

test("spendSince with the day/month windows reproduces the scope totals", () => {
  const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
  const records = [
    record(now, 1, { sessionId: "s1" }),
    record(new Date(2026, 4, 15, 8, 0, 0).getTime(), 2, { sessionId: "s2" }),
    record(new Date(2026, 4, 2, 8, 0, 0).getTime(), 4, { sessionId: "s1" }),
    record(new Date(2026, 3, 30, 8, 0, 0).getTime(), 8, { sessionId: "s1" }),
  ];

  // The extension's daily/monthly scopes are exactly these windows (session
  // comes from the branch, not the ledger).
  assert.equal(spendSince(records, startOfDay(now)), 3);
  assert.equal(spendSince(records, startOfMonth(now)), 7);
});

test("spendBetween windows correctly", () => {
  const records = [record(100, 1), record(200, 2), record(300, 4)];
  assert.equal(spendBetween(records, 150, 300), 2);
  assert.equal(spendBetween(records, 100), 7);
});

test("spendByModel sorts by spend descending", () => {
  const records = [
    record(1, 1, { model: "a" }),
    record(2, 5, { model: "b" }),
    record(3, 2, { model: "a" }),
  ];
  assert.deepEqual(spendByModel(records), [
    { model: "b", cost: 5 },
    { model: "a", cost: 3 },
  ]);
});

test("prune drops records older than the retention window", () => {
  const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
  const records = [
    record(new Date(2026, 4, 15, 1, 0, 0).getTime(), 1),
    record(new Date(2026, 4, 1, 1, 0, 0).getTime(), 2),
    record(new Date(2025, 0, 1, 1, 0, 0).getTime(), 4),
  ];
  const kept = prune(records, 30, now);
  assert.equal(kept.length, 2);
  assert.equal(totalCost(kept), 3);
});

test("prune keeps everything when retention is disabled", () => {
  const records = [record(1, 1), record(2, 2)];
  assert.equal(prune(records, 0, Date.now()).length, 2);
  assert.equal(prune(records, -1, Date.now()).length, 2);
});

test("prune does not mutate its input", () => {
  const records = [record(1, 1)];
  prune(records, 0, Date.now());
  assert.equal(records.length, 1);
});

test("capRecords keeps the newest records", () => {
  const records = [record(1, 1), record(2, 2), record(3, 3)];
  assert.deepEqual(
    capRecords(records, 2).map((r) => r.at),
    [2, 3],
  );
  assert.equal(capRecords(records, 0).length, 3);
  assert.equal(capRecords(records, 10).length, 3);
});
