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
}

export type VerdictAction = "allow" | "warn" | "downgrade" | "block";

/** The outcome of evaluating spend against the configured limits. */
export interface Verdict {
  action: VerdictAction;
  /** Which budget was hit. Only set when `action` is not `allow`. */
  scope?: BudgetScope;
  spent?: Usd;
  limit?: Usd;
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
  notify: NotifyPolicy;
  /** Persisted records older than this many days are dropped. */
  retentionDays: number;
}
