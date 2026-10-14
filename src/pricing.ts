/**
 * Rate resolution: where the price of a model call comes from.
 *
 * Pure functions only — no pi APIs beyond the `Model` type, no I/O.
 *
 * Three sources exist, in order of authority:
 *
 *   1. `Usage.cost.total`, reported by the provider. Handled by the caller,
 *      because it is per-call rather than per-model.
 *   2. The user's `pricing` table in the guard config.
 *   3. The model catalog that ships with pi.
 *
 * The config table is not a convenience. The catalog is frequently empty —
 * local gateways, self-hosted proxies, corporate AI gateways, and unlisted
 * models all carry no price — and with no rate every budget evaluates to zero,
 * so enforcement silently never fires while still looking healthy.
 */
import type { Model } from "@earendil-works/pi-ai";

import type { ModelRates } from "./ledger.ts";
import type { PricingEntry, PricingTable } from "./types.ts";

/** Where a model's rates came from, for reporting. */
export type RateSource = "config" | "catalog" | "none";

export interface ResolvedRates {
  rates?: ModelRates;
  source: RateSource;
}

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * True when a rates object can actually price something.
 *
 * An all-zero rates object is indistinguishable from no pricing at all, and
 * treating it as usable would defeat the purpose of the guard.
 */
export function hasUsableRates(rates: ModelRates | undefined): boolean {
  if (!rates) return false;
  return (
    rates.input > 0 ||
    rates.output > 0 ||
    rates.cacheRead > 0 ||
    rates.cacheWrite > 0 ||
    (rates.tiers?.length ?? 0) > 0
  );
}

/**
 * Convert a config entry into full rates.
 *
 * Cache rates default to the `input` rate rather than zero. A spend guard should
 * err toward over-counting: pricing cache tokens at zero understates real spend
 * and lets a budget slip past. Set them explicitly to be exact.
 */
export function entryToRates(entry: PricingEntry): ModelRates {
  const input = rate(entry.input) ?? 0;
  const output = rate(entry.output) ?? 0;

  const tiers = entry.tiers?.map((tier) => {
    const tierInput = rate(tier.input) ?? input;
    return {
      inputTokensAbove: rate(tier.inputTokensAbove) ?? 0,
      input: tierInput,
      output: rate(tier.output) ?? output,
      cacheRead: rate(tier.cacheRead) ?? tierInput,
      cacheWrite: rate(tier.cacheWrite) ?? tierInput,
    };
  });

  return {
    input,
    output,
    cacheRead: rate(entry.cacheRead) ?? input,
    cacheWrite: rate(entry.cacheWrite) ?? input,
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
  };
}

/**
 * Find the pricing entry for a model, most specific key first:
 * `provider/model` → `provider/*` → `model` → `*`.
 *
 * Entries that cannot price anything are skipped rather than returned, so a
 * typo'd entry falls through to a broader rule instead of silently zeroing spend.
 */
export function lookupPricing(
  table: PricingTable | undefined,
  provider: string | undefined,
  modelId: string | undefined,
): PricingEntry | undefined {
  if (!table) return undefined;
  // Without a model identity there is nothing to price, so a `*` catch-all must
  // not apply to an unknown model.
  if (!provider && !modelId) return undefined;

  const keys: string[] = [];
  if (provider && modelId) keys.push(`${provider}/${modelId}`);
  if (provider) keys.push(`${provider}/*`);
  if (modelId) keys.push(modelId);
  keys.push("*");

  for (const key of keys) {
    const entry = table[key];
    if (entry && hasUsableRates(entryToRates(entry))) return entry;
  }
  return undefined;
}

/** Rates from the model catalog pi ships with. */
export function catalogRates(model: Model<any> | undefined): ModelRates | undefined {
  const cost = model?.cost;
  if (!cost) return undefined;

  const rates: ModelRates = {
    input: rate(cost.input) ?? 0,
    output: rate(cost.output) ?? 0,
    cacheRead: rate(cost.cacheRead) ?? 0,
    cacheWrite: rate(cost.cacheWrite) ?? 0,
    tiers: cost.tiers,
  };

  return hasUsableRates(rates) ? rates : undefined;
}

/**
 * The rates to use for a model, and where they came from.
 *
 * The config table outranks the catalog: a rate written into a budget config is
 * a deliberate statement about what this user actually pays, which may differ
 * from list price because of routing, discounts, or a reseller.
 */
export function resolveRates(
  model: Model<any> | undefined,
  table: PricingTable | undefined,
): ResolvedRates {
  const entry = lookupPricing(table, model?.provider, model?.id);
  if (entry) return { rates: entryToRates(entry), source: "config" };

  const catalog = catalogRates(model);
  if (catalog) return { rates: catalog, source: "catalog" };

  return { source: "none" };
}
