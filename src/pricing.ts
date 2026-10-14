/**
 * Rate resolution: where the price of a model call comes from.
 *
 * Pure functions only — no pi APIs beyond the `Model` type, no I/O.
 *
 * Four sources exist, in order of authority:
 *
 *   1. `Usage.cost.total`, reported by the provider. Handled by the caller,
 *      because it is per-call rather than per-model.
 *   2. The user's `pricing` table in the guard config.
 *   3. The model catalog that ships with pi.
 *   4. A published price list (models.dev), passed in by the caller.
 *
 * The config table is not a convenience. The catalog is frequently empty —
 * local gateways, self-hosted proxies, corporate AI gateways, and unlisted
 * models all carry no price — and with no rate every budget evaluates to zero,
 * so enforcement silently never fires while still looking healthy. The remote
 * list is the zero-config backstop for the same failure, which is why it ranks
 * below the catalog: a cost written into the model definition is a deliberate
 * statement about this setup, and a published list price is a generic guess.
 */
import type { Model } from "@earendil-works/pi-ai";

import type { ModelRates } from "./ledger.ts";
import type { PricingEntry, PricingTable, RateSourceName } from "./types.ts";

/** Where a model's rates came from, for reporting. */
export type RateSource = RateSourceName | "none";

export interface ResolvedRates {
  rates?: ModelRates;
  source: RateSource;
  /**
   * The key that matched, when a source matched one.
   *
   * A wildcard hit and an exact hit are both `source: "config"`, but only one
   * of them is a statement about this model. Recording the key is what makes a
   * surprising number explainable after the fact.
   */
  key?: string;
}

/** Options for the pricing-table lookup. */
export interface PricingLookupOptions {
  /** Consider the bare `*` catch-all. Off by default in the resolver. */
  includeWildcard?: boolean;
  /** Consider ONLY the bare `*` catch-all. */
  onlyWildcard?: boolean;
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
  options: PricingLookupOptions = {},
): PricingEntry | undefined {
  return matchPricing(table, provider, modelId, options)?.entry;
}

/**
 * Find the pricing entry for a model and report which key matched.
 *
 * The bare `*` catch-all is excluded unless asked for. It is the least
 * specific statement possible — it prices every model of every provider — so
 * the resolver ranks it below the catalog and the published list rather than
 * letting a copied example silently outrank both.
 */
export function matchPricing(
  table: PricingTable | undefined,
  provider: string | undefined,
  modelId: string | undefined,
  options: PricingLookupOptions = {},
): { key: string; entry: PricingEntry } | undefined {
  if (!table) return undefined;
  // Without a model identity there is nothing to price, so a `*` catch-all must
  // not apply to an unknown model.
  if (!provider && !modelId) return undefined;

  const keys: string[] = [];
  if (options.onlyWildcard) {
    keys.push("*");
  } else {
    if (provider && modelId) keys.push(`${provider}/${modelId}`);
    if (provider) keys.push(`${provider}/*`);
    if (modelId) keys.push(modelId);
    if (options.includeWildcard) keys.push("*");
  }

  for (const key of keys) {
    const entry = table[key];
    if (entry && hasUsableRates(entryToRates(entry))) return { key, entry };
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
 * from list price because of routing, discounts, or a reseller. The catalog
 * outranks the remote list for the same reason — it is the definition this
 * setup actually runs.
 */
export function resolveRates(
  model: Model<any> | undefined,
  table: PricingTable | undefined,
  remote?: (provider: string | undefined, modelId: string | undefined) => ModelRates | undefined,
): ResolvedRates {
  const provider = model?.provider;
  const modelId = model?.id;

  // A key that names this model, or at least this provider.
  const specific = matchPricing(table, provider, modelId);
  if (specific) return { rates: entryToRates(specific.entry), source: "config", key: specific.key };

  const catalog = catalogRates(model);
  if (catalog) return { rates: catalog, source: "catalog" };

  const fromList = remote?.(provider, modelId);
  if (fromList && hasUsableRates(fromList)) return { rates: fromList, source: "models.dev" };

  // The bare `*` catch-all is a genuine last resort, not an override: it prices
  // every model of every provider, so it must not outrank a real price for this
  // specific model from the catalog or the published list. Reaching it means
  // nothing more specific exists — which is exactly when a blanket rate is the
  // best available answer.
  const wildcard = matchPricing(table, provider, modelId, { onlyWildcard: true });
  if (wildcard) return { rates: entryToRates(wildcard.entry), source: "config", key: wildcard.key };

  return { source: "none" };
}
