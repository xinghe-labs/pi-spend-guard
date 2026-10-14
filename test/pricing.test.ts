/**
 * Unit tests for rate resolution.
 *
 * The resolver decides whether the guard can measure spend at all, so these
 * cover the precedence rules and the fallbacks that keep a partial config usable.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogRates,
  entryToRates,
  hasUsableRates,
  lookupPricing,
  resolveRates,
} from "../src/pricing.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model(provider: string, id: string, cost?: unknown): any {
  return { provider, id, ...(cost ? { cost } : {}) };
}

test("an empty table resolves nothing", () => {
  assert.deepEqual(resolveRates(model("custom", "m"), {}), { source: "none" });
});

test("an exact provider/model key wins", () => {
  const table = {
    "custom/m": { input: 1, output: 2 },
    "custom/*": { input: 9, output: 9 },
    "*": { input: 5, output: 5 },
  };
  assert.equal(lookupPricing(table, "custom", "m")?.input, 1);
});

test("provider/* is used when the exact key is missing", () => {
  const table = { "custom/*": { input: 9, output: 9 }, "*": { input: 5, output: 5 } };
  assert.equal(lookupPricing(table, "custom", "m")?.input, 9);
});

test("a bare model id matches across providers", () => {
  assert.equal(lookupPricing({ m: { input: 4, output: 4 } }, "anything", "m")?.input, 4);
});

test("* is the last resort", () => {
  assert.equal(lookupPricing({ "*": { input: 5, output: 5 } }, "custom", "m")?.input, 5);
});

test("an entry that cannot price anything is skipped", () => {
  const table = { "custom/m": { input: 0, output: 0 }, "custom/*": { input: 2, output: 2 } };
  assert.equal(
    lookupPricing(table, "custom", "m")?.input,
    2,
    "a zero entry must not shadow a usable broader one",
  );
});

test("cache rates default to the input rate", () => {
  const rates = entryToRates({ input: 3, output: 15 });
  assert.equal(rates.cacheRead, 3);
  assert.equal(rates.cacheWrite, 3);
});

test("explicit cache rates are kept", () => {
  const rates = entryToRates({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.equal(rates.cacheRead, 0.3);
  assert.equal(rates.cacheWrite, 3.75);
});

test("tiers inherit unspecified rates", () => {
  const rates = entryToRates({
    input: 3,
    output: 15,
    tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5 }],
  });
  assert.equal(rates.tiers?.[0]?.cacheRead, 6);
  assert.equal(rates.tiers?.[0]?.inputTokensAbove, 200_000);
});

test("an all-zero catalog entry counts as unpriced", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(catalogRates(model("custom", "m", cost)), undefined);
});

test("a catalog entry with any rate is usable", () => {
  const rates = catalogRates(model("anthropic", "m", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }));
  assert.equal(rates?.input, 3);
  assert.equal(hasUsableRates(rates), true);
});

test("the config table outranks the catalog", () => {
  const resolved = resolveRates(
    model("anthropic", "m", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    { "anthropic/m": { input: 1, output: 2 } },
  );
  assert.equal(resolved.source, "config");
  assert.equal(resolved.rates?.input, 1);
});

test("the catalog is used when the table has no match", () => {
  const resolved = resolveRates(
    model("anthropic", "m", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    { "other/*": { input: 1, output: 2 } },
  );
  assert.equal(resolved.source, "catalog");
  assert.equal(resolved.rates?.input, 15);
});

test("a model with neither source resolves to none", () => {
  assert.deepEqual(resolveRates(model("custom", "m"), { "other/*": { input: 1, output: 1 } }), {
    source: "none",
  });
});

test("an undefined model resolves to none rather than throwing", () => {
  assert.deepEqual(resolveRates(undefined, { "*": { input: 1, output: 1 } }), { source: "none" });
});
