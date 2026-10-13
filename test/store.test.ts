import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  ledgerPath,
  loadRecords,
  parseRecords,
  readJson,
  resolveAgentDir,
  resolveStateDir,
  saveRecords,
  serializeRecords,
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
