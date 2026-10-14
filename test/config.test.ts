import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  applyOverrides,
  formatConfig,
  normalizeConfig,
  parseConfig,
} from "../src/config.ts";

test("an empty config yields the defaults", () => {
  const config = normalizeConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.limits.session?.block, 10);
  assert.equal(config.retentionDays, DEFAULT_CONFIG.retentionDays);
});

test("non-object input falls back to defaults", () => {
  for (const value of [null, undefined, 42, "nope", []]) {
    const config = normalizeConfig(value);
    assert.equal(config.enabled, true);
    assert.equal(config.limits.daily?.block, 50);
  }
});

test("partial limits inherit the default for untouched scopes", () => {
  const config = normalizeConfig({ limits: { session: { block: 1 } } });
  assert.equal(config.limits.session?.block, 1);
  // warn/downgrade were not mentioned, so they keep their defaults.
  assert.equal(config.limits.session?.warn, 2);
  assert.equal(config.limits.session?.downgrade, 5);
  assert.equal(config.limits.daily?.block, 50);
});

test("explicit null disables a single threshold", () => {
  const config = normalizeConfig({ limits: { session: { warn: null, downgrade: null, block: null } } });
  assert.equal(config.limits.session?.warn, null);
  assert.equal(config.limits.session?.downgrade, null);
  assert.equal(config.limits.session?.block, null);
});

test("numeric strings are accepted", () => {
  const config = normalizeConfig({ limits: { daily: { block: "12.5" } } });
  assert.equal(config.limits.daily?.block, 12.5);
});

test("garbage thresholds fall back to the default rather than disabling", () => {
  // "abc" is a typo, not a choice: encoding it as null would silently remove
  // the block limit — the least safe outcome for a budget guard. It must
  // fall back to the scope default instead.
  const config = normalizeConfig({ limits: { daily: { block: "abc" } } });
  assert.equal(config.limits.daily?.block, DEFAULT_CONFIG.limits.daily?.block);
  // Numeric strings remain valid (an explicit value, not garbage).
  assert.equal(normalizeConfig({ limits: { daily: { block: 12.5 } } }).limits.daily?.block, 12.5);
  // Explicit null still means "disabled" — a deliberate choice, honored.
  assert.equal(normalizeConfig({ limits: { daily: { block: null } } }).limits.daily?.block, null);
});

test("normalizeConfig never hands out a reference into DEFAULT_CONFIG", () => {
  const config = normalizeConfig({});
  config.limits.session!.block = 999;
  assert.equal(DEFAULT_CONFIG.limits.session?.block, 10);
});

test("downgrade policy is normalized", () => {
  const config = normalizeConfig({
    downgrade: { enabled: false, model: "  deepseek-chat  ", preferProviders: ["deepseek", 7, ""] },
  });
  assert.equal(config.downgrade.enabled, false);
  assert.equal(config.downgrade.model, "deepseek-chat");
  assert.deepEqual(config.downgrade.preferProviders, ["deepseek"]);
});

test("an empty downgrade model string means unset", () => {
  assert.equal(normalizeConfig({ downgrade: { model: "   " } }).downgrade.model, null);
});

test("retentionDays must be a positive finite number", () => {
  assert.equal(normalizeConfig({ retentionDays: 30 }).retentionDays, 30);
  assert.equal(normalizeConfig({ retentionDays: 0 }).retentionDays, DEFAULT_CONFIG.retentionDays);
  assert.equal(normalizeConfig({ retentionDays: -5 }).retentionDays, DEFAULT_CONFIG.retentionDays);
  assert.equal(normalizeConfig({ retentionDays: "x" }).retentionDays, DEFAULT_CONFIG.retentionDays);
});

test("parseConfig throws only on invalid JSON", () => {
  assert.equal(parseConfig('{"enabled":false}').enabled, false);
  assert.throws(() => parseConfig("{not json"));
});

test("applyOverrides sets a scoped threshold", () => {
  const { config, unknown } = applyOverrides(DEFAULT_CONFIG, ["daily.block=20"]);
  assert.equal(config.limits.daily?.block, 20);
  assert.deepEqual(unknown, []);
  // The original must be untouched.
  assert.equal(DEFAULT_CONFIG.limits.daily?.block, 50);
});

test("applyOverrides can disable a threshold with none/off", () => {
  assert.equal(applyOverrides(DEFAULT_CONFIG, ["session.warn=none"]).config.limits.session?.warn, null);
  assert.equal(applyOverrides(DEFAULT_CONFIG, ["session.warn=off"]).config.limits.session?.warn, null);
});

test("applyOverrides handles boolean and string keys", () => {
  assert.equal(applyOverrides(DEFAULT_CONFIG, ["enabled=false"]).config.enabled, false);
  assert.equal(applyOverrides(DEFAULT_CONFIG, ["downgrade.model=deepseek-chat"]).config.downgrade.model, "deepseek-chat");
  assert.equal(applyOverrides(DEFAULT_CONFIG, ["downgrade.enabled=0"]).config.downgrade.enabled, false);
});

test("applyOverrides reports unknown keys instead of silently ignoring them", () => {
  const { unknown } = applyOverrides(DEFAULT_CONFIG, ["nonsense", "daily.bogus=1", "=5"]);
  assert.deepEqual(unknown, ["nonsense", "daily.bogus=1", "=5"]);
});

test("applyOverrides leaves unmentioned values alone", () => {
  const { config } = applyOverrides(DEFAULT_CONFIG, ["monthly.block=7"]);
  assert.equal(config.limits.session?.block, 10);
  assert.equal(config.limits.monthly?.warn, 100);
});

test("formatConfig renders every scope without throwing", () => {
  const text = formatConfig(DEFAULT_CONFIG);
  assert.match(text, /session/);
  assert.match(text, /daily/);
  assert.match(text, /monthly/);
  assert.match(text, /downgrade/);
});

test("formatConfig handles an unconstrained scope and disabled downgrade", () => {
  const config = normalizeConfig({ limits: { session: null }, downgrade: { enabled: false } });
  const text = formatConfig(config);
  assert.match(text, /session\s+—/);
  assert.match(text, /downgrade: disabled/);
});

test("estimate defaults to enabled with a bounded output assumption", () => {
  const config = normalizeConfig({});
  assert.equal(config.estimate.enabled, true);
  assert.equal(config.estimate.outputTokens, 2048);
});

test("estimate.outputTokens rejects values that cannot be a token count", () => {
  assert.equal(normalizeConfig({ estimate: { outputTokens: 512 } }).estimate.outputTokens, 512);
  assert.equal(normalizeConfig({ estimate: { outputTokens: "1024" } }).estimate.outputTokens, 1024);

  for (const bad of [0, -1, "abc", null]) {
    assert.equal(
      normalizeConfig({ estimate: { outputTokens: bad } }).estimate.outputTokens,
      DEFAULT_CONFIG.estimate.outputTokens,
      `outputTokens=${String(bad)} should fall back to the default`,
    );
  }
});

test("estimate is configurable through overrides", () => {
  const off = applyOverrides(normalizeConfig({}), ["estimate.enabled=false"]);
  assert.deepEqual(off.unknown, []);
  assert.equal(off.config.estimate.enabled, false);

  const sized = applyOverrides(normalizeConfig({}), ["estimate.outputTokens=4096"]);
  assert.deepEqual(sized.unknown, []);
  assert.equal(sized.config.estimate.outputTokens, 4096);
});

test("normalized configs do not share the default estimate object", () => {
  const first = normalizeConfig({});
  const second = normalizeConfig({});
  first.estimate.outputTokens = 1;
  assert.equal(second.estimate.outputTokens, DEFAULT_CONFIG.estimate.outputTokens);
});

test("formatConfig reports the estimate policy", () => {
  assert.match(formatConfig(normalizeConfig({})), /estimate: on \(2048 output tokens assumed\)/);
  assert.match(
    formatConfig(normalizeConfig({ estimate: { enabled: false } })),
    /estimate: off/,
  );
});

test("automatic rate lookup defaults to on with a sane TTL", () => {
  const config = normalizeConfig({});
  assert.equal(config.rates.remote.enabled, true);
  assert.equal(config.rates.remote.ttlHours, 24);
  assert.match(config.rates.remote.url, /^https:\/\//);
  assert.ok(config.rates.remote.timeoutMs > 0);
});

test("rates.remote normalizes and falls back on malformed values", () => {
  const config = normalizeConfig({
    rates: { remote: { enabled: false, ttlHours: "6", timeoutMs: "1500", url: "  https://example.test/list.json  " } },
  });
  assert.equal(config.rates.remote.enabled, false);
  assert.equal(config.rates.remote.ttlHours, 6);
  assert.equal(config.rates.remote.timeoutMs, 1500);
  assert.equal(config.rates.remote.url, "https://example.test/list.json");

  // Malformed values must fall back, never produce a zero TTL that would
  // re-fetch on every session or an empty URL that would break the fetch.
  const bad = normalizeConfig({ rates: { remote: { ttlHours: "soon", timeoutMs: 0, url: "   " } } });
  assert.equal(bad.rates.remote.ttlHours, DEFAULT_CONFIG.rates.remote.ttlHours);
  assert.equal(bad.rates.remote.timeoutMs, DEFAULT_CONFIG.rates.remote.timeoutMs);
  assert.equal(bad.rates.remote.url, DEFAULT_CONFIG.rates.remote.url);
});

test("rates.remote does not alias DEFAULT_CONFIG", () => {
  const config = normalizeConfig({});
  config.rates.remote.ttlHours = 999;
  assert.equal(DEFAULT_CONFIG.rates.remote.ttlHours, 24);
});

test("rates.remote can be changed through /budget set overrides", () => {
  const base = normalizeConfig({});
  const { config, unknown } = applyOverrides(base, [
    "rates.remote.enabled=false",
    "rates.remote.ttlHours=48",
    "rates.remote.url=https://example.test/api.json",
  ]);
  assert.deepEqual(unknown, []);
  assert.equal(config.rates.remote.enabled, false);
  assert.equal(config.rates.remote.ttlHours, 48);
  assert.equal(config.rates.remote.url, "https://example.test/api.json");
  // The original must be untouched.
  assert.equal(base.rates.remote.enabled, true);
});

test("formatConfig reports the automatic rate source", () => {
  assert.match(formatConfig(normalizeConfig({})), /rates\.remote: on/);
  assert.match(
    formatConfig(normalizeConfig({ rates: { remote: { enabled: false } } })),
    /rates\.remote: off/,
  );
});

test("a sub-millisecond timeout cannot disable the feature", () => {
  // Math.floor(0.5) is 0, and AbortSignal.timeout(0) aborts immediately: the
  // refresh would fail forever while /budget still reported the feature as on.
  const config = normalizeConfig({ rates: { remote: { timeoutMs: 0.5 } } });
  assert.ok(config.rates.remote.timeoutMs >= 1);
});

test("an unfetchable URL falls back to the default", () => {
  const defaults = DEFAULT_CONFIG.rates.remote.url;
  // Non-http schemes, garbage, and plaintext to a remote host are refused.
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "not a url", "http://example.com/list.json"]) {
    assert.equal(normalizeConfig({ rates: { remote: { url: bad } } }).rates.remote.url, defaults, bad);
  }
  // https anywhere, and http on loopback, are allowed.
  assert.equal(
    normalizeConfig({ rates: { remote: { url: "https://example.test/api.json" } } }).rates.remote.url,
    "https://example.test/api.json",
  );
  assert.equal(
    normalizeConfig({ rates: { remote: { url: "http://127.0.0.1:8080/api.json" } } }).rates.remote.url,
    "http://127.0.0.1:8080/api.json",
  );
});
