/**
 * pi-budget-guard — hard budget enforcement for pi.
 *
 * The extension watches real provider-reported cost and enforces three
 * escalating responses before you overspend:
 *
 *   warn      → tell the user
 *   downgrade → switch to a cheaper model for the rest of the run
 *   block     → abort the request before it is sent
 *
 * Design notes:
 *
 * - `session` spend is rebuilt from the session branch on every evaluation, so
 *   it stays correct across forks, reloads, and session switches. `daily` and
 *   `monthly` spend come from the persisted ledger.
 * - Cost is taken from `Usage.cost.total` whenever the provider reports it.
 *   Catalog rates are only a fallback, because they cannot know about discounts,
 *   tiers, or provider-side cache pricing.
 * - Every handler is defensive: a budgeting bug must never take down a session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";

import { applyOverrides, formatConfig, normalizeConfig } from "./config.ts";
import type { ModelRates } from "./ledger.ts";
import {
  capRecords,
  estimateCost,
  prune,
  spendByModel,
  startOfDay,
  startOfMonth,
  spendSince,
} from "./ledger.ts";
import { describeVerdict, evaluateBudgets, formatUsd, isBlocking, pickCheapest } from "./policy.ts";
import {
  configPath,
  ledgerPath,
  loadRecords,
  readJson,
  resolveStateDir,
  saveRecords,
  writeJsonAtomic,
} from "./store.ts";
import type { BudgetConfig, BudgetScope, SpendRecord, TokenUsage, Usd, Verdict } from "./types.ts";

/** Absolute ceiling on ledger size, independent of the retention window. */
const MAX_RECORDS = 20_000;

/** Minimal shape of the entries we read off the session branch. */
interface BranchEntryLike {
  type?: string;
  message?: { role?: string; usage?: Usage };
  usage?: Usage;
}

export default function budgetGuard(pi: ExtensionAPI): void {
  let config: BudgetConfig = normalizeConfig(null);
  let records: SpendRecord[] = [];
  const stateDir = resolveStateDir();
  const configFile = configPath(stateDir);
  const ledgerFile = ledgerPath(stateDir);

  /** Last verdict we told the user about, so warnings do not repeat every turn. */
  let announcedKey = "";
  /** Model id we downgraded away from, so we only switch once per crossing. */
  let downgradedFrom: string | undefined;

  pi.registerFlag("budget-config", {
    type: "string",
    description: "Path to a pi-budget-guard config file (default: <agent dir>/pi-budget-guard/config.json)",
  });
  pi.registerFlag("no-budget", {
    type: "boolean",
    description: "Disable pi-budget-guard enforcement for this run",
  });

  // ---------------------------------------------------------------- utilities

  function warn(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning"): void {
    try {
      if (ctx.hasUI) ctx.ui.notify(message, type);
    } catch {
      // A failed notification must not break the run.
    }
  }

  function toTokenUsage(usage: Usage): TokenUsage {
    return {
      input: numeric(usage.input),
      output: numeric(usage.output),
      cacheRead: numeric(usage.cacheRead),
      cacheWrite: numeric(usage.cacheWrite),
      totalTokens: numeric(usage.totalTokens),
    };
  }

  function numeric(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function ratesFrom(model: Model<any> | undefined): ModelRates | undefined {
    const cost = model?.cost;
    if (!cost) return undefined;
    return {
      input: numeric(cost.input),
      output: numeric(cost.output),
      cacheRead: numeric(cost.cacheRead),
      cacheWrite: numeric(cost.cacheWrite),
      tiers: cost.tiers,
    };
  }

  /**
   * Cost of one usage record.
   *
   * Provider-reported cost wins. Catalog rates are only consulted when the
   * provider reported nothing, and the result is flagged as an estimate.
   */
  function costOfUsage(usage: Usage, rates?: ModelRates): { cost: Usd; estimated: boolean } {
    const reported = usage.cost?.total;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      return { cost: reported, estimated: false };
    }
    if (rates) {
      const cost = estimateCost(toTokenUsage(usage), rates);
      if (cost > 0) return { cost, estimated: true };
    }
    // Neither the provider nor the model catalog gave us a price. Report this as
    // an estimate so callers can tell "genuinely free" apart from "unknown".
    return { cost: 0, estimated: true };
  }

  /**
   * Session spend, rebuilt from the session branch.
   *
   * Reading the branch instead of accumulating in memory means forks, reloads,
   * and `session_start` after a resume all produce the same number.
   */
  function branchSpend(ctx: ExtensionContext): Usd {
    let total = 0;
    try {
      const entries = ctx.sessionManager.getBranch() as unknown as BranchEntryLike[];
      const rates = ratesFrom(ctx.model);

      for (const entry of entries) {
        if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
          total += costOfUsage(entry.message.usage, rates).cost;
        } else if (entry?.type === "usage" && entry.usage) {
          total += costOfUsage(entry.usage, rates).cost;
        }
      }
    } catch {
      return total;
    }
    return total;
  }

  function sessionIdOf(ctx: ExtensionContext): string | undefined {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  }

  /** Current spend for every scope. */
  function currentSpend(ctx: ExtensionContext): Record<BudgetScope, Usd> {
    const now = Date.now();
    return {
      session: branchSpend(ctx),
      daily: spendSince(records, startOfDay(now)),
      monthly: spendSince(records, startOfMonth(now)),
    };
  }

  function evaluate(ctx: ExtensionContext): Verdict {
    if (!config.enabled) return { action: "allow" };
    return evaluateBudgets(currentSpend(ctx), config.limits);
  }

  // ------------------------------------------------------------------ startup

  function loadConfig(): void {
    const overridePath = pi.getFlag("budget-config");
    const path = typeof overridePath === "string" && overridePath.trim() !== "" ? overridePath.trim() : configFile;

    const raw = readJson(path);
    config = raw === null ? normalizeConfig(null) : normalizeConfigSafe(raw);

    if (pi.getFlag("no-budget") === true) config.enabled = false;
  }

  function normalizeConfigSafe(raw: unknown): BudgetConfig {
    try {
      return normalizeConfig(raw);
    } catch {
      return normalizeConfig(null);
    }
  }

  function persistRecords(): void {
    try {
      const now = Date.now();
      records = capRecords(prune(records, config.retentionDays, now), MAX_RECORDS);
      saveRecords(stateDir, records);
    } catch {
      // Persistence is best-effort; enforcement still works in memory.
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const spend = currentSpend(ctx);
      ctx.ui.setStatus(
        "pi-budget-guard",
        `budget ${formatUsd(spend.session)} session · ${formatUsd(spend.daily)} today`,
      );
    } catch {
      // Status is cosmetic.
    }
  }

  /**
   * Warn when the active model has no catalog price.
   *
   * Without this, a model whose price pi does not know about silently makes
   * every budget a no-op — the user keeps a false sense of protection.
   */
  function warnIfUnpriced(ctx: ExtensionContext): void {
    if (!config.enabled || !ctx.hasUI) return;

    const model = ctx.model;
    if (!model) return;

    const rates = ratesFrom(model);
    const priced =
      rates !== undefined &&
      (rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0);
    if (priced) return;

    warn(
      ctx,
      `Budget guard: the model catalog has no pricing for "${model.id}", so spend cannot be measured and budgets will not be enforced. Add a cost to the provider's model definition to enable it.`,
      "warning",
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    loadConfig();
    records = loadRecords(stateDir);

    const now = Date.now();
    const before = records.length;
    records = prune(records, config.retentionDays, now);
    if (records.length !== before) persistRecords();

    announcedKey = "";
    downgradedFrom = undefined;
    updateStatus(ctx);
    warnIfUnpriced(ctx);
  });

  // ------------------------------------------------------------------ accounting

  pi.on("message_end", async (event, ctx) => {
    try {
      const message = event.message as {
        role?: string;
        usage?: Usage;
        provider?: string;
        model?: string;
      };
      if (message?.role !== "assistant" || !message.usage) return;

      const { cost, estimated } = costOfUsage(message.usage, ratesFrom(ctx.model));
      const usage = toTokenUsage(message.usage);
      if (cost <= 0 && usage.totalTokens <= 0) return;

      records.push({
        at: Date.now(),
        sessionId: sessionIdOf(ctx),
        provider: message.provider ?? ctx.model?.provider ?? "unknown",
        model: message.model ?? ctx.model?.id ?? "unknown",
        cost,
        usage,
        estimated,
      });

      updateStatus(ctx);
    } catch {
      // Never let accounting break a turn.
    }
  });

  // ------------------------------------------------------------------- enforcing

  /**
   * The precise interception point: fires before every provider request, which
   * includes every follow-up turn inside a single agent run.
   */
  pi.on("before_provider_request", async (_event, ctx) => {
    try {
      const verdict = evaluate(ctx);
      announce(ctx, verdict);
      if (!config.block.enabled) return;
      if (!isBlocking(verdict)) return;
      ctx.abort();
    } catch {
      // Fail open: a broken guard should not wedge the session.
    }
  });

  /** Earlier hook, so a downgrade takes effect for the whole run. */
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const verdict = evaluate(ctx);
      announce(ctx, verdict);
      if (verdict.action === "downgrade" || verdict.action === "block") {
        await maybeDowngrade(ctx);
      }
    } catch {
      // Ignore.
    }
  });

  /** Tell the user once per distinct verdict, and reset once spend is fine again. */
  function announce(ctx: ExtensionContext, verdict: Verdict): void {
    if (verdict.action === "allow") {
      announcedKey = "";
      return;
    }

    const key = `${verdict.action}:${verdict.scope}`;
    if (key === announcedKey) return;
    announcedKey = key;

    const policy = config.notify;
    if (verdict.action === "warn" && !policy.onWarn) return;
    if (verdict.action === "downgrade" && !policy.onDowngrade) return;
    if (verdict.action === "block" && !policy.onBlock) return;

    warn(ctx, describeVerdict(verdict), verdict.action === "block" ? "error" : "warning");
  }

  /** Models we are allowed to fall back to, cheapest first. */
  function downgradeCandidates(ctx: ExtensionContext): Model<any>[] {
    let pool: Model<any>[] = [];
    try {
      pool = ctx.modelRegistry.getAvailable();
    } catch {
      pool = [];
    }
    if (pool.length === 0) {
      pool = ctx.scopedModels.map((scoped) => scoped.model);
    }

    const preferred = config.downgrade.preferProviders;
    if (preferred.length > 0) {
      const filtered = pool.filter((model) => preferred.includes(model.provider));
      if (filtered.length > 0) return filtered;
    }
    return pool;
  }

  async function maybeDowngrade(ctx: ExtensionContext): Promise<void> {
    if (!config.downgrade.enabled) return;

    const current = ctx.model;
    if (!current) return;
    if (downgradedFrom === current.id) return;

    const candidates = downgradeCandidates(ctx);
    const explicit = config.downgrade.model;
    const target = explicit
      ? candidates.find((m) => m.id === explicit || `${m.provider}/${m.id}` === explicit) ?? null
      : pickCheapest(candidates, current.id);

    if (!target || target.id === current.id) return;

    const switched = await pi.setModel(target);
    if (!switched) {
      warn(ctx, `Budget: could not switch to ${target.id} (no credentials configured)`, "warning");
      return;
    }

    downgradedFrom = current.id;
    announcedKey = `downgrade:model:${target.id}`;
    warn(
      ctx,
      `Budget exceeded — switched from ${current.id} to ${target.id} (${formatUsd(
        (target.cost?.input ?? 0) + (target.cost?.output ?? 0),
      )}/Mtok vs ${formatUsd((current.cost?.input ?? 0) + (current.cost?.output ?? 0))}/Mtok)`,
      "warning",
    );
  }

  // ------------------------------------------------------------------ lifecycle

  pi.on("session_shutdown", async () => {
    persistRecords();
  });

  // -------------------------------------------------------------------- command

  pi.registerCommand("budget", {
    description: "Show or change budget limits: /budget [show|set <key>=<value>|reset|on|off]",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const say = (text: string): void => {
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      };

      switch (subcommand) {
        case undefined:
        case "show":
        case "status": {
          const spend = currentSpend(ctx);
          const verdict = evaluate(ctx);
          const lines = [
            `session ${formatUsd(spend.session)}   daily ${formatUsd(spend.daily)}   monthly ${formatUsd(spend.monthly)}`,
            describeVerdict(verdict),
            "",
            formatConfig(config),
            "",
            `config: ${configFile}`,
            `ledger: ${ledgerFile} (${records.length} records)`,
          ];
          say(lines.join("\n"));
          return;
        }

        case "set": {
          const overrides = rest.join(" ").trim();
          if (overrides === "") {
            say("Usage: /budget set daily.block=20");
            return;
          }
          const { config: next, unknown } = applyOverrides(config, [overrides]);
          if (unknown.length > 0) {
            say(`Unknown key: ${unknown.join(", ")}\nTry: enabled | downgrade.model | <scope>.<warn|downgrade|block>`);
            return;
          }
          config = next;
          try {
            writeJsonAtomic(configFile, config);
          } catch (error) {
            say(`Applied for this session, but could not write ${configFile}: ${String(error)}`);
            return;
          }
          say(`Updated.\n${formatConfig(config)}`);
          return;
        }

        case "reset": {
          records = [];
          persistRecords();
          announcedKey = "";
          updateStatus(ctx);
          say("Ledger cleared. Session spend is rebuilt from the branch and may be non-zero.");
          return;
        }

        case "on":
        case "off": {
          config.enabled = subcommand === "on";
          try {
            writeJsonAtomic(configFile, config);
          } catch {
            // Session-only change is still useful.
          }
          announcedKey = "";
          say(`Budget enforcement ${config.enabled ? "enabled" : "disabled"}.`);
          return;
        }

        case "models": {
          const byModel = spendByModel(records);
          if (byModel.length === 0) {
            say("No spend recorded yet.");
            return;
          }
          say(byModel.map((row) => `${formatUsd(row.cost).padStart(10)}  ${row.model}`).join("\n"));
          return;
        }

        default:
          say(`Unknown subcommand: ${subcommand}\nTry: show | set | reset | on | off | models`);
      }
    },
  });
}
