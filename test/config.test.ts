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

test("garbage thresholds fall back to null rather than throwing", () => {
  const config = normalizeConfig({ limits: { daily: { block: "abc" } } });
  assert.equal(config.limits.daily?.block, null);
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
