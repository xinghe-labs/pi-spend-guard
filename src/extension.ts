/**
 * pi-spend-guard — hard budget enforcement for pi.
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
import {
  describeVerdict,
  evaluateBudgets,
  formatUsd,
  isBlocking,
  pickCheapest,
  projectSpend,
} from "./policy.ts";
import { resolveRates } from "./pricing.ts";
import {
  appendRecords,
  configPath,
  ledgerPath,
  loadRecords,
  mergeRecords,
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
  message?: { role?: string; usage?: Usage; provider?: string; model?: string };
  usage?: Usage;
  // branch_summary / compaction entries also carry usage; pi's own totals
  // book them under "Tools/summaries", so the guard counts them too.
  usageKind?: string;
}

/**
 * A downgrade option.
 *
 * Carries the resolved price rather than relying on `model.cost`, because the
 * catalog price is often absent while the user's pricing table is not.
 */
interface DowngradeCandidate {
  model: Model<any>;
  id: string;
  cost?: { input: number; output: number };
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
    description: "Path to a pi-spend-guard config file (default: <agent dir>/pi-spend-guard/config.json)",
  });
  pi.registerFlag("no-budget", {
    type: "boolean",
    description: "Disable pi-spend-guard enforcement for this run",
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

  /**
   * Rates for a model, from the user's pricing table or the pi model catalog.
   *
   * Going through `resolveRates` instead of reading `model.cost` directly is
   * what makes the guard work on setups where the catalog carries no price —
   * local gateways, self-hosted proxies, and unlisted models.
   */
  function ratesFor(model: Model<any> | undefined): ModelRates | undefined {
    return resolveRates(model, config.pricing).rates;
  }

  /**
   * Cost of one usage record.
   *
   * Provider-reported cost wins. The pricing table and catalog are only
   * consulted when the provider reported nothing, and the result is flagged as
   * an estimate.
   */
  function costOfUsage(
    usage: Usage,
    rates?: ModelRates,
  ): { cost: Usd; estimated: boolean; unpriced: boolean } {
    const reported = usage.cost?.total;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      return { cost: reported, estimated: false, unpriced: false };
    }
    if (rates) {
      // A reported $0 does NOT win here. Real providers report $0 for calls
      // they do bill (verified: a reseller gateway reports cost.total = 0 for
      // every request) — trusting it would record every call as free and
      // defeat the guard. When rates exist they are the better estimate; the
      // record stays flagged estimated so the difference is visible.
      const cost = estimateCost(toTokenUsage(usage), rates);
      // A zero here means the rates genuinely produced nothing (for example a
      // cache-only call), not that the price is unknown.
      return { cost, estimated: true, unpriced: false };
    }
    // No usable rate from anywhere. reported === 0 without rates is recorded
    // as unpriced: with no way to cross-check, a zero is indistinguishable
    // from "the price is unknown", and counting it as measured-free is the
    // same conflation of unknown vs free the unpriced flag exists to prevent.
    // No provider cost and no rate from anywhere: the price is unknown, which
    // is a different thing from the call being free.
    return { cost: 0, estimated: true, unpriced: true };
  }

  /**
   * Session spend, rebuilt from the session branch.
   *
   * Reading the branch instead of accumulating in memory means forks, reloads,
   * and `session_start` after a resume all produce the same number.
   */
  /**
   * Look up a full model definition (with its cost block) by provider/id.
   *
   * Branch entries carry only the names of the model that served them; the
   * registry holds the actual definitions the rate lookup needs.
   */
  function modelInRegistry(
    registry: { getAvailable: () => Model<any>[] } | undefined,
    provider: string,
    id: string,
  ): Model<any> | undefined {
    try {
      return registry?.getAvailable().find((m) => m.provider === provider && m.id === id);
    } catch {
      return undefined;
    }
  }

  function branchSpend(ctx: ExtensionContext): Usd {
    let total = 0;
    try {
      const entries = ctx.sessionManager.getBranch() as unknown as BranchEntryLike[];

      for (const entry of entries) {
        // Price each entry with the rates of the model that actually served it,
        // not the current model: after an auto-downgrade, re-pricing earlier
        // expensive-model turns at the cheap model's rates understates session
        // spend — in the direction that delays enforcement. Branch entries
        // carry only provider/model names, so resolve the full definition
        // (with its cost block) from the registry; entries without that
        // information fall back to the current model.
        const served = entry.message?.provider && entry.message?.model
          ? modelInRegistry(ctx.modelRegistry, entry.message.provider, entry.message.model)
          : undefined;
        const rates = ratesFor(served ?? ctx.model);

        if (entry?.type === "message" && entry.message && entry.message.usage) {
          // Assistant messages and toolResult messages (usage from the tool's
          // own model calls — pi books them under "Tools/summaries") both
          // carry real spend; branchSpend must match what gets recorded.
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

  /** Refresh shared state, then evaluate every scope. */
  function evaluate(ctx: ExtensionContext): Verdict {
    if (!config.enabled) return { action: "allow" };
    refreshSharedLedger();
    return evaluateBudgets(currentSpend(ctx), config.limits);
  }

  /**
   * Most recent assistant usage in the branch, walked newest-first.
   *
   * Used to make the projection reflect this session's reality instead of
   * worst-case assumptions: the observed input/cacheRead split says how much
   * of the context is served from cache, and trailing outputs say how large
   * replies actually are.
   */
  function latestAssistantUsages(ctx: ExtensionContext, count: number): Usage[] {
    const out: Usage[] = [];
    try {
      const entries = ctx.sessionManager.getBranch() as unknown as BranchEntryLike[];
      for (let i = entries.length - 1; i >= 0 && out.length < count; i--) {
        const entry = entries[i];
        if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
          out.push(entry.message.usage);
        }
      }
    } catch {
      return out;
    }
    return out;
  }

  /**
   * Estimated cost of the request that is about to be sent.
   *
   * The projection is cache-aware and output-adaptive, because a naive one is
   * wrong in both directions:
   *
   * - Long sessions are dominated by cache reads priced far below uncached
   *   input (often 10×). Projecting the whole context at the input rate
   *   over-blocks precisely the sessions that run longest. The cached fraction
   *   comes from the most recent assistant usage — what the provider actually
   *   served from cache last turn.
   * - A fixed output reservation either blocks sessions that write short
   *   replies or under-blocks ones that write long ones. The trailing average
   *   of actual outputs tracks the session; the configured `outputTokens` is
   *   only the fallback before any output has been observed.
   *
   * `getContextUsage().tokens` is pi's own estimate of the prompt going out.
   * Every input missing degrades to 0 — the guard falls back to money already
   * spent rather than inventing a number.
   */
  function estimateUpcoming(ctx: ExtensionContext): Usd {
    if (!config.estimate.enabled) return 0;

    const rates = ratesFor(ctx.model);
    if (!rates) return 0;

    let contextTokens: number | null;
    try {
      contextTokens = ctx.getContextUsage()?.tokens ?? null;
    } catch {
      return 0;
    }
    if (contextTokens === null || !Number.isFinite(contextTokens) || contextTokens <= 0) return 0;

    // Defaults: all-uncached input, configured output reservation.
    let input = contextTokens;
    let cacheRead = 0;
    let output = config.estimate.outputTokens;

    const recent = latestAssistantUsages(ctx, 5);
    const newest = recent[0];
    if (newest) {
      // Cached fraction of the context, from what the provider actually did.
      const cached = Math.max(0, newest.cacheRead ?? 0);
      const uncached = Math.max(0, newest.input ?? 0);
      if (cached + uncached > 0) {
        cacheRead = Math.min(contextTokens, contextTokens * (cached / (cached + uncached)));
        input = contextTokens - cacheRead;
      }
    }

    // Trailing average of real outputs, ignoring non-finite noise.
    const outputs = recent.map((u) => u.output).filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
    if (outputs.length > 0) {
      output = Math.round(outputs.reduce((a, b) => a + b, 0) / outputs.length);
    }

    return estimateCost(
      {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: Math.round(input + cacheRead + output),
      },
      rates,
    );
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

  /**
   * Persist the ledger without erasing concurrent sessions' records.
   *
   * Delegates to `appendRecords`, which merges under the ledger lock and
   * applies retention + the record cap to the MERGED result — applying them
   * here instead would let the merge resurrect exactly what was pruned, since
   * the on-disk file still contains it, and the file would grow without
   * bound. Persistence is best-effort; enforcement still works in memory.
   */
  function persistRecords(): void {
    try {
      records = appendRecords(stateDir, records, [], {
        retentionDays: config.retentionDays,
        maxRecords: MAX_RECORDS,
      });
    } catch {
      // Persistence is best-effort; enforcement still works in memory.
    }
  }

  /**
   * Pull in what concurrent sessions recorded since our last read.
   *
   * Called before every enforcement decision so daily/monthly budgets see the
   * whole machine's spend, not just this session's stale snapshot — without
   * this, parallel sessions can each spend the same budget.
   */
  function refreshSharedLedger(): void {
    try {
      records = mergeRecords(records, loadRecords(stateDir));
    } catch {
      // Keep the in-memory view; a lost refresh is better than a broken turn.
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      refreshSharedLedger();
      const spend = currentSpend(ctx);
      ctx.ui.setStatus(
        "pi-spend-guard",
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
    if (resolveRates(model, config.pricing).rates) return;

    const key = `${model.provider}/${model.id}`;
    warn(
      ctx,
      `Budget guard: no price is known for "${key}", so spend cannot be measured and budgets will not be enforced. ` +
        `Add a "pricing" entry to ${configFile}, e.g. "${key}": { "input": 0.27, "output": 1.1 }, or add a cost to the model definition.`,
      "warning",
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    loadConfig();
    records = loadRecords(stateDir);

    // Retention + cap are applied inside persistRecords/appendRecords on the
    // MERGED file, so a persist here both prunes expired records on disk and
    // cannot resurrect them from another session's snapshot.
    persistRecords();

    announcedKey = "";
    downgradedFrom = undefined;
    updateStatus(ctx);
    warnIfUnpriced(ctx);
  });

  // ------------------------------------------------------------------ accounting

  /**
   * Record usage from any message that carries it.
   *
   * Assistant messages are the main path, but toolResult messages also carry
   * `usage` — the model calls the tool itself made (pi's own totals book them
   * under "Tools/summaries"), and so do compaction/branch summaries. Ignoring
   * them undercounts spend against pi's own accounting, so all of them are
   * recorded. Model attribution falls back to the active model when the
   * message does not name one (tool results usually do not).
   */
  function recordMessageUsage(
    message: { role?: string; usage?: Usage; provider?: string; model?: string },
    ctx: ExtensionContext,
  ): void {
    if (!message?.usage) return;
    const role = message.role;
    if (role !== "assistant" && role !== "toolResult") return;

    const { cost, estimated, unpriced } = costOfUsage(message.usage, ratesFor(ctx.model));
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
      unpriced,
    });

    // Persist now, not at shutdown: a crash mid-session must not erase the
    // spend it just made, and concurrent sessions read each other's records.
    persistRecords();

    updateStatus(ctx);
  }

  pi.on("message_end", async (event, ctx) => {
    try {
      recordMessageUsage(
        event.message as { role?: string; usage?: Usage; provider?: string; model?: string },
        ctx,
      );
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
      // Honour the global switch before doing any work. `evaluate()` used to
      // carry this check; now that the projection is computed here, the guard
      // has to make it explicitly or `--no-budget` would still abort.
      if (!config.enabled) {
        announcedKey = "";
        return;
      }

      // Refresh before deciding: without this, daily/monthly totals are blind
      // to what a concurrent session recorded since our last message_end —
      // exactly the gap parallel sessions would exploit to share one budget.
      refreshSharedLedger();

      const spend = currentSpend(ctx);
      const verdict = evaluateBudgets(spend, config.limits);
      announce(ctx, verdict);

      // Spend so far only describes the past. The request being sent right now
      // has not been recorded yet, so without projecting it the final call
      // before a limit can overshoot by its own full cost.
      const upcoming = estimateUpcoming(ctx);
      const projected =
        upcoming > 0 ? evaluateBudgets(projectSpend(spend, upcoming), config.limits) : verdict;

      if (!config.block.enabled) return;
      if (!isBlocking(projected)) return;

      if (verdict.action !== "block") {
        // Stopped by the projection rather than by money already spent. The
        // generic "exhausted" wording would be untrue here.
        warn(ctx, describeVerdict({ ...projected, projected: upcoming }), "error");
      }
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

  /** Models we are allowed to fall back to, each with the price the guard can charge for it. */
  function downgradeCandidates(ctx: ExtensionContext): DowngradeCandidate[] {
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
      if (filtered.length > 0) pool = filtered;
    }

    return pool.map((model) => {
      // Use the rates the guard would actually charge, so a user-supplied table
      // also drives downgrade targeting. Reading `model.cost` directly would
      // leave every candidate unpriceable on a catalog-less setup.
      const rates = ratesFor(model);
      return {
        model,
        id: model.id,
        ...(rates ? { cost: { input: rates.input, output: rates.output } } : {}),
      };
    });
  }

  async function maybeDowngrade(ctx: ExtensionContext): Promise<void> {
    if (!config.downgrade.enabled) return;

    const current = ctx.model;
    if (!current) return;
    // Latch: once this session has downgraded, never switch again. Without
    // the latch the guard can oscillate — pickCheapest excludes only the
    // CURRENT model, so the next run-start while still over budget can pick a
    // third model, then back, flipping models every run. The first switch is
    // the intended behaviour; the block threshold still applies behind it.
    if (downgradedFrom !== undefined) return;
    if (downgradedFrom === current.id) return;

    const candidates = downgradeCandidates(ctx);
    const explicit = config.downgrade.model;
    const target = explicit
      ? candidates.find((c) => c.id === explicit || `${c.model.provider}/${c.id}` === explicit)?.model ?? null
      : pickCheapest(candidates, current.id)?.model ?? null;

    if (!target || target.id === current.id) return;

    const switched = await pi.setModel(target);
    if (!switched) {
      warn(ctx, `Budget: could not switch to ${target.id} (no credentials configured)`, "warning");
      return;
    }

    downgradedFrom = current.id;

    const priceOf = (model: Model<any>): string => {
      const rates = ratesFor(model);
      return rates ? `${formatUsd(rates.input + rates.output)}/Mtok` : "unpriced";
    };
    warn(
      ctx,
      `Budget exceeded — switched from ${current.id} to ${target.id} (${priceOf(target)} vs ${priceOf(current)})`,
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
          const resolved = resolveRates(ctx.model, config.pricing);
          const pricing = resolved.rates
            ? `${resolved.source === "config" ? "config table" : "model catalog"} — in $${resolved.rates.input}/Mtok, out $${resolved.rates.output}/Mtok`
            : "NONE — spend cannot be measured, budgets will not be enforced";
          const unpriced = records.filter((record) => record.unpriced).length;
          const lines = [
            `session ${formatUsd(spend.session)}   daily ${formatUsd(spend.daily)}   monthly ${formatUsd(spend.monthly)}`,
            describeVerdict(verdict),
            `pricing: ${pricing}`,
            ...(unpriced > 0
              ? [`unpriced calls on record: ${unpriced} (counted as $0 — their real cost is unknown)`]
              : []),
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
            say(
              `Unknown key: ${unknown.join(", ")}\n` +
                `Try: enabled | downgrade.model | estimate.enabled | <scope>.<warn|downgrade|block>\n` +
                `Note: the pricing table is edited in the config file, not here.`,
            );
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
          // Deliberately overwrite instead of merging: the user asked to erase
          // the ledger, so concurrent records are intentionally discarded too.
          records = [];
          saveRecords(stateDir, records);
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
