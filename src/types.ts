/**
 * Shared types for pi-spend-guard.
 *
 * This module has no imports on purpose: every other module can depend on it
 * without pulling in pi APIs, which keeps the core logic unit-testable with
 * plain `node --test`.
 */

/** An amount of money in US dollars. */
export type Usd = number;

/** A budget window. `session` resets with the conversation, the others with the clock. */
export type BudgetScope = "session" | "daily" | "monthly";

/**
 * Spend thresholds in USD for one scope.
 *
 * Every field is optional. `null` and `undefined` both mean "not configured".
 * `0` is a valid threshold and means "fire immediately".
 */
export interface BudgetThresholds {
  /** Notify the user once spend reaches this. */
  warn?: Usd | null;
  /** Switch to a cheaper model once spend reaches this. */
  downgrade?: Usd | null;
  /** Abort the request once spend reaches this. */
  block?: Usd | null;
}

/** Thresholds per scope. A scope with no entry is unconstrained. */
export interface BudgetLimits {
  session?: BudgetThresholds;
  daily?: BudgetThresholds;
  monthly?: BudgetThresholds;
}

/** Token counts for a single model call. Mirrors pi-ai's `Usage` without the cost fields. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** One recorded model call. */
export interface SpendRecord {
  /** Epoch milliseconds when the call finished. */
  at: number;
  /** Session the call belongs to, when known. */
  sessionId?: string;
  provider: string;
  model: string;
  /** Cost in USD, reported by the provider or estimated from catalog rates. */
  cost: Usd;
  usage: TokenUsage;
  /** True when `cost` was derived from catalog rates because the provider reported none. */
  estimated: boolean;
  /**
   * True when no price source could be found at all, so `cost` is 0 because the
   * price is unknown rather than because the call was free. Without this flag a
   * zero is ambiguous, and a guard that silently counts everything as free looks
   * exactly like a guard that is working.
   */
  unpriced?: boolean;
}

export type VerdictAction = "allow" | "warn" | "downgrade" | "block";

/** The outcome of evaluating spend against the configured limits. */
export interface Verdict {
  action: VerdictAction;
  /** Which budget was hit. Only set when `action` is not `allow`. */
  scope?: BudgetScope;
  spent?: Usd;
  limit?: Usd;
  /**
   * Cost of the request about to be sent, when that request is what pushes the
   * scope past its limit. Distinguishes "you are already over" from "this call
   * would put you over", which need different messages.
   */
  projected?: Usd;
}

/** How to pick a cheaper model when a downgrade threshold is crossed. */
export interface DowngradePolicy {
  enabled: boolean;
  /** Explicit model id, e.g. `"deepseek-chat"`. Takes precedence over `preferProviders`. */
  model: string | null;
  /** When no explicit model is set, pick the cheapest available model from these providers. */
  preferProviders: string[];
}

export interface NotifyPolicy {
  onWarn: boolean;
  onDowngrade: boolean;
  onBlock: boolean;
}

export interface BudgetConfig {
  enabled: boolean;
  limits: BudgetLimits;
  downgrade: DowngradePolicy;
  /** When false, a block verdict only warns instead of aborting the request. */
  block: { enabled: boolean };
  estimate: EstimatePolicy;
  /**
   * Automatic rate lookup from a published price list (models.dev by default).
   *
   * The config `pricing` table and the model catalog both fail on the same
   * setups — local gateways and resellers that ship no price — and a guard
   * with no rate silently never fires. This fills that gap without hand-copying
   * numbers. It is the only feature that touches the network, it is fetched in
   * the background at session start, and disabling it degrades cleanly to the
   * offline sources.
   */
  rates: RatesPolicy;
  /**
   * User-supplied model rates.
   *
   * The model catalog pi ships with is frequently empty — local gateways,
   * self-hosted proxies, and unlisted models all carry no price. Without a rate
   * every budget evaluates to zero and enforcement silently never fires, so this
   * table is what makes the guard work on those setups.
   */
  pricing: PricingTable;
  notify: NotifyPolicy;
  /** Persisted records older than this many days are dropped. */
  retentionDays: number;
}

/**
 * Pre-flight estimation of the request about to be sent.
 *
 * Spend totals alone only describe the past. Checking them immediately before a
 * request still lets the *last* request overshoot, because its own cost is not
 * counted yet. Projecting the upcoming call turns the guard from an accountant
 * into a gate: the request that would cross a limit is stopped before it is sent.
 */
export interface EstimatePolicy {
  enabled: boolean;
  /**
   * Output tokens assumed for the upcoming call. Deliberately not `maxTokens`:
   * reserving a model's full output ceiling would block requests that would in
   * practice cost far less. Raise this for long-form or high-effort runs.
   */
  outputTokens: number;
}

/**
 * Automatic rate lookup from a published price list.
 *
 * Rates are cached on disk and refreshed in the background once the cache is
 * older than `ttlHours`, so the enforcement path never waits on the network.
 * A failed or disabled fetch leaves the previous snapshot (or none) in place
 * and the guard keeps working from the offline sources.
 */
export interface RatesPolicy {
  remote: {
    enabled: boolean;
    /** Cache lifetime. Refreshes happen in the background, never inline. */
    ttlHours: number;
    /** Source of the price list. Must serve models.dev's `api.json` shape. */
    url: string;
    /** Give up on a slow fetch rather than hold the process open. */
    timeoutMs: number;
  };
}

/** Per-million-token rates for one model, as written in the guard config. */
export interface PricingEntry {
  input: number;
  output: number;
  /** Falls back to the `input` rate, so a partial entry still counts something. */
  cacheRead?: number;
  /** Falls back to the `input` rate, so a partial entry still counts something. */
  cacheWrite?: number;
  /** Request-wide pricing tiers, mirroring the model catalog. */
  tiers?: PricingTier[];
}

/** A request-wide pricing tier, matching pi-ai's `ModelCost` tiers. */
export interface PricingTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
/**
 * User-supplied rates, keyed by model.
 *
 * Keys are matched most-specific-first: `provider/model`, then `provider/*`,
 * then `model`, then `*`.
 */
export type PricingTable = Record<string, PricingEntry>;
