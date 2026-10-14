/**
 * Integration tests for the extension itself.
 *
 * These drive the real `budgetGuard()` factory through a fake `ExtensionAPI`,
 * so the enforcement logic is verified end to end without an agent, a model, or
 * any spend. `PI_CODING_AGENT_DIR` is redirected to a temp directory per test so
 * nothing touches the developer's real state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import budgetGuard from "../src/extension.ts";
import { ledgerPath, loadRecords, ratesPath, readJson, resolveStateDir, writeJsonAtomic } from "../src/store.ts";

/**
 * Keep the suite offline. The extension refreshes the published price list in
 * the background at session start; here `fetch` is stubbed so no test ever
 * reaches the network, and `publishedList` can be swapped per test.
 */
let publishedList: unknown = {};
let fetchCalls = 0;
let fetchShouldFail = false;
globalThis.fetch = (async () => {
  fetchCalls++;
  if (fetchShouldFail) throw new Error("offline");
  return { ok: true, json: async () => publishedList } as unknown as Response;
}) as unknown as typeof fetch;

/** Let the fire-and-forget background refresh finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

type PiApi = Parameters<typeof budgetGuard>[0];
type Handler = (event: unknown, ctx: unknown) => unknown;

interface Notification {
  message: string;
  type: string;
}

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const setModelCalls: Array<{ id: string }> = [];
  let setModelResult = true;

  const pi = {
    registerFlag(name: string, _options: unknown) {
      if (!flags.has(name)) flags.set(name, undefined);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
    setModel: async (model: { id: string }) => {
      setModelCalls.push(model);
      return setModelResult;
    },
  };

  return {
    pi,
    flags,
    commands,
    setModelCalls,
    failSetModel() {
      setModelResult = false;
    },
    hasHandler: (event: string) => (handlers.get(event)?.length ?? 0) > 0,
    async emit(event: string, payload: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

function usageWithCost(total: number, totalTokens = 1_500) {
  return {
    input: 1_000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

/** A session-branch entry for a finished assistant message costing `cost` USD. */
function assistantEntry(cost: number) {
  return { type: "message", message: { role: "assistant", usage: usageWithCost(cost) } };
}

/** A non-message usage entry, as pi writes for cache warming and similar. */
function usageEntry(cost: number) {
  return { type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude", usage: usageWithCost(cost) };
}

const EXPENSIVE = { id: "claude-sonnet", provider: "anthropic", cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } };
const CHEAP = { id: "deepseek-chat", provider: "deepseek", cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.5 } };

function createContext(options: {
  branch?: unknown[];
  sessionId?: string;
  model?: unknown;
  available?: unknown[];
  hasUI?: boolean;
  /** Pass `null` to model pi reporting no token estimate (e.g. right after compaction). */
  contextTokens?: number | null;
} = {}) {
  const notifications: Notification[] = [];
  const statuses: Array<string | undefined> = [];
  let aborted = false;

  const model = options.model ?? EXPENSIVE;

  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
    sessionManager: {
      getBranch: () => options.branch ?? [],
      getSessionId: () => options.sessionId ?? "session-1",
    },
    model,
    getContextUsage: () =>
      options.contextTokens === undefined
        ? undefined
        : { tokens: options.contextTokens, contextWindow: 200_000, percent: null },
    modelRegistry: { getAvailable: () => options.available ?? [model] },
    scopedModels: [],
    abort: () => {
      aborted = true;
    },
  };

  return { ctx, notifications, statuses, isAborted: () => aborted };
}

/** Run `fn` with a private state directory. */
async function withStateDir(fn: () => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-spend-guard-ext-"));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("registers its hooks, command, and flags", async () => {
  await withStateDir(() => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    for (const event of ["session_start", "message_end", "before_provider_request", "before_agent_start", "session_shutdown"]) {
      assert.ok(fake.hasHandler(event), `expected a handler for ${event}`);
    }
    assert.ok(fake.commands.has("budget"));
    assert.ok(fake.flags.has("budget-config"));
    assert.ok(fake.flags.has("no-budget"));
  });
});

test("allows requests while spend is under the thresholds", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, isAborted } = createContext({ branch: [assistantEntry(0.5)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), false);
  });
});

test("aborts the request once session spend crosses the block threshold", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // Default session block threshold is $10.
    const { ctx, isAborted, notifications } = createContext({ branch: [assistantEntry(12)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), true);
    assert.ok(notifications.some((n) => /Budget exhausted/.test(n.message)));
  });
});

test("counts non-message usage entries toward session spend", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // 6 + 5 = 11 > 10, but neither entry alone crosses it.
    const { ctx, isAborted } = createContext({ branch: [assistantEntry(6), usageEntry(5)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), true);
  });
});

test("blocks the request whose own cost would cross the block threshold", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // $9.90 spent against the $10 session block, with a large prompt about to
    // be sent. This request — not the next one — is what crosses the line, so
    // spend-only enforcement would let the overshoot through.
    const { ctx, isAborted, notifications } = createContext({
      branch: [assistantEntry(9.9)],
      contextTokens: 100_000,
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), true);
    assert.ok(
      notifications.some((n) => /would take session spend to/.test(n.message)),
      "the message must say the request was projected, not that spend was already exhausted",
    );
    assert.ok(
      notifications.every((n) => !/exhausted/.test(n.message)),
      "claiming exhaustion would be untrue: only $9.90 has actually been spent",
    );
  });
});

test("projection does not block a request that still fits", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // $1 spent with a small prompt: the projection stays far below $10.
    const { ctx, isAborted } = createContext({ branch: [assistantEntry(1)], contextTokens: 1_000 });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), false);
  });
});

test("an unknown context size degrades to spend-only enforcement", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // Same $9.90 as the blocking case, but pi reports no token estimate. The
    // guard must not invent a number to block on.
    const { ctx, isAborted } = createContext({ branch: [assistantEntry(9.9)], contextTokens: null });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), false);
  });
});

test("projection is skipped when the model has no catalog price", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const unpriced = { id: "local-model", provider: "workbuddy" };
    const { ctx, isAborted } = createContext({
      branch: [assistantEntry(9.9)],
      contextTokens: 100_000,
      model: unpriced,
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), false);
  });
});

test("estimate can be turned off to restore spend-only enforcement", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, isAborted } = createContext({ branch: [assistantEntry(9.9)], contextTokens: 100_000 });
    await fake.emit("session_start", {}, ctx);

    const command = fake.commands.get("budget");
    assert.ok(command, "expected the /budget command to be registered");
    await command.handler("set estimate.enabled=false", ctx);

    await fake.emit("before_provider_request", {}, ctx);
    assert.equal(isAborted(), false);
  });
});

test("does not abort when blocking is disabled in config", async () => {
  await withStateDir(async () => {
    const dir = resolveStateDir();
    writeJsonAtomic(join(dir, "config.json"), { block: { enabled: false }, limits: { session: { block: 1 } } });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, isAborted, notifications } = createContext({ branch: [assistantEntry(50)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), false);
    // The user is still told about the overspend.
    assert.ok(notifications.some((n) => /Budget exhausted/.test(n.message)));
  });
});

test("--no-budget disables enforcement entirely", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    fake.flags.set("no-budget", true);
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, isAborted, notifications } = createContext({ branch: [assistantEntry(100)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), false);
    assert.equal(notifications.length, 0);
  });
});

test("warns at the warn threshold without aborting", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // Default session warn is $2, downgrade $5.
    const { ctx, isAborted, notifications } = createContext({ branch: [assistantEntry(3)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);

    assert.equal(isAborted(), false);
    assert.ok(notifications.some((n) => /Budget warning/.test(n.message)));
    assert.equal(fake.setModelCalls.length, 0);
  });
});

test("downgrades to the cheapest available model past the downgrade threshold", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext({
      branch: [assistantEntry(6)],
      model: EXPENSIVE,
      available: [EXPENSIVE, CHEAP],
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);

    assert.equal(fake.setModelCalls.length, 1);
    assert.equal(fake.setModelCalls[0]?.id, "deepseek-chat");
  });
});

test("honours an explicitly configured downgrade model", async () => {
  await withStateDir(async () => {
    writeJsonAtomic(join(resolveStateDir(), "config.json"), {
      downgrade: { model: "deepseek-chat" },
      limits: { session: { downgrade: 1 } },
    });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext({
      branch: [assistantEntry(6)],
      model: EXPENSIVE,
      available: [EXPENSIVE, CHEAP],
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);

    assert.equal(fake.setModelCalls[0]?.id, "deepseek-chat");
  });
});

test("restricts downgrade candidates to preferred providers", async () => {
  await withStateDir(async () => {
    writeJsonAtomic(join(resolveStateDir(), "config.json"), {
      downgrade: { preferProviders: ["anthropic"] },
      limits: { session: { downgrade: 1 } },
    });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const cheaperOther = { id: "free-model", provider: "other", cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 } };
    const pricierAnthropic = { id: "haiku", provider: "anthropic", cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } };

    const { ctx } = createContext({
      branch: [assistantEntry(6)],
      model: EXPENSIVE,
      available: [EXPENSIVE, cheaperOther, pricierAnthropic],
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);

    // The globally cheapest model is excluded by the provider filter.
    assert.equal(fake.setModelCalls[0]?.id, "haiku");
  });
});

test("reports when a downgrade cannot be applied", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    fake.failSetModel();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({
      branch: [assistantEntry(6)],
      model: EXPENSIVE,
      available: [EXPENSIVE, CHEAP],
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);

    assert.ok(notifications.some((n) => /could not switch/.test(n.message)));
  });
});

test("does not downgrade twice for the same crossing", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext({
      branch: [assistantEntry(6)],
      model: EXPENSIVE,
      available: [EXPENSIVE, CHEAP],
    });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);
    await fake.emit("before_agent_start", {}, ctx);

    assert.equal(fake.setModelCalls.length, 1);
  });
});

test("records provider-reported cost from message_end into the ledger", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);

    await fake.emit(
      "message_end",
      { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet", usage: usageWithCost(0.0375) } },
      ctx,
    );
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1);
    assert.equal(records[0]?.cost, 0.0375);
    assert.equal(records[0]?.estimated, false);
    assert.equal(records[0]?.model, "claude-sonnet");
    assert.equal(records[0]?.sessionId, "session-1");
  });
});

test("falls back to catalog rates when the provider reports no cost", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext({ model: EXPENSIVE });
    await fake.emit("session_start", {}, ctx);

    const noCostUsage = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
    };
    await fake.emit("message_end", { message: { role: "assistant", usage: noCostUsage } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1);
    // $15 per million input tokens on the current model.
    assert.equal(records[0]?.cost, 15);
    assert.equal(records[0]?.estimated, true);
  });
});

test("toolResult usage is recorded — it is real spend, not ignored", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);
    // User messages never carry usage. A toolResult's usage is the model
    // calls the tool itself made; pi's own usage totals book it under
    // "Tools/summaries", so the guard must count it too.
    await fake.emit("message_end", { message: { role: "user" } }, ctx);
    await fake.emit("message_end", { message: { role: "toolResult", usage: usageWithCost(5) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1, "only the toolResult carries usage");
    assert.equal(records[0]?.cost, 5);
  });
});

test("persists the record at message_end, before shutdown", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);
    await fake.emit("message_end", { message: { role: "assistant", usage: usageWithCost(2) } }, ctx);

    // No shutdown emitted: the record must already be on disk, so a concurrent
    // session (or a crash) cannot lose it.
    assert.equal(loadRecords(resolveStateDir()).length, 1);
    assert.equal(loadRecords(resolveStateDir())[0]?.cost, 2);
  });
});

test("persists the ledger across a reload and reuses it for daily spend", async () => {
  await withStateDir(async () => {
    const first = createFakePi();
    budgetGuard(first.pi as unknown as PiApi);
    const { ctx: ctxA } = createContext();
    await first.emit("session_start", {}, ctxA);
    await first.emit("message_end", { message: { role: "assistant", usage: usageWithCost(3) } }, ctxA);
    await first.emit("session_shutdown", {}, ctxA);

    // A fresh instance, as if pi reloaded the extension.
    const second = createFakePi();
    budgetGuard(second.pi as unknown as PiApi);
    const { ctx: ctxB, notifications } = createContext({ sessionId: "session-2" });
    await second.emit("session_start", {}, ctxB);
    await second.commands.get("budget")!.handler("show", ctxB);

    assert.ok(notifications.some((n) => /daily \$3\.00/.test(n.message)));
  });
});

test("before_provider_request re-reads the shared ledger before deciding", async () => {
  await withStateDir(async () => {
    // Session A runs with a daily block it has not yet reached. Session B —
    // a separate budgetGuard instance sharing the state dir — records spend
    // directly to the ledger. A's next provider request must see B's spend
    // and abort, or parallel sessions could each spend the same daily budget.
    writeConfig({ limits: { daily: { warn: 2, downgrade: 3, block: 5 } } });

    const a = createFakePi();
    budgetGuard(a.pi as unknown as PiApi);
    const aCtx = createContext({ model: EXPENSIVE, branch: [assistantEntry(1)] });
    const { ctx: ctxA, isAborted } = aCtx;
    await a.emit("session_start", {}, ctxA);

    // B writes $9 of daily spend behind A's back.
    const b = createFakePi();
    budgetGuard(b.pi as unknown as PiApi);
    const { ctx: ctxB } = createContext({ model: EXPENSIVE, sessionId: "session-B" });
    await b.emit("session_start", {}, ctxB);
    await b.emit("message_end", { message: { role: "assistant", usage: usageWithCost(9) } }, ctxB);

    // A has only $1 in its branch and no idea B exists — unless the block
    // path re-reads the shared ledger.
    await a.emit("before_provider_request", {}, ctxA);
    assert.ok(isAborted(), "A must see B's concurrent daily spend and abort");
  });
});


test("the projection prices the context at the observed cache split, not all-uncached", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // A long cached session: last turn served 190k of 200k tokens from cache.
    const cachedTurn = {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 10_000, output: 500, cacheRead: 190_000, cacheWrite: 0, totalTokens: 200_500 },
      },
    };
    const { ctx, isAborted } = createContext({
      model: EXPENSIVE,
      branch: [cachedTurn],
      contextTokens: 200_000,
    });
    // Config must be written BEFORE session_start: loadConfig() runs there and
    // a later write would be silently ignored, letting the test pass under the
    // default $10 block regardless of what the projection actually does.
    //
    // Cache-aware projection: 10k uncached × $15/Mtok + 190k cached × $1.5/Mtok
    //   + trailing output 500 × $75/Mtok ≈ $0.4875.
    // All-uncached projection: 200k × $15/Mtok + 500 × $75/Mtok ≈ $3.0375.
    // A block at $1.50 sits strictly between: passes only if the projection
    // really used the observed cached fraction.
    writeConfig({ pricing: { "anthropic/claude-sonnet": { input: 15, output: 75, cacheRead: 1.5 } }, limits: { session: { warn: 0.6, downgrade: 1, block: 1.5 } } });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);
    assert.ok(!isAborted(), "a heavily cached context must not be priced as all-uncached");

    // And the discriminating case: the SAME request must be blocked if the
    // projection ignored the cache — pinning that the test can tell the two
    // projections apart.
    const { ctx: ctx2, isAborted: isAborted2 } = createContext({
      model: EXPENSIVE,
      branch: [{ type: "message", message: { role: "assistant", usage: { input: 200_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 200_500 } } }],
      contextTokens: 200_000,
    });
    await fake.emit("session_start", {}, ctx2);
    await fake.emit("before_provider_request", {}, ctx2);
    assert.ok(isAborted2(), "an uncached context of the same size must cross the $1.50 block");
  });
});

test("the projection adapts the output estimate to the session's actual replies", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // This session writes ~100-token replies, not the 2048 default.
    const shortTurn = {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 5_000, output: 100, cacheRead: 4_000, cacheWrite: 0, totalTokens: 5_100 },
      },
    };
    const { ctx, isAborted } = createContext({ model: EXPENSIVE, branch: [shortTurn], contextTokens: 6_000 });
    // Written BEFORE session_start for the same reason as the test above.
    //
    // Observed cached ratio: 4000/(4000+5000) = 4/9 cached.
    // Adaptive projection: 6000×(5/9) uncached × $15/Mtok + 6000×(4/9) × $1.5/Mtok
    //   + trailing output 100 × $75/Mtok ≈ $0.0615.
    // The historical branch turn itself costs $0.0885 in session scope, so the
    // decision total is ≈ $0.15. A no-history session falls back to all-uncached
    // input plus the fixed 2048-token reservation: ≈ $0.2436. A block at $0.20
    // sits strictly between: the adaptive session passes, the fallback session
    // is blocked — the test can tell the two projections apart.
    writeConfig({ pricing: { "anthropic/claude-sonnet": { input: 15, output: 75, cacheRead: 1.5 } }, limits: { session: { warn: 0.1, downgrade: 0.15, block: 0.2 } } });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);
    assert.ok(!isAborted(), "short-reply sessions must not be blocked by the default output reservation");

    // Discriminating case: without observed replies the projection falls back
    // to all-uncached input plus the fixed 2048-token reservation (≈ $0.2436),
    // crossing the $0.20 block — proving the thresholds detect the difference.
    const { ctx: ctx2, isAborted: isAborted2 } = createContext({ model: EXPENSIVE, contextTokens: 6_000 });
    await fake.emit("session_start", {}, ctx2);
    await fake.emit("before_provider_request", {}, ctx2);
    assert.ok(isAborted2(), "without observed replies the 2048-token reservation crosses the block");
  });
});

test("session spend prices each branch entry with its own model's rates", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // One expensive-model turn ($15/Mtok input), then the guard downgraded to
    // a cheap model. The historical turn must still count at ITS rates.
    const expensiveTurn = {
      type: "message",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet",
        usage: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100_000 },
      },
    };
    const { ctx, notifications } = createContext({ model: CHEAP, branch: [expensiveTurn], available: [EXPENSIVE, CHEAP] });
    await fake.emit("session_start", {}, ctx);
    await fake.commands.get("budget")!.handler("show", ctx);

    // Re-pricing the historical turn at CHEAP rates would report $0.05; the
    // correct per-entry pricing reports $1.50.
    const shown = notifications.map((n) => n.message).join("\n");
    assert.match(shown, /session \$1\.50/, "historical turns must be priced at their own model's rates");
  });
});

test("session spend is rebuilt from the branch, not from the ledger", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({ branch: [assistantEntry(4.25)] });
    await fake.emit("session_start", {}, ctx);
    await fake.commands.get("budget")!.handler("show", ctx);

    assert.ok(notifications.some((n) => /session \$4\.25/.test(n.message)));
  });
});

test("/budget set persists the change and applies it", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({ branch: [assistantEntry(15)] });
    await fake.emit("session_start", {}, ctx);

    await fake.commands.get("budget")!.handler("set session.block=20", ctx);
    assert.ok(notifications.some((n) => /Updated/.test(n.message)));

    // Now $15 is under the raised $20 block threshold.
    const { ctx: ctx2, isAborted } = createContext({ branch: [assistantEntry(15)] });
    await fake.emit("before_provider_request", {}, ctx2);
    assert.equal(isAborted(), false);
  });
});

test("/budget set rejects an unknown key", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext();
    await fake.emit("session_start", {}, ctx);
    await fake.commands.get("budget")!.handler("set nonsense=1", ctx);

    assert.ok(notifications.some((n) => /Unknown key/.test(n.message)));
  });
});

test("/budget reset clears the ledger file", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);
    await fake.emit("message_end", { message: { role: "assistant", usage: usageWithCost(1) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);
    assert.equal(loadRecords(resolveStateDir()).length, 1);

    await fake.commands.get("budget")!.handler("reset", ctx);
    assert.equal(loadRecords(resolveStateDir()).length, 0);
  });
});

test("/budget models lists per-model spend", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);
    await fake.emit(
      "message_end",
      { message: { role: "assistant", model: "claude-sonnet", usage: usageWithCost(2) } },
      ctx,
    );

    const { ctx: ctx2, notifications } = createContext();
    await fake.commands.get("budget")!.handler("models", ctx2);
    assert.ok(notifications.some((n) => /claude-sonnet/.test(n.message)));
  });
});

test("a reported $0 with known rates is priced from the rates, not trusted", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext({ model: EXPENSIVE });
    await fake.emit("session_start", {}, ctx);
    // Verified against a real reseller gateway: it reports cost.total = 0 for
    // calls it does bill. Trusting that would make every budget a no-op.
    const reportsZero = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await fake.emit("message_end", { message: { role: "assistant", usage: reportsZero } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1);
    assert.equal(records[0]?.cost, 15, "a reported $0 must be cross-checked against the rates");
    assert.equal(records[0]?.estimated, true);
  });
});

test("a reported $0 with no rates anywhere is recorded as unpriced, not free", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const unpriced = { id: "unpriced", provider: "custom", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { ctx } = createContext({ model: unpriced });
    await fake.emit("session_start", {}, ctx);
    // No rates exist to cross-check the reported $0, so it cannot be trusted
    // as measured-free — it is indistinguishable from an unknown price.
    await fake.emit("message_end", { message: { role: "assistant", usage: usageWithCost(0) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1);
    assert.equal(records[0]?.cost, 0);
    assert.equal(records[0]?.estimated, true);
    assert.equal(records[0]?.unpriced, true, "an unverifiable $0 must stay flagged unpriced");
  });
});

test("a call with no cost field at all is recorded as unpriced", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const unpriced = { id: "unpriced", provider: "custom", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { ctx } = createContext({ model: unpriced });
    await fake.emit("session_start", {}, ctx);
    // No cost object: the provider said nothing. This is the unknown case.
    const usage = usageWithCost(0);
    const { cost: _omit, ...noCostField } = usage as Record<string, unknown> & { cost?: unknown };
    void _omit;
    await fake.emit("message_end", { message: { role: "assistant", usage: noCostField } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1);
    assert.equal(records[0]?.cost, 0);
    assert.equal(records[0]?.estimated, true);
    assert.equal(records[0]?.unpriced, true, "unknown price must be flagged, never counted as measured");
  });
});

test("warns when the active model has no pricing data", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const unpriced = { id: "unpriced", provider: "custom", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { ctx, notifications } = createContext({ model: unpriced });
    await fake.emit("session_start", {}, ctx);

    const warning = notifications.find((n) => /no price is known for/.test(n.message));
    assert.ok(warning, "an unpriced model must be reported, not silently ignored");
    assert.match(warning.message, /custom\/unpriced/);
    assert.match(warning.message, /"pricing" entry/, "the warning must say how to fix it");
  });
});

test("does not warn about pricing for a model with catalog rates", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({ model: EXPENSIVE });
    await fake.emit("session_start", {}, ctx);

    assert.equal(notifications.filter((n) => /no price is known for/.test(n.message)).length, 0);
  });
});

const UNPRICED = {
  id: "unpriced",
  provider: "custom",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Write a guard config into the private state dir for the current test. */
function writeConfig(config: unknown): void {
  writeJsonAtomic(join(resolveStateDir(), "config.json"), config);
}

/** Load the single record a test just persisted. */
function soleRecord(dir: string) {
  const records = loadRecords(dir);
  assert.equal(records.length, 1, "expected exactly one persisted record");
  const record = records[0];
  assert.ok(record);
  return record;
}

test("a pricing entry silences the unpriced warning", async () => {
  await withStateDir(async () => {
    writeConfig({ pricing: { "custom/unpriced": { input: 3, output: 15 } } });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({ model: UNPRICED });
    await fake.emit("session_start", {}, ctx);

    assert.equal(notifications.filter((n) => /no price is known for/.test(n.message)).length, 0);
  });
});

test("the pricing table measures spend the catalog cannot price", async () => {
  await withStateDir(async () => {
    writeConfig({ pricing: { "custom/unpriced": { input: 3, output: 15 } } });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // 1,000,000 input tokens at $3/Mtok = $3.00. The provider reports no cost
    // and the catalog has none either, so only the pricing table can price this.
    const usage = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
    };

    const { ctx } = createContext({ model: UNPRICED });
    await fake.emit("session_start", {}, ctx);
    await fake.emit(
      "message_end",
      { message: { role: "assistant", usage, provider: "custom", model: "unpriced" } },
      ctx,
    );
    await fake.emit("session_shutdown", {}, ctx);

    const record = soleRecord(resolveStateDir());
    assert.equal(record.cost, 3, "the pricing table must produce a real cost");
    assert.equal(record.estimated, true);
    assert.notEqual(record.unpriced, true, "a priced call must not be flagged unpriced");
  });
});

test("the pricing table makes the pre-flight projection work without catalog prices", async () => {
  await withStateDir(async () => {
    writeConfig({
      pricing: { "custom/unpriced": { input: 3, output: 15 } },
      limits: { session: { block: 0.01 } },
    });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // $0 spent, but 5,000 input tokens at $3/Mtok is $0.015 — past the $0.01
    // block. Without the pricing table the projection would be $0 and this
    // request would be allowed through.
    const { ctx, isAborted } = createContext({ model: UNPRICED, contextTokens: 5_000 });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    assert.equal(isAborted(), true);
  });
});

test("a wildcard pricing entry covers every model of a provider", async () => {
  await withStateDir(async () => {
    writeConfig({ pricing: { "custom/*": { input: 3, output: 15 } } });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({ model: UNPRICED });
    await fake.emit("session_start", {}, ctx);

    assert.equal(notifications.filter((n) => /no price is known for/.test(n.message)).length, 0);
  });
});

test("the pricing table outranks the model catalog", async () => {
  await withStateDir(async () => {
    // Catalog says $15/$75 per Mtok; the user's table says this route is cheaper.
    writeConfig({ pricing: { "anthropic/claude-sonnet": { input: 1, output: 2 } } });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const usage = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
    };

    const { ctx } = createContext({ model: EXPENSIVE });
    await fake.emit("session_start", {}, ctx);
    await fake.emit(
      "message_end",
      { message: { role: "assistant", usage, provider: "anthropic", model: "claude-sonnet" } },
      ctx,
    );
    await fake.emit("session_shutdown", {}, ctx);

    const record = soleRecord(resolveStateDir());
    assert.equal(record.cost, 1, "the explicit table rate must win over the catalog");
  });
});

test("a call with no price from anywhere is recorded as unpriced", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    // No cost object at all: the provider reported nothing and no rate source
    // knows this model — the unknown case, distinct from a reported $0.
    const usage = {
      input: 5_000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5_010,
    };

    const { ctx } = createContext({ model: UNPRICED });
    await fake.emit("session_start", {}, ctx);
    await fake.emit(
      "message_end",
      { message: { role: "assistant", usage, provider: "custom", model: "unpriced" } },
      ctx,
    );
    await fake.emit("session_shutdown", {}, ctx);

    const record = soleRecord(resolveStateDir());
    assert.equal(record.unpriced, true, "an unknown price must be distinguishable from free");
  });
});

test("works without a UI", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, isAborted } = createContext({ hasUI: false, branch: [assistantEntry(99)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);
    await fake.emit("message_end", { message: { role: "assistant", usage: usageWithCost(1) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    // Enforcement still works in print/JSON modes; only the notices are dropped.
    assert.equal(isAborted(), true);
    assert.equal(loadRecords(resolveStateDir()).length, 1);
  });
});

test("survives a corrupt config file", async () => {
  await withStateDir(async () => {
    mkdirSync(resolveStateDir(), { recursive: true });
    writeFileSync(join(resolveStateDir(), "config.json"), "{ broken");

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, isAborted } = createContext({ branch: [assistantEntry(12)] });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("before_provider_request", {}, ctx);

    // Defaults apply, so the block still fires.
    assert.equal(isAborted(), true);
  });
});

test("writes the ledger atomically under the state directory", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);
    await fake.emit("message_end", { message: { role: "assistant", usage: usageWithCost(1) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    assert.ok(existsSync(ledgerPath(resolveStateDir())));
  });
});

// ------------------------------------------------------- published price list

/** A models.dev-shaped payload with one priced model. */
function publishedPayload() {
  return {
    zai: { models: { "glm-5.3": { cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 } } } },
  };
}

test("a cached published price list prices a model the catalog cannot", async () => {
  await withStateDir(async () => {
    // Pre-seed the cache: this is the offline path the enforcement uses.
    writeJsonAtomic(ratesPath(resolveStateDir()), {
      version: 1,
      fetchedAt: Date.now(),
      source: "test",
      entries: { "zai/glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } },
    });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);
    const gatewayModel = { id: "global:glm-5.3", provider: "workbuddy" };
    const { ctx, notifications } = createContext({ model: gatewayModel });
    await fake.emit("session_start", {}, ctx);

    // No unpriced warning: the published list covered it.
    assert.equal(
      notifications.find((n) => /no price is known/.test(n.message)),
      undefined,
      "a model priced from the published list must not warn",
    );

    await fake.emit(
      "message_end",
      { message: { role: "assistant", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 } } },
      ctx,
    );
    const record = soleRecord(resolveStateDir());
    // 1M input at $1.4/Mtok.
    assert.equal(record.cost, 1.4);
    assert.equal(record.estimated, true);

    await fake.commands.get("budget")!.handler("show", ctx);
    const shown = notifications.map((n) => n.message).join("\n");
    assert.match(shown, /published list/, "the source must be named honestly");
  });
});

test("the config pricing table outranks the published list", async () => {
  await withStateDir(async () => {
    writeConfig({ pricing: { "workbuddy/global:glm-5.3": { input: 100, output: 200 } } });
    writeJsonAtomic(ratesPath(resolveStateDir()), {
      version: 1,
      fetchedAt: Date.now(),
      source: "test",
      entries: { "zai/glm-5.3": { input: 1.4, output: 4.4 } },
    });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);
    const { ctx } = createContext({ model: { id: "global:glm-5.3", provider: "workbuddy" } });
    await fake.emit("session_start", {}, ctx);
    await fake.emit(
      "message_end",
      { message: { role: "assistant", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 } } },
      ctx,
    );

    assert.equal(soleRecord(resolveStateDir()).cost, 100, "the user's own rate must win");
  });
});

test("a stale cache is refreshed in the background and written to disk", async () => {
  await withStateDir(async () => {
    publishedList = publishedPayload();
    fetchCalls = 0;

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);
    const { ctx } = createContext({ model: { id: "global:glm-5.3", provider: "workbuddy" } });
    await fake.emit("session_start", {}, ctx);
    await flush();

    assert.equal(fetchCalls, 1, "a missing snapshot must trigger one fetch");
    const cached = readJson(ratesPath(resolveStateDir())) as { entries?: Record<string, unknown> } | null;
    assert.ok(cached?.entries?.["zai/glm-5.3"], "the fetched list must be cached for offline use");
  });
});

test("a fresh cache is not re-fetched", async () => {
  await withStateDir(async () => {
    publishedList = publishedPayload();
    writeJsonAtomic(ratesPath(resolveStateDir()), {
      version: 1,
      fetchedAt: Date.now(),
      source: "test",
      entries: { "zai/glm-5.3": { input: 1.4, output: 4.4 } },
    });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);
    const { ctx } = createContext();
    fetchCalls = 0;
    await fake.emit("session_start", {}, ctx);
    await flush();

    assert.equal(fetchCalls, 0, "a snapshot inside its TTL must not be re-fetched");
  });
});

test("an unreachable price list is ignored and enforcement still works", async () => {
  await withStateDir(async () => {
    fetchShouldFail = true;
    try {
      const fake = createFakePi();
      budgetGuard(fake.pi as unknown as PiApi);
      const { ctx, isAborted } = createContext({ branch: [assistantEntry(11)] });
      await fake.emit("session_start", {}, ctx);
      await flush();
      // Offline: the guard falls back to the offline sources and still aborts.
      await fake.emit("before_provider_request", {}, ctx);
      assert.ok(isAborted(), "a failed refresh must not disable enforcement");
      assert.equal(readJson(ratesPath(resolveStateDir())), null, "a failed fetch must not write a cache");
    } finally {
      fetchShouldFail = false;
    }
  });
});

test("automatic rate lookup can be turned off", async () => {
  await withStateDir(async () => {
    publishedList = publishedPayload();
    writeConfig({ rates: { remote: { enabled: false } } });

    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);
    const { ctx, notifications } = createContext({ model: { id: "global:glm-5.3", provider: "workbuddy" } });
    fetchCalls = 0;
    await fake.emit("session_start", {}, ctx);
    await flush();

    assert.equal(fetchCalls, 0, "disabling the feature must prevent every network call");
    assert.ok(
      notifications.some((n) => /no price is known/.test(n.message)),
      "with the feature off and no other source, the model must be reported unpriced",
    );
  });
});
