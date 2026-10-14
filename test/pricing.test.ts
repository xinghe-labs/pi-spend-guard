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

test("the published list is used after the config table and the catalog", () => {
  const model = { id: "global:glm-5.3", provider: "workbuddy" } as never;
  const remote = () => ({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
  const resolved = resolveRates(model, {}, remote);
  assert.equal(resolved.source, "models.dev");
  assert.equal(resolved.rates?.input, 1.4);
});

test("the config table and catalog both outrank the published list", () => {
  const remote = () => ({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
  const configTable = { "workbuddy/global:glm-5.3": { input: 9, output: 9 } };
  assert.equal(resolveRates({ id: "global:glm-5.3", provider: "workbuddy" } as never, configTable, remote).source, "config");

  const catalogModel = { id: "m", provider: "p", cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } } as never;
  assert.equal(resolveRates(catalogModel, {}, remote).source, "catalog");
});

test("an unusable published rate is ignored, not treated as priced", () => {
  const allZero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const resolved = resolveRates({ id: "m", provider: "p" } as never, {}, allZero);
  assert.equal(resolved.source, "none");
  assert.equal(resolved.rates, undefined);
});

test("resolveRates still works without a published list", () => {
  const resolved = resolveRates({ id: "m", provider: "p" } as never, { m: { input: 1, output: 2 } });
  assert.equal(resolved.source, "config");
  assert.equal(resolveRates({ id: "m", provider: "p" } as never, {}).source, "none");
});
