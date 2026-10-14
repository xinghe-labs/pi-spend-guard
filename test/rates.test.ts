import test from "node:test";
import assert from "node:assert/strict";

import {
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
