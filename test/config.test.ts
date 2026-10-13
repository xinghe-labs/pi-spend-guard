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
