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
import { catalogRates, entryToRates, matchPricing, resolveRates } from "./pricing.ts";
import type { ResolvedRates } from "./pricing.ts";
import {
  deserializeSnapshot,
  lookupAlias,
  lookupRemoteRates,
  lookupRemoteRatesWithKey,
  parseRatesSnapshot,
  remoteToRates,
  serializeSnapshot,
  snapshotIsStale,
  splitAliasTarget,
} from "./rates.ts";
import type { RatesSnapshot } from "./rates.ts";
import {
  appendRecords,
  configPath,
  ledgerPath,
  loadRecords,
  mergeRecords,
  ratesPath,
  readJson,
  withLedgerLock,
  withRatesLock,
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
  message?: { role?: string; usage?: Usage; provider?: string; model?: string; responseModel?: string };
  usage?: Usage;
  // compaction / branch_summary entries also carry usage (the LLM call that
  // generated the summary); pi's own totals book them under Tools/summaries.
  provider?: string;
  model?: string;
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
  /** Cached published price list (models.dev). Loaded from disk, refreshed in the background. */
  let remoteRates: RatesSnapshot | undefined;
  /** The refresh in flight, if any, so a cold-cache call can wait for it. */
  let ratesRefresh: Promise<void> | undefined;
  /** When the status line last re-read the ledger, to avoid doing it per message. */
  let lastStatusRefresh = 0;

  pi.registerFlag("budget-config", {
    type: "string",
    description: "Path to a pi-spend-guard config file (default: <agent dir>/pi-spend-guard/config.json)",
  });
  pi.registerFlag("no-budget", {
    type: "boolean",
    description: "Disable pi-spend-guard enforcement for this run",
  });
  pi.registerFlag("no-rates", {
    type: "boolean",
    description: "Skip the automatic price-list lookup for this run (the guard stays fully offline)",
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
   * Rates for a model, from the user's pricing table, the pi model catalog, or
   * the cached published price list.
   *
   * Going through `resolveRates` instead of reading `model.cost` directly is
   * what makes the guard work on setups where the catalog carries no price —
   * local gateways, self-hosted proxies, and unlisted models.
   */
  function ratesFor(model: Model<any> | undefined): ModelRates | undefined {
    return resolvedFor(model).rates;
  }

  /** Rates for a model plus which source they came from, for provenance. */
  function resolvedFor(model: Model<any> | undefined): ResolvedRates {
    return resolveRates(model, config.pricing, remoteRatesFor);
  }

  /** Look up a model in the cached published price list, if one is loaded. */
  function remoteRatesFor(provider: string | undefined, modelId: string | undefined): ModelRates | undefined {
    // Checked per lookup, not only when loading: `/budget set
    // rates.remote.enabled=false` must take effect immediately, and the docs
    // promise that disabling makes the guard fully offline.
    if (!config.rates.remote.enabled) return undefined;

    // A gateway that renames a model cannot be matched by id. The alias map is
    // how that is fixed without hand-copying rates.
    const alias = lookupAlias(config.rates.aliases, provider, modelId);
    if (alias) {
      const target = splitAliasTarget(alias);
      const pinned = lookupRemoteRates(remoteRates, target.provider ?? provider, target.modelId);
      if (pinned) return remoteToRates(pinned);
      // A bare target whose published id itself contains a slash is
      // indistinguishable from a provider pin, so retry it as the whole id
      // before giving up.
      if (target.provider) {
        const whole = lookupRemoteRates(remoteRates, provider, alias);
        if (whole) return remoteToRates(whole);
      }
    }

    const rate = lookupRemoteRates(remoteRates, provider, modelId);
    return rate ? remoteToRates(rate) : undefined;
  }

  /**
   * Read the cached price list from disk. Synchronous and offline: the
   * enforcement path must never wait on the network.
   *
   * A snapshot fetched from a different URL is discarded. The cache is one file
   * per state directory, but the URL is per config, so without this check a
   * changed (or a second `--budget-config`) URL would keep pricing from the old
   * list while `/budget` reported the new one.
   */
  function loadCachedRates(): void {
    if (!config.rates.remote.enabled) return;
    try {
      const snapshot = deserializeSnapshot(readJson(ratesPath(stateDir)));
      if (!snapshot) return;
      if (snapshot.source !== config.rates.remote.url) return;
      remoteRates = snapshot;
    } catch {
      // A missing or corrupt cache simply means the remote source is absent.
    }
  }

  /**
   * How long accounting may wait for an in-flight price list.
   *
   * `message_end` is awaited by the agent loop, so this is a real (if brief)
   * stall, not invisible work — the docs say so. Short enough that an
   * unreachable list costs a moment, long enough for the usual fetch.
   */
  const RATES_ACCOUNTING_WAIT_MS = 1_500;

  /** Bytes of price list we are willing to read. A fast, huge response would
   * otherwise be buffered in full — the timeout alone does not bound size. */
  const MAX_RATES_BYTES = 32 * 1024 * 1024;

  /**
   * Refresh the price list in the background when the cache is stale.
   *
   * Deliberately not awaited by the caller: a slow or unreachable price list
   * must not delay a session or a provider request. When the fetch lands, the
   * in-memory snapshot is swapped in, so the running session picks it up
   * without a restart. Failures are silent by design — the guard keeps working
   * from the offline sources.
   *
   * The config is re-checked after the await: a `/budget set` that disabled the
   * feature or repointed the URL while the fetch was in flight must win, and an
   * in-flight response must not be cached under the wrong source.
   */
  async function refreshRatesInBackground(): Promise<void> {
    if (!config.rates.remote.enabled) return;
    const { url, ttlHours, timeoutMs } = config.rates.remote;
    // A snapshot from a different URL is not a usable cache for this one.
    const cached = remoteRates?.source === url ? remoteRates : undefined;
    if (!snapshotIsStale(cached, ttlHours * 3_600_000, Date.now())) return;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;

      // Refuse a response that redirects to a different origin: the configured
      // URL is the only host this code is willing to trust for prices.
      if (!sameOrigin(response.url, url)) return;

      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_RATES_BYTES) return;
      const body = await response.text();
      if (body.length > MAX_RATES_BYTES) return;

      // Re-check after the await: the user may have disabled the feature or
      // changed the URL while this request was in flight.
      if (!config.rates.remote.enabled || config.rates.remote.url !== url) return;

      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        return;
      }
      const snapshot = parseRatesSnapshot(raw, url, Date.now());
      if (snapshot.byProviderModel.size === 0) return;

      // Never let an older fetch overwrite a newer snapshot. Two sessions can
      // refresh concurrently, so re-read the cache under the lock and keep
      // whichever snapshot is newer — the file is the shared state, not this
      // process's memory.
      remoteRates = snapshot;
      withRatesLock(stateDir, () => {
        const onDisk = deserializeSnapshot(readJson(ratesPath(stateDir)));
        // Same URL only: a newer file from a different source (a second
        // `--budget-config`, or another tool) must not be adopted here — that
        // is the same wrong-list bug `loadCachedRates` already guards against.
        if (onDisk && onDisk.source === url && onDisk.fetchedAt > snapshot.fetchedAt) {
          remoteRates = onDisk;
          return;
        }
        writeJsonAtomic(ratesPath(stateDir), serializeSnapshot(snapshot));
      });
    } catch {
      // Offline, timed out, or a changed payload: keep the previous snapshot.
    }
  }

  /** Resolve after `ms`. Used to bound the wait for a cold-cache price list. */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** True when two URLs share scheme, host and port. */
  function sameOrigin(a: string, b: string): boolean {
    try {
      const left = new URL(a);
      const right = new URL(b);
      return left.protocol === right.protocol && left.host === right.host;
    } catch {
      return false;
    }
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
        // Attribute the entry to the model that actually served it, not the
        // current model: after an auto-downgrade, re-pricing earlier
        // expensive-model turns at the cheap model's rates understates session
        // spend — in the direction that delays enforcement. Message entries
        // name the model on the message; usage/compaction/branch_summary
        // entries name it on the entry itself. pi attributes assistant
        // messages via responseModel ?? model; fall back to the current model
        // only when no name survives anywhere.
        const msgProvider = entry.message?.provider;
        const msgModel = entry.message?.responseModel ?? entry.message?.model;
        const named = msgProvider && msgModel
          ? { provider: msgProvider, id: msgModel }
          : entry.provider && entry.model
            ? { provider: entry.provider, id: entry.model }
            : undefined;
        const served = named ? modelInRegistry(ctx.modelRegistry, named.provider, named.id) : undefined;
        const rates = ratesFor(served ?? ctx.model);

        // Assistant messages, toolResult messages (usage from the tool's own
        // model calls), and compaction/branch_summary entries all carry real
        // spend; pi's own totals book all of them, so branchSpend must too.
        if (entry?.type === "message" && entry.message && entry.message.usage) {
          total += costOfUsage(entry.message.usage, rates).cost;
        } else if (entry?.usage) {
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
    if (pi.getFlag("no-rates") === true) config.rates.remote.enabled = false;
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
    try {
      // Inside the try for the same reason as warnIfUnpriced: a stale ctx
      // throws rather than returning a value.
      if (!ctx.hasUI) return;
      // The status line is cosmetic, and this runs on every awaited message.
      // Re-reading the whole ledger each time is pure overhead, so refresh at
      // most once a second; enforcement has its own unthrottled refresh.
      const now = Date.now();
      if (now - lastStatusRefresh > 1_000) {
        lastStatusRefresh = now;
        refreshSharedLedger();
      }
      const spend = currentSpend(ctx);
      // Say so when the active model cannot be priced. Otherwise the status
      // bar shows a healthy spend while enforcement is structurally inert, and
      // a user who missed the one session-start warning never finds out.
      // Only meaningful while the guard is enforcing: with enforcement off the
      // badge would warn about a problem the user has already opted out of.
      const unpriced = config.enabled && !resolvedFor(ctx.model).rates;
      ctx.ui.setStatus(
        "pi-spend-guard",
        `budget ${formatUsd(spend.session)} session · ${formatUsd(spend.daily)} today${unpriced ? " · UNPRICED" : ""}`,
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
    // Everything is inside the try: pi asserts that a ctx is still active and
    // THROWS on a stale one (after session replacement, or once a `-p` run has
    // finished). This is also called from a deferred callback, so an unguarded
    // `ctx.hasUI` here crashed the process at exit.
    try {
      if (!config.enabled || !ctx.hasUI) return;

      const model = ctx.model;
      if (!model) return;
      if (resolveRates(model, config.pricing, remoteRatesFor).rates) return;

      const key = `${model.provider}/${model.id}`;
      // Say what actually happened rather than guessing. "The list has no entry"
      // is only true once a list was actually consulted, and it is wrong for the
      // one case where an entry exists but the guard refuses to pick it
      // (published by several non-first-party providers); offline or a failed
      // fetch is a different situation with a different fix.
      const remoteNote = !config.rates.remote.enabled
        ? ` Automatic rate lookup is off ("rates.remote.enabled": false).`
        : remoteRates
          ? ` The published list (${remoteRates.source}) has no usable entry for it (absent, or published by several providers so any pick would be a guess).`
          : ` No published price list is available (offline, still fetching, or the fetch failed).`;
      warn(
        ctx,
        `Budget guard: no price is known for "${key}", so spend cannot be measured and budgets will not be enforced.` +
          remoteNote +
          ` Add a "pricing" entry to ${configFile}, e.g. "${key}": { "input": 0.27, "output": 1.1 }, or add a cost to the model definition.`,
        "warning",
      );
    } catch {
      // A stale ctx must never take the process down.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    loadConfig();
    records = loadRecords(stateDir);

    // Use whatever snapshot is cached first: reading it is synchronous and
    // offline, so the enforcement path never waits on the network.
    loadCachedRates();

    // Only fetch when the offline sources cannot price the active model. An
    // unconditional fetch would contact a third party on every install even
    // when the catalog already covers everything — a privacy cost with no
    // benefit.
    const pricedOffline = Boolean(resolveRates(ctx.model, config.pricing).rates);
    const pricedFromCache = Boolean(remoteRatesFor(ctx.model?.provider, ctx.model?.id));
    const needsRates = !pricedOffline && !pricedFromCache;

    // Retention + cap are applied inside persistRecords/appendRecords on the
    // MERGED file, so a persist here both prunes expired records on disk and
    // cannot resurrect them from another session's snapshot.
    persistRecords();

    announcedKey = "";
    downgradedFrom = undefined;
    updateStatus(ctx);

    if (!needsRates) {
      // Tracked even here: a later model switch in this session may need the
      // pending snapshot, and an untracked promise would leave that call
      // permanently unpriced.
      ratesRefresh = refreshRatesInBackground();
      warnIfUnpriced(ctx);
      return;
    }

    // The model is unpriced right now, but a refresh may be about to supply it.
    // Nothing waits here: the session must open immediately. The wait that
    // matters happens at accounting time, where the provider response has
    // already been streamed and the delay is invisible to the user.
    const pending = refreshRatesInBackground();
    ratesRefresh = pending;

    void pending.then(() => {
      // The session may already be gone by the time the fetch settles (a short
      // `-p` run finishes in seconds). Both helpers are stale-ctx safe, and the
      // extra guard keeps a surprise in either one from surfacing as an
      // unhandled rejection.
      try {
        warnIfUnpriced(ctx);
        updateStatus(ctx);
      } catch {
        // Nothing to report to: the session has ended.
      }
    });
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
  async function recordMessageUsage(
    message: { role?: string; usage?: Usage; provider?: string; model?: string; responseModel?: string },
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!message?.usage) return;
    const role = message.role;
    if (role !== "assistant" && role !== "toolResult") return;

    // The price may not be known yet purely because the list is still
    // downloading. Recording the call as unpriced then is both wrong and
    // permanent, so wait for an in-flight refresh first — only when nothing
    // else can price the model, and bounded by the fetch's own timeout. The
    // provider response has already been streamed by now, so this delay is not
    // visible to the user.
    if (!resolvedFor(ctx.model).rates && ratesRefresh) {
      // Bounded on purpose: pi awaits this handler before the run continues, so
      // an unreachable list would otherwise stall the turn for the whole fetch
      // timeout. The common case (a fast fetch) still lands inside the bound.
      try {
        await Promise.race([ratesRefresh, delay(RATES_ACCOUNTING_WAIT_MS)]);
      } catch {
        // The refresh never rejects, but a guard must not depend on that.
      }
    }

    // Attribute the call to the model that actually served it, exactly as
    // `branchSpend` does. pi reports `responseModel` when the provider resolved
    // the request to a different concrete model (routed or abstract ids), so
    // pricing with the active model can value the same call two different ways
    // in the session scope and the ledger scope.
    const servedProvider = message.provider ?? ctx.model?.provider;
    const servedId = message.responseModel ?? message.model ?? ctx.model?.id;
    const served =
      servedProvider && servedId ? modelInRegistry(ctx.modelRegistry, servedProvider, servedId) : undefined;

    const resolved = resolvedFor(served ?? ctx.model);
    const { cost, estimated, unpriced } = costOfUsage(message.usage, resolved.rates);
    const usage = toTokenUsage(message.usage);
    if (cost <= 0 && usage.totalTokens <= 0) return;

    records.push({
      at: Date.now(),
      sessionId: sessionIdOf(ctx),
      provider: servedProvider ?? "unknown",
      model: servedId ?? "unknown",
      cost,
      usage,
      estimated,
      unpriced,
      // Provenance for an estimated cost: which source priced it, and which key
      // it matched (a `*` catch-all is a different statement from an exact
      // entry). Absent when the provider reported the cost itself.
      ...(estimated && resolved.source !== "none" ? { rateSource: resolved.source } : {}),
      ...(estimated && resolved.source === "models.dev"
        ? (() => {
            const alias = lookupAlias(config.rates.aliases, servedProvider, servedId);
            const target = alias ? splitAliasTarget(alias) : undefined;
            const hit = lookupRemoteRatesWithKey(remoteRates, target?.provider ?? servedProvider, target?.modelId ?? servedId);
            return hit ? { rateKey: hit.key } : {};
          })()
        : estimated && resolved.key
          ? { rateKey: resolved.key }
          : {}),
      ...(estimated && resolved.source === "models.dev" && remoteRates
        ? { ratesFetchedAt: remoteRates.fetchedAt }
        : {}),
    });

    // Persist now, not at shutdown: a crash mid-session must not erase the
    // spend it just made, and concurrent sessions read each other's records.
    persistRecords();

    updateStatus(ctx);
  }

  pi.on("message_end", async (event, ctx) => {
    try {
      await recordMessageUsage(
        event.message as { role?: string; usage?: Usage; provider?: string; model?: string; responseModel?: string },
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

  /**
   * Every tier's answer for a model, in precedence order.
   *
   * The precedence chain decides what a call costs, and until now it was only
   * visible for the active model and only as a single label. Auditing a
   * surprising number meant reading the source. This prints the whole chain.
   */
  function explainModel(model: Model<any> | undefined): string[] {
    if (!model) return ["No active model."];
    const lines = [
      `explain: ${model.provider}/${model.id}`,
      "  provider-reported  — per call, always wins when the provider sends a cost",
    ];

    // The key is reported, not just the entry: `provider/model`, `provider/*`
    // and `*` are very different statements about this model.
    const matched = matchPricing(config.pricing, model.provider, model.id, { includeWildcard: true });
    lines.push(
      `  config table      — ${
        matched
          ? `[${matched.key}] in $${entryToRates(matched.entry).input}/Mtok, out $${entryToRates(matched.entry).output}/Mtok`
          : "no entry"
      }`,
    );

    const catalog = catalogRates(model);
    lines.push(
      `  model catalog     — ${
        catalog ? `in $${catalog.input}/Mtok, out $${catalog.output}/Mtok` : "no cost on the model definition"
      }`,
    );

    const alias = lookupAlias(config.rates.aliases, model.provider, model.id);
    const target = alias ? splitAliasTarget(alias) : undefined;
    // Resolved through the same path pricing uses, so this line can never
    // disagree with the verdict printed below it.
    const remote = config.rates.remote.enabled
      ? (lookupRemoteRatesWithKey(remoteRates, target?.provider ?? model.provider, target?.modelId ?? model.id) ??
        (target ? lookupRemoteRatesWithKey(remoteRates, model.provider, model.id) : undefined))
      : undefined;
    const remoteNote = !config.rates.remote.enabled
      ? "off"
      : remote
        ? `[${remote.key}] in $${remote.rate.input}/Mtok, out $${remote.rate.output}/Mtok${alias ? ` (via alias → ${alias})` : ""}`
        : remoteRates
          ? `no entry (list from ${remoteRates.source}, ${remoteRates.byProviderModel.size} models)`
          : "no list loaded (offline, still fetching, or the fetch failed)";
    lines.push(`  published list    — ${remoteNote}`);

    const resolved = resolvedFor(model);
    lines.push(
      resolved.rates
        ? `  → using ${resolved.source}${resolved.key ? ` [${resolved.key}]` : ""} (in $${resolved.rates.input}/Mtok, out $${resolved.rates.output}/Mtok)`
        : "  → NONE — spend cannot be measured and budgets will not be enforced",
    );
    return lines;
  }

  // -------------------------------------------------------------------- command

  pi.registerCommand("budget", {
    description: "Show or change budget limits: /budget [show|set <key>=<value>|explain|models|reset|on|off]",
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
          const resolved = resolveRates(ctx.model, config.pricing, remoteRatesFor);
          const sourceLabel =
            resolved.source === "config"
              ? "config table"
              : resolved.source === "catalog"
                ? "model catalog"
                : resolved.source === "models.dev"
                  ? `published list (${config.rates.remote.url})`
                  : "none";
          const pricing = resolved.rates
            ? `${sourceLabel} — in $${resolved.rates.input}/Mtok, out $${resolved.rates.output}/Mtok`
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
          // Under the lock, or a session that already read the old file inside
          // its own critical section would write its merge afterwards and
          // resurrect exactly what was erased.
          records = [];
          withLedgerLock(stateDir, () => saveRecords(stateDir, records));
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
          refreshSharedLedger();
          const byModel = spendByModel(records);
          if (byModel.length === 0) {
            say("No spend recorded yet.");
            return;
          }
          // Show which source priced each model. The precedence chain can pick
          // a different tier per model, so a number that looks wrong is only
          // explainable if the record says where it came from. `spendByModel`
          // groups by bare model name, so the lookup must too.
          const sources = new Map<string, Set<string>>();
          for (const record of records) {
            const set = sources.get(record.model) ?? new Set<string>();
            set.add(record.unpriced ? "unpriced" : (record.rateSource ?? "reported"));
            sources.set(record.model, set);
          }
          say(
            byModel
              .map((row) => {
                const from = [...(sources.get(row.model) ?? [])].sort().join(", ");
                return `${formatUsd(row.cost).padStart(10)}  ${row.model}${from ? `  [${from}]` : ""}`;
              })
              .join("\n"),
          );
          return;
        }

        case "explain": {
          say(explainModel(ctx.model).join("\n"));
          return;
        }

        default:
          say(`Unknown subcommand: ${subcommand}\nTry: show | set <key>=<value> | explain | models | reset | on | off`);
      }
    },
  });
}
