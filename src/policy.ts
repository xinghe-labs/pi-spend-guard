/**
 * Budget policy evaluation.
 *
 * Pure functions only — no pi APIs, no I/O. This is the part of the extension
 * that decides *what* should happen, kept separate from the part that makes it
 * happen, so it can be tested exhaustively without an agent.
 */
import type {
  BudgetLimits,
  BudgetScope,
  BudgetThresholds,
  Usd,
  Verdict,
  VerdictAction,
} from "./types.ts";

/** Scopes from narrowest to widest. Also the order verdicts are reported in. */
export const SCOPE_ORDER: readonly BudgetScope[] = ["session", "daily", "monthly"];

const SEVERITY: Record<VerdictAction, number> = {
  allow: 0,
  warn: 1,
  downgrade: 2,
  block: 3,
};

/**
 * Read a threshold.
 *
 * `0` is a meaningful threshold ("fire immediately"), so this deliberately does
 * not use `??` — only a real finite number counts as configured.
 */
function threshold(value: Usd | null | undefined): Usd | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Evaluate one scope's spend against one set of thresholds. */
export function evaluateThresholds(spent: Usd, limits: BudgetThresholds | undefined): Verdict {
  if (!limits) return { action: "allow" };

  const block = threshold(limits.block);
  if (block !== null && spent >= block) {
    return { action: "block", spent, limit: block };
  }

  const downgrade = threshold(limits.downgrade);
  if (downgrade !== null && spent >= downgrade) {
    return { action: "downgrade", spent, limit: downgrade };
  }

  const warn = threshold(limits.warn);
  if (warn !== null && spent >= warn) {
    return { action: "warn", spent, limit: warn };
  }

  return { action: "allow" };
}

/**
 * Evaluate every scope and return the most severe verdict.
 *
 * A block in any scope wins. Ties are broken by {@link SCOPE_ORDER}, so the
 * user hears about the tightest budget they actually hit rather than the widest.
 */
export function evaluateBudgets(
  spend: Partial<Record<BudgetScope, Usd>>,
  limits: BudgetLimits,
): Verdict {
  let worst: Verdict = { action: "allow" };

  for (const scope of SCOPE_ORDER) {
    const verdict = evaluateThresholds(spend[scope] ?? 0, limits[scope]);
    if (SEVERITY[verdict.action] > SEVERITY[worst.action]) {
      worst = { ...verdict, scope };
    }
  }

  return worst;
}

/** True when the verdict should stop work rather than merely annotate it. */
export function isBlocking(verdict: Verdict): boolean {
  return verdict.action === "block";
}

/**
 * Add an upcoming amount to every scope.
 *
 * A request that is about to be sent will eventually be recorded against all
 * three scopes, so all three have to be projected — not just `session`.
 * Non-positive amounts return the input unchanged so callers can pass a zero
 * estimate without special-casing it.
 */
export function projectSpend(
  spend: Partial<Record<BudgetScope, Usd>>,
  upcoming: Usd,
): Partial<Record<BudgetScope, Usd>> {
  if (!Number.isFinite(upcoming) || upcoming <= 0) return spend;
  return {
    session: (spend.session ?? 0) + upcoming,
    daily: (spend.daily ?? 0) + upcoming,
    monthly: (spend.monthly ?? 0) + upcoming,
  };
}

/**
 * Format a USD amount.
 *
 * Small amounts keep more precision: a warning at "$0.00" is useless, and
 * sub-cent calls are normal with cheap models.
 */
export function formatUsd(value: Usd): string {
  if (!Number.isFinite(value)) return "$0.00";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** One-line human summary of a verdict, used for notifications. */
export function describeVerdict(verdict: Verdict): string {
  if (verdict.action === "allow") return "Within budget";

  const scope = verdict.scope ?? "session";
  const spent = formatUsd(verdict.spent ?? 0);
  const limit = formatUsd(verdict.limit ?? 0);
  const where = `${spent} of ${limit} (${scope})`;

  switch (verdict.action) {
    case "warn":
      return `Budget warning: ${where}`;
    case "downgrade":
      return `Budget exceeded: ${where} — switching to a cheaper model`;
    case "block":
      // A projected block is preventive, not a report of money already spent.
      // Saying "exhausted" here would be false and would hide why we stopped.
      if (verdict.projected !== undefined && verdict.projected > 0) {
        return `Budget: this request (~${formatUsd(verdict.projected)}) would take ${scope} spend to ${formatUsd(
          (verdict.spent ?? 0),
        )}, past the ${formatUsd(verdict.limit ?? 0)} limit — blocked before sending`;
      }
      return `Budget exhausted: ${where} — request blocked`;
    default:
      return "Within budget";
  }
}

/**
 * Choose the cheapest model from a candidate list.
 *
 * Price is the catalog `input` + `output` rate, which is enough to rank models
 * for a downgrade. Candidates without usable rates are ignored rather than
 * guessed at.
 */
export function pickCheapest<T extends { id: string; cost?: { input: number; output: number } }>(
  candidates: readonly T[],
  currentId?: string,
): T | null {
  let best: T | null = null;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const cost = candidate.cost;
    if (!cost) continue;
    const price = cost.input + cost.output;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (currentId !== undefined && candidate.id === currentId) continue;
    if (price < bestPrice) {
      best = candidate;
      bestPrice = price;
    }
  }

  return best;
}
