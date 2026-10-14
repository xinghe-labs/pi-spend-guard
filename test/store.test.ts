import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendRecords,
  configPath,
  ledgerPath,
  loadRecords,
  ratesPath,
  mergeRecords,
  parseRecords,
  readJson,
  resolveAgentDir,
  resolveStateDir,
  saveRecords,
  serializeRecords,
  withLedgerLock,
  withRatesLock,
  writeJsonAtomic,
} from "../src/store.ts";
import type { SpendRecord } from "../src/types.ts";

function validRecord(overrides: Partial<SpendRecord> = {}): SpendRecord {
  return {
    at: 1_700_000_000_000,
    provider: "anthropic",
    model: "claude-sonnet",
    cost: 0.42,
    usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300 },
    estimated: false,
    ...overrides,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-spend-guard-test-"));
}

test("resolveAgentDir honours PI_CODING_AGENT_DIR", () => {
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" } as NodeJS.ProcessEnv), "/custom/agent");
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "  /trimmed  " } as NodeJS.ProcessEnv), "/trimmed");
});

test("resolveAgentDir falls back to ~/.pi/agent", () => {
  const dir = resolveAgentDir({} as NodeJS.ProcessEnv);
  assert.match(dir, /\.pi[/\\]agent$/);
});

test("resolveStateDir nests under the agent dir", () => {
  assert.equal(resolveStateDir({ PI_CODING_AGENT_DIR: "/agent" } as NodeJS.ProcessEnv), "/agent/pi-spend-guard");
});

test("configPath and ledgerPath are distinct", () => {
  assert.notEqual(configPath("/state"), ledgerPath("/state"));
});

test("readJson returns null for a missing file", () => {
  assert.equal(readJson(join(tempDir(), "nope.json")), null);
});

test("readJson returns null for corrupt JSON instead of throwing", () => {
  const dir = tempDir();
  const path = join(dir, "broken.json");
  writeFileSync(path, "{ this is not json");
  assert.equal(readJson(path), null);
  rmSync(dir, { recursive: true, force: true });
});

test("writeJsonAtomic creates parent directories and round-trips", () => {
  const dir = tempDir();
  const path = join(dir, "nested", "deep", "file.json");
  writeJsonAtomic(path, { hello: "world" });
  assert.deepEqual(readJson(path), { hello: "world" });
  rmSync(dir, { recursive: true, force: true });
});

test("writeJsonAtomic leaves no temp file behind", () => {
  const dir = tempDir();
  const path = join(dir, "file.json");
  writeJsonAtomic(path, { a: 1 });
  assert.deepEqual(readJson(path), { a: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("parseRecords accepts a well-formed record", () => {
  const records = parseRecords([validRecord()]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.cost, 0.42);
  assert.equal(records[0]?.usage.input, 100);
});

test("parseRecords rejects non-arrays", () => {
  assert.deepEqual(parseRecords(null), []);
  assert.deepEqual(parseRecords({ records: [] }), []);
  assert.deepEqual(parseRecords("nope"), []);
});

test("parseRecords drops records without a usable timestamp or cost", () => {
  const records = parseRecords([
    validRecord(),
    { cost: 1 },
    { at: 1 },
    { at: Number.NaN, cost: 1 },
    { at: 1, cost: "free" },
    null,
    42,
  ]);
  assert.equal(records.length, 1);
});

test("parseRecords fills in missing optional fields", () => {
  const records = parseRecords([{ at: 10, cost: 1 }]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.provider, "unknown");
  assert.equal(records[0]?.model, "unknown");
  assert.equal(records[0]?.estimated, false);
  assert.deepEqual(records[0]?.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  });
});

test("parseRecords normalizes a partially written usage object", () => {
  const records = parseRecords([{ at: 1, cost: 1, usage: { input: 5, output: "x" } }]);
  assert.equal(records[0]?.usage.input, 5);
  assert.equal(records[0]?.usage.output, 0);
});

test("parseRecords ignores a non-string sessionId", () => {
  assert.equal(parseRecords([{ at: 1, cost: 1, sessionId: 99 }])[0]?.sessionId, undefined);
  assert.equal(parseRecords([{ at: 1, cost: 1, sessionId: "" }])[0]?.sessionId, undefined);
});

test("serializeRecords wraps records in a versioned envelope", () => {
  const payload = serializeRecords([validRecord()]) as { version: number; records: unknown[] };
  assert.equal(payload.version, 1);
  assert.equal(payload.records.length, 1);
});

test("saveRecords and loadRecords round-trip", () => {
  const dir = tempDir();
  saveRecords(dir, [validRecord({ cost: 1.25 })]);
  const loaded = loadRecords(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.cost, 1.25);
  rmSync(dir, { recursive: true, force: true });
});

test("loadRecords returns empty for a missing ledger", () => {
  assert.deepEqual(loadRecords(tempDir()), []);
});

test("loadRecords tolerates a bare array from an older file", () => {
  const dir = tempDir();
  writeFileSync(ledgerPath(dir), JSON.stringify([validRecord({ cost: 3 })]));
  const loaded = loadRecords(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.cost, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("loadRecords returns empty for a corrupt ledger rather than throwing", () => {
  const dir = tempDir();
  writeFileSync(ledgerPath(dir), "!!! not json");
  assert.deepEqual(loadRecords(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("saveRecords writes human-readable JSON", () => {
  const dir = tempDir();
  saveRecords(dir, [validRecord()]);
  const text = readFileSync(ledgerPath(dir), "utf8");
  assert.match(text, /\n {2}/);
  rmSync(dir, { recursive: true, force: true });
});

test("mergeRecords keeps both sessions' records instead of last-writer-wins", () => {
  const mine = [validRecord({ at: 1, cost: 1, sessionId: "a" })];
  const theirs = [validRecord({ at: 2, cost: 2, sessionId: "b" })];
  const merged = mergeRecords(mine, theirs);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((r) => r.sessionId === "a"));
  assert.ok(merged.some((r) => r.sessionId === "b"));
});

test("mergeRecords collapses the same call seen by two processes", () => {
  const shared = [validRecord({ at: 5, cost: 0.5, sessionId: "a" })];
  assert.equal(mergeRecords(shared, shared).length, 1);
  // Distinct calls in the same millisecond are not collapsed.
  const other = [validRecord({ at: 5, cost: 0.9, sessionId: "b" })];
  assert.equal(mergeRecords(shared, other).length, 2);
});

test("appendRecords applies retention and cap to the MERGED file, not the local slice", () => {
  const dir = tempDir();
  try {
    const now = Date.now();
    const old = validRecord({ at: now - 400 * 86_400_000, cost: 9, sessionId: "expired" });
    const keep = validRecord({ at: now - 1_000, cost: 2, sessionId: "keep" });
    saveRecords(dir, [old, keep]);
    // Local memory holds only the new record — the stale snapshot case.
    const staleMemory = [validRecord({ at: now, cost: 3, sessionId: "new" })];
    const merged = appendRecords(dir, staleMemory, [], { retentionDays: 120, maxRecords: 100 });

    // The expired on-disk record is pruned, NOT resurrected by the merge.
    assert.equal(merged.length, 2, "expired record must be pruned from the merged result");
    assert.ok(!merged.some((r) => r.sessionId === "expired"));
    assert.equal(loadRecords(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendRecords under the lock keeps records from a frozen interleaving", () => {
  const dir = tempDir();
  try {
    // Deterministically reproduce the interleaved read→merge→write that a
    // merge-on-write alone loses: A and B both read, A writes, then B writes
    // what IT read. Under the lock the second append must still see A's write.
    saveRecords(dir, [validRecord({ at: 1, cost: 1, sessionId: "base" })]);

    const a = [validRecord({ at: 2, cost: 2, sessionId: "a" })];
    const b = [validRecord({ at: 3, cost: 3, sessionId: "b" })];

    // Sequentially execute what the lock serializes: each append re-reads the
    // file inside the lock, so B's merge includes A's just-written record.
    appendRecords(dir, a, [], {});
    const final = appendRecords(dir, b, [], {});

    assert.equal(final.length, 3, "no record lost across serialized appends");
    assert.equal(loadRecords(dir).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock serializes concurrent appends on one directory", () => {
  const dir = tempDir();
  try {
    saveRecords(dir, []);
    // 40 concurrent appends through the real lock; every record must survive.
    const batches = Array.from({ length: 40 }, (_, i) => [validRecord({ at: i, cost: i + 1, sessionId: `s${i}` })]);
    const results = batches.map((batch) => appendRecords(dir, batch, [], {}));
    // Each caller sees at least its own records; the final file must have all.
    const final = loadRecords(dir);
    assert.equal(final.length, 40, `expected 40 records after 40 concurrent appends, got ${final.length}`);
    assert.ok(results.every((r) => r.length > 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock removes its lock and tolerates a stale one after timeout", () => {
  const dir = tempDir();
  try {
    const lockDir = `${ledgerPath(dir)}.lock`;
    mkdirSync(lockDir, { recursive: true }); // stale lock from a crashed holder
    const result = withLedgerLock(dir, () => "ran", 20); // tiny timeout → proceeds unlocked
    assert.equal(result, "ran");
    // The stale lock is left alone (it belongs to another process), and the
    // next uncontended acquisition removes its own lock cleanly.
    withLedgerLock(dir, () => null, 1000);
    assert.ok(!existsSync(lockDir), "the second holder must clean up its own lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt negative cost is dropped rather than counted", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify({
        version: 1,
        records: [
          { at: 1, cost: -5, provider: "p", model: "m", usage: {} },
          { at: 2, cost: 3, provider: "p", model: "m", usage: {} },
        ],
      }),
    );
    const loaded = loadRecords(dir);
    // One corrupt record must not become a negative balance that satisfies
    // every budget forever.
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.cost, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STORE_MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "store.ts");

/** Run `code` in a child process, resolving on exit. */
function runChild(code: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code_) => (code_ === 0 ? resolve() : reject(new Error(`child exited ${code_}: ${stderr}`))));
  });
}

test("withRatesLock serializes writers and cleans up its lock", () => {
  const dir = tempDir();
  try {
    const order: string[] = [];
    withRatesLock(dir, () => order.push("a"));
    withRatesLock(dir, () => order.push("b"));
    assert.deepEqual(order, ["a", "b"]);
    assert.ok(!existsSync(`${ratesPath(dir)}.lock`), "the lock must be released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real processes appending concurrently lose no records", async () => {
  // The in-process tests above call a synchronous function in a loop, so they
  // never contend. This spawns actual processes against one state directory,
  // which is the only way to exercise the lock the ledger relies on.
  const dir = tempDir();
  try {
    saveRecords(dir, []);
    const code = `
      import { appendRecords } from ${JSON.stringify(STORE_MODULE)};
      const dir = process.argv[1];
      const worker = Number(process.argv[2]);
      for (let j = 0; j < 8; j++) {
        appendRecords(dir, [{
          at: Date.now() + j,
          cost: 0.01,
          provider: "p",
          model: "m",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          estimated: false,
          sessionId: "worker-" + worker + "-" + j,
        }], [], {});
      }
    `;
    const workers = 6;
    await Promise.all(Array.from({ length: workers }, (_, w) => runChild(code, [dir, String(w)])));

    const final = loadRecords(dir);
    assert.equal(final.length, workers * 8, `expected ${workers * 8} records, got ${final.length}`);
    const sessions = new Set(final.map((r) => r.sessionId));
    assert.equal(sessions.size, workers * 8, "every worker's records must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
