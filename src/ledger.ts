/**
 * The spend ledger: recording, aggregating, and pruning cost records.
 *
 * Pure functions only. Persistence lives in `store.ts`; this module just knows
 * how to do arithmetic on records.
 */
import type { SpendRecord, TokenUsage, Usd } from "./types.ts";

/** Catalog rates in USD per million tokens. */
export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Request-wide pricing tier.
 *
 * Per pi-ai, the highest tier whose `inputTokensAbove` is exceeded applies to
 * the *whole* request, not just the tokens above the threshold.
 */
export interface CostTier extends CostRates {
  inputTokensAbove: number;
}

export interface ModelRates extends CostRates {
  tiers?: CostTier[];
}

const MILLION = 1_000_000;

/** Highest matching request-wide tier, or `null` when base rates apply. */
export function selectTier(inputTokens: number, tiers: readonly CostTier[] | undefined): CostTier | null {
  if (!tiers || tiers.length === 0) return null;

  let best: CostTier | null = null;
  for (const tier of tiers) {
    if (!Number.isFinite(tier.inputTokensAbove)) continue;
    if (inputTokens > tier.inputTokensAbove) {
      if (best === null || tier.inputTokensAbove > best.inputTokensAbove) best = tier;
    }
  }
  return best;
}

/**
 * Estimate USD cost from token usage and catalog rates.
 *
 * Only used when the provider does not report its own cost. Provider-reported
 * cost is always preferred, because it reflects real discounts, tiers, and
 * cache pricing that a catalog lookup cannot know about.
 */
export function estimateCost(usage: TokenUsage, rates: ModelRates): Usd {
  const tier = selectTier(usage.input, rates.tiers);
  const r: CostRates = tier ?? rates;

  const cost =
    (usage.input * r.input +
      usage.output * r.output +
      usage.cacheRead * r.cacheRead +
      usage.cacheWrite * r.cacheWrite) /
    MILLION;

  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** True when a cost can be counted: finite and not negative. */
function countable(cost: number): boolean {
  return Number.isFinite(cost) && cost >= 0;
}

/** Sum of all record costs. */
export function totalCost(records: readonly SpendRecord[]): Usd {
  let sum = 0;
  for (const record of records) {
    if (countable(record.cost)) sum += record.cost;
  }
  return sum;
}

/** Local midnight at or before `at`. Daily budgets follow the user's clock. */
export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local first-of-month midnight at or before `at`. */
export function startOfMonth(at: number): number {
  const d = new Date(at);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Sum of costs recorded at or after `from`. */
export function spendSince(records: readonly SpendRecord[], from: number): Usd {
  let sum = 0;
  for (const record of records) {
    if (record.at >= from && countable(record.cost)) sum += record.cost;
  }
  return sum;
}

/** Sum of costs inside `[from, to)`; `to` defaults to infinity. Exported for tests and external consumers; production code uses `spendSince`. */
export function spendBetween(
  records: readonly SpendRecord[],
  from: number,
  to = Number.POSITIVE_INFINITY,
): Usd {
  let sum = 0;
  for (const record of records) {
    if (record.at >= from && record.at < to && countable(record.cost)) sum += record.cost;
  }
  return sum;
}

/** Per-model totals, highest spend first. */
export function spendByModel(records: readonly SpendRecord[]): Array<{ model: string; cost: Usd }> {
  const totals = new Map<string, Usd>();
  for (const record of records) {
    if (!countable(record.cost)) continue;
    totals.set(record.model, (totals.get(record.model) ?? 0) + record.cost);
  }
  return [...totals.entries()]
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);
}

/** Drop records older than `retentionDays`. A non-positive value keeps everything. */
export function prune(
  records: readonly SpendRecord[],
  retentionDays: number,
  now: number,
): SpendRecord[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [...records];
  const cutoff = startOfDay(now) - retentionDays * 86_400_000;
  return records.filter((record) => record.at >= cutoff);
}

/** Cap a ledger so a pathological session cannot grow the file without bound. */
export function capRecords(records: readonly SpendRecord[], max: number): SpendRecord[] {
  if (!Number.isFinite(max) || max <= 0 || records.length <= max) return [...records];
  return records.slice(records.length - max);
}
