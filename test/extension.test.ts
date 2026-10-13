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
import { ledgerPath, loadRecords, resolveStateDir, writeJsonAtomic } from "../src/store.ts";

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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

test("ignores non-assistant messages", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx } = createContext();
    await fake.emit("session_start", {}, ctx);
    await fake.emit("message_end", { message: { role: "user" } }, ctx);
    await fake.emit("message_end", { message: { role: "toolResult", usage: usageWithCost(5) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    assert.equal(loadRecords(resolveStateDir()).length, 0);
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

test("flags unknown pricing as an estimate rather than as free", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const unpriced = { id: "unpriced", provider: "custom", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { ctx } = createContext({ model: unpriced });
    await fake.emit("session_start", {}, ctx);
    await fake.emit("message_end", { message: { role: "assistant", usage: usageWithCost(0) } }, ctx);
    await fake.emit("session_shutdown", {}, ctx);

    const records = loadRecords(resolveStateDir());
    assert.equal(records.length, 1);
    assert.equal(records[0]?.cost, 0);
    assert.equal(records[0]?.estimated, true);
  });
});

test("warns once when the active model has no pricing data", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const unpriced = { id: "unpriced", provider: "custom", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { ctx, notifications } = createContext({ model: unpriced });
    await fake.emit("session_start", {}, ctx);

    assert.ok(notifications.some((n) => /no pricing for/.test(n.message)));
  });
});

test("does not warn about pricing for a model with catalog rates", async () => {
  await withStateDir(async () => {
    const fake = createFakePi();
    budgetGuard(fake.pi as unknown as PiApi);

    const { ctx, notifications } = createContext({ model: EXPENSIVE });
    await fake.emit("session_start", {}, ctx);

    assert.equal(notifications.filter((n) => /no pricing for/.test(n.message)).length, 0);
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
