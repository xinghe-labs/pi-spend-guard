import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PLAUSIBLE_RATE,
  deserializeSnapshot,
  lookupRemoteRates,
  parseRatesSnapshot,
  remoteToRates,
  serializeSnapshot,
  snapshotIsStale,
} from "../src/rates.ts";

/** A models.dev-shaped payload: `{ provider: { models: { id: { cost } } } }`. */
const API = {
  zai: {
    id: "zai",
    name: "Z.AI",
    models: {
      "glm-5.3": { id: "glm-5.3", cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 } },
      "glm-5.3-flash": { id: "glm-5.3-flash", cost: { input: 0.15, output: 0.5, cache_read: 0.03 } },
      "no-price": { id: "no-price" },
      "all-zero": { id: "all-zero", cost: { input: 0, output: 0 } },
    },
  },
  moonshotai: {
    models: { "kimi-k3": { id: "kimi-k3", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3 } } },
  },
  "some-reseller": {
    models: { "shared-id": { id: "shared-id", cost: { input: 99, output: 99 } } },
  },
  "another-reseller": {
    models: { "shared-id": { id: "shared-id", cost: { input: 5, output: 5 } } },
  },
};

function snapshot() {
  return parseRatesSnapshot(API, "test", 1_000);
}

test("parseRatesSnapshot indexes provider/model and skips unusable entries", () => {
  const parsed = snapshot();
  assert.equal(parsed.byProviderModel.get("zai/glm-5.3")?.input, 1.4);
  assert.equal(parsed.byProviderModel.get("zai/glm-5.3")?.cacheRead, 0.26);
  assert.equal(parsed.byProviderModel.get("zai/glm-5.3")?.cacheWrite, 0);
  // No cost block, and an all-zero cost, both price nothing.
  assert.equal(parsed.byProviderModel.has("zai/no-price"), false);
  assert.equal(parsed.byProviderModel.has("zai/all-zero"), false);
});

test("parseRatesSnapshot tolerates junk without throwing", () => {
  for (const junk of [null, 42, "text", [], { p: null }, { p: { models: 7 } }, { p: { models: { m: 3 } } }]) {
    const parsed = parseRatesSnapshot(junk, "test", 1);
    assert.equal(parsed.byProviderModel.size, 0);
  }
});

test("an exact provider/model match wins", () => {
  const rate = lookupRemoteRates(snapshot(), "zai", "glm-5.3");
  assert.equal(rate?.input, 1.4);
  assert.equal(rate?.output, 4.4);
});

test("a gateway prefix does not hide a published price", () => {
  // Real case: a local gateway namespaces models as `global:glm-5.3`.
  assert.equal(lookupRemoteRates(snapshot(), "workbuddy", "global:glm-5.3")?.input, 1.4);
  assert.equal(lookupRemoteRates(snapshot(), "workbuddy", "global:kimi-k3")?.input, 3);
  // Slash-namespaced ids too.
  assert.equal(lookupRemoteRates(snapshot(), "gw", "zai/glm-5.3")?.input, 1.4);
});

test("an ambiguous id resolves to the first-party provider", () => {
  // `shared-id` is published by two resellers only — no first party, so the
  // guard refuses to guess.
  assert.equal(lookupRemoteRates(snapshot(), "gw", "shared-id"), undefined);
});

test("a first-party entry wins over resellers for a shared id", () => {
  const withFirstParty = parseRatesSnapshot(
    {
      ...API,
      zai: { models: { ...API.zai.models, "shared-id": { cost: { input: 2, output: 8 } } } },
    },
    "test",
    1,
  );
  assert.equal(lookupRemoteRates(withFirstParty, "gw", "shared-id")?.input, 2);
});

test("an unknown model yields no rate rather than a wrong one", () => {
  assert.equal(lookupRemoteRates(snapshot(), "gw", "not-in-the-list"), undefined);
  assert.equal(lookupRemoteRates(undefined, "zai", "glm-5.3"), undefined);
  assert.equal(lookupRemoteRates(snapshot(), undefined, undefined), undefined);
});

test("cache rates fall back to the input rate", () => {
  const rates = remoteToRates({ input: 2, output: 8 });
  assert.equal(rates.cacheRead, 2);
  assert.equal(rates.cacheWrite, 2);
  // Explicit zero is preserved: a provider that genuinely does not charge for
  // cache writes must not be billed at the input rate.
  const explicit = remoteToRates({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
  assert.equal(explicit.cacheRead, 0.26);
  assert.equal(explicit.cacheWrite, 0);
});

test("snapshotIsStale respects the TTL and treats a missing snapshot as stale", () => {
  const fresh = parseRatesSnapshot(API, "test", 1_000);
  assert.equal(snapshotIsStale(undefined, 1_000, 5_000), true);
  assert.equal(snapshotIsStale(fresh, 1_000, 1_500), false);
  assert.equal(snapshotIsStale(fresh, 1_000, 2_001), true);
  assert.equal(snapshotIsStale({ ...fresh, fetchedAt: Number.NaN }, 1_000, 1_500), true);
});

test("a snapshot round-trips through the cache format", () => {
  const original = snapshot();
  const restored = deserializeSnapshot(serializeSnapshot(original));
  assert.ok(restored);
  assert.equal(restored.fetchedAt, original.fetchedAt);
  // Both indexes must survive, or the bare-id fallback silently stops working.
  assert.equal(lookupRemoteRates(restored, "workbuddy", "global:glm-5.3")?.input, 1.4);
  assert.equal(lookupRemoteRates(restored, "zai", "glm-5.3")?.output, 4.4);
});

test("deserializeSnapshot rejects an unusable cache instead of trusting it", () => {
  for (const junk of [null, 5, [], {}, { entries: {} }, { fetchedAt: 1 }, { fetchedAt: 1, entries: 3 }]) {
    assert.equal(deserializeSnapshot(junk), undefined);
  }
});

test("implausible rates are refused rather than trusted", () => {
  // The published list is the only external input. A units change at the source
  // (per-1k instead of per-Mtok) is a 1000x error that would block every request
  // and write that price into the ledger for the whole retention window.
  const huge = parseRatesSnapshot(
    { p: { models: { m: { cost: { input: MAX_PLAUSIBLE_RATE + 1, output: 5 } } } } },
    "test",
    1,
  );
  assert.equal(huge.byProviderModel.size, 0, "an absurd rate must not be indexed");

  // A payload that is mostly implausible is rejected wholesale, so the caller
  // keeps the previous snapshot instead of pricing from garbage.
  const mostlyGarbage = parseRatesSnapshot(
    {
      p: {
        models: {
          a: { cost: { input: 1e9, output: 1 } },
          b: { cost: { input: 1e9, output: 1 } },
          c: { cost: { input: 1e9, output: 1 } },
          d: { cost: { input: 2, output: 3 } },
        },
      },
    },
    "test",
    1,
  );
  assert.equal(mostlyGarbage.byProviderModel.size, 0);

  // A single odd entry among plausible ones is just dropped.
  const oneOdd = parseRatesSnapshot(
    {
      p: {
        models: {
          a: { cost: { input: 1e9, output: 1 } },
          b: { cost: { input: 2, output: 3 } },
          c: { cost: { input: 4, output: 5 } },
        },
      },
    },
    "test",
    1,
  );
  assert.equal(oneOdd.byProviderModel.size, 2);
});

test("ambiguity resolves deterministically, not by payload order", () => {
  const first = {
    "another-reseller": { models: { "shared-id": { cost: { input: 5, output: 5 } } } },
    zai: { models: { "shared-id": { cost: { input: 2, output: 8 } } } },
  };
  const reversed = {
    zai: { models: { "shared-id": { cost: { input: 2, output: 8 } } } },
    "another-reseller": { models: { "shared-id": { cost: { input: 5, output: 5 } } } },
  };
  const a = lookupRemoteRates(parseRatesSnapshot(first, "t", 1), "gw", "shared-id");
  const b = lookupRemoteRates(parseRatesSnapshot(reversed, "t", 1), "gw", "shared-id");
  assert.equal(a?.input, 2, "the model owner must win");
  assert.deepEqual(a, b, "the choice must not depend on payload key order");
});

test("a model owner outranks a hosting platform that resells it", () => {
  // azure/amazon-bedrock publish prices for models they do not own.
  const snap = parseRatesSnapshot(
    {
      "amazon-bedrock": { models: { "claude-sonnet": { cost: { input: 9, output: 9 } } } },
      anthropic: { models: { "claude-sonnet": { cost: { input: 3, output: 15 } } } },
    },
    "t",
    1,
  );
  assert.equal(lookupRemoteRates(snap, "gw", "claude-sonnet")?.input, 3);
});

test("the calling provider's own published price wins over other first parties", () => {
  const snap = parseRatesSnapshot(
    {
      anthropic: { models: { "claude-sonnet": { cost: { input: 3, output: 15 } } } },
      azure: { models: { "claude-sonnet": { cost: { input: 4, output: 16 } } } },
    },
    "t",
    1,
  );
  // Routed through azure: azure's number describes this setup.
  assert.equal(lookupRemoteRates(snap, "azure", "claude-sonnet")?.input, 4);
});

test("a purely numeric id tail is not treated as a model id", () => {
  const snap = parseRatesSnapshot(
    { p: { models: { "0": { cost: { input: 7, output: 7 } } } } },
    "t",
    1,
  );
  // Bedrock-style `us.anthropic.claude-…-v1:0` must not resolve to a model
  // literally named "0".
  assert.equal(lookupRemoteRates(snap, "gw", "us.anthropic.claude-v1:0"), undefined);
});

test("deserializeSnapshot validates the cache format version", () => {
  const good = serializeSnapshot(snapshot()) as Record<string, unknown>;
  assert.ok(deserializeSnapshot(good), "a version-1 cache must load");
  assert.equal(deserializeSnapshot({ ...good, version: 2 }), undefined, "a future format must not be read as this one");
  assert.equal(deserializeSnapshot({ ...good, version: undefined }), undefined);
});

test("deserializeSnapshot rejects an empty or malformed entry set", () => {
  // An empty-but-fresh snapshot would look current and suppress the refresh
  // that would have filled it.
  assert.equal(deserializeSnapshot({ version: 1, fetchedAt: 1, entries: {} }), undefined);
  assert.equal(deserializeSnapshot({ version: 1, fetchedAt: 1, entries: [] }), undefined);
  assert.equal(deserializeSnapshot({ version: 1, fetchedAt: 1 }), undefined);
  assert.equal(deserializeSnapshot({ version: 1, fetchedAt: 1, entries: { p: "x" } }), undefined);
});

test("a hand-written cache is key-normalized like the network path", () => {
  // A cache this code did not write must still be reachable: lookups normalize
  // their key, so the index must be normalized too.
  const restored = deserializeSnapshot({
    version: 1,
    fetchedAt: 1,
    source: "hand",
    entries: { "ZAI/GLM-5.3": { input: 1.4, output: 4.4 } },
  });
  assert.ok(restored);
  assert.equal(lookupRemoteRates(restored, "zai", "glm-5.3")?.input, 1.4);
  assert.equal(lookupRemoteRates(restored, "gw", "global:GLM-5.3")?.input, 1.4);
});

test("the cache index survives ids that contain a slash", () => {
  const snap = parseRatesSnapshot(
    { deepinfra: { models: { "deepseek-ai/DeepSeek-V4.1-Flash": { cost: { input: 0.2, output: 0.6 } } } } },
    "t",
    1,
  );
  const restored = deserializeSnapshot(serializeSnapshot(snap));
  assert.ok(restored);
  // Provider ids never contain a slash in the published list, so splitting on
  // the first one is unambiguous.
  assert.equal(lookupRemoteRates(restored, "deepinfra", "deepseek-ai/DeepSeek-V4.1-Flash")?.input, 0.2);
});
