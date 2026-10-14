/**
 * Durable state: the config file and the spend ledger.
 *
 * Writes are atomic (temp file + rename) so a crash or a full disk cannot leave
 * a truncated ledger behind. Reads are defensive: a hand-edited or corrupt file
 * degrades to "no records" instead of taking the session down.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SpendRecord, TokenUsage } from "./types.ts";
import { capRecords, prune } from "./ledger.ts";

/** Directory pi uses for agent state, honouring `PI_CODING_AGENT_DIR`. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["PI_CODING_AGENT_DIR"];
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  return join(homedir(), ".pi", "agent");
}

/** Where pi-spend-guard keeps its own files. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentDir(env), "pi-spend-guard");
}

export function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function ledgerPath(dir: string): string {
  return join(dir, "ledger.json");
}

/** Read and parse JSON. Missing, unreadable, or corrupt files yield `null`. */
export function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Write JSON via a temp file plus rename, so readers never see a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsage(raw: unknown): TokenUsage {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    input: finiteNumber(source["input"]) ?? 0,
    output: finiteNumber(source["output"]) ?? 0,
    cacheRead: finiteNumber(source["cacheRead"]) ?? 0,
    cacheWrite: finiteNumber(source["cacheWrite"]) ?? 0,
    totalTokens: finiteNumber(source["totalTokens"]) ?? 0,
  };
}

/**
 * Coerce a parsed ledger file into records.
 *
 * A record needs a finite timestamp and cost to be meaningful; anything else is
 * dropped rather than defaulted, because a wrong cost silently corrupts every
 * budget decision that follows.
 */
export function parseRecords(raw: unknown): SpendRecord[] {
  if (!Array.isArray(raw)) return [];

  const out: SpendRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const source = item as Record<string, unknown>;

    const at = finiteNumber(source["at"]);
    const cost = finiteNumber(source["cost"]);
    if (at === null || cost === null) continue;

    const sessionId = source["sessionId"];
    out.push({
      at,
      cost,
      sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined,
      provider: typeof source["provider"] === "string" ? source["provider"] : "unknown",
      model: typeof source["model"] === "string" ? source["model"] : "unknown",
      estimated: source["estimated"] === true,
      // Only stored when true: an absent flag means "not known to be unpriced",
      // which keeps ledgers written before this field existed readable.
      ...(source["unpriced"] === true ? { unpriced: true } : {}),
      usage: parseUsage(source["usage"]),
    });
  }
  return out;
}

/** Ledger file payload. Versioned so the format can change later without guessing. */
export function serializeRecords(records: readonly SpendRecord[]): unknown {
  return { version: 1, records: [...records] };
}

/** Read the ledger file from `dir`. */
export function loadRecords(dir: string): SpendRecord[] {
  const raw = readJson(ledgerPath(dir));
  if (raw === null) return [];
  // Accept both the versioned envelope and a bare array.
  if (Array.isArray(raw)) return parseRecords(raw);
  return parseRecords((raw as Record<string, unknown>)["records"]);
}

/** Persist the ledger file into `dir`. */
export function saveRecords(dir: string, records: readonly SpendRecord[]): void {
  writeJsonAtomic(ledgerPath(dir), serializeRecords(records));
}

/**
 * Identity of a ledger record for deduplication.
 *
 * Includes the full token breakdown, not just the total: two distinct calls to
 * the same model can finish in the same millisecond with the same total token
 * count, and unpriced calls all carry cost 0 — a coarser key would collapse
 * them and undercount daily/monthly spend forever.
 */
function recordKey(record: SpendRecord): string {
  const u = record.usage;
  return [
    record.at,
    record.cost,
    record.provider,
    record.model,
    u.input,
    u.output,
    u.cacheRead,
    u.cacheWrite,
    record.sessionId ?? "",
  ].join("|");
}

/**
 * Deduplicate two record lists into one, preserving encounter order.
 *
 * Concurrent pi sessions each hold a snapshot of the ledger; merging on save
 * means a session re-adding records it already holds cannot resurrect or
 * duplicate anything. Order is the caller's insertion order (base first), NOT
 * sorted by time — `capRecords` relies on append order when it keeps the tail.
 */
export function mergeRecords(
  base: readonly SpendRecord[],
  incoming: readonly SpendRecord[],
): SpendRecord[] {
  const seen = new Set<string>();
  const out: SpendRecord[] = [];
  for (const record of [...base, ...incoming]) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/**
 * Serialize a callback while holding an exclusive lock on the ledger.
 *
 * Merge-on-write alone cannot stop two processes from interleaving
 * read→merge→write and dropping each other's new records; the lock closes
 * that window. Acquisition is an atomic `mkdir` (atomic on local filesystems,
 * unlike check-then-create) with bounded retries — on timeout we proceed
 * UNLOCKED rather than fail, because a lost update is recoverable (the holder
 * re-adds its records on the next persist) while a permanently blocked
 * provider request is not. Every failure path removes the lock; a crash
 * between acquire and release leaves a stale lock that only costs the next
 * contender its retry budget, not correctness.
 */
export function withLedgerLock<T>(dir: string, fn: () => T, timeoutMs = 10_000): T {
  const lockDir = `${ledgerPath(dir)}.lock`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let token: string | undefined;
  // The state directory may not exist yet (first persist creates it); make
  // sure the lock's parent does, or mkdir would fail with ENOENT and look
  // like a contention error.
  mkdirSync(dirname(ledgerPath(dir)), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      // Tag the lock with an owner token. If our lock is later stolen (the
      // stale path below), the thief replaces this file; checking the token
      // before cleanup stops a robbed holder from deleting the THIEF's live
      // lock, which would let a third process in mid-write.
      token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        writeFileSync(join(lockDir, "owner"), token, "utf8");
      } catch {
        // A tag failure must not lose the lock we already hold.
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;
      // A lock older than the whole retry budget cannot belong to a live
      // holder (a legitimate holder finishes a merge in milliseconds and
      // never waits this long to acquire). Leaving it would permanently
      // degrade every future write to unlocked mode, so steal it: the worst
      // case is the same unlocked write we were about to do anyway.
      if (Date.now() >= deadline || isStaleLock(lockDir, timeoutMs)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Someone else stole it first; loop and try to acquire.
        }
        if (Date.now() >= deadline) break;
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      // Only remove the lock if it is still OURS — a stolen holder must not
      // delete its successor's live lock.
      let stillOurs = false;
      try {
        stillOurs = readFileSync(join(lockDir, "owner"), "utf8") === token;
      } catch {
        stillOurs = false;
      }
      if (stillOurs) rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

/** True when the lock directory has existed longer than `ageMs`. */
function isStaleLock(lockDir: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > ageMs;
  } catch {
    return false; // vanished: treat as live contention and retry
  }
}

/** Options for `appendRecords`. */
export interface AppendOptions {
  /** Drop records older than this many days (retention window). */
  retentionDays?: number;
  /** Keep at most this many records, dropping the oldest (append order). */
  maxRecords?: number;
}

/**
 * Append records to the ledger file without dropping concurrent sessions' writes.
 *
 * Runs under the ledger lock: re-reads the file, merges, applies retention and
 * the record cap to the MERGED result (applying them before the merge would
 * let the merge resurrect exactly what was pruned, since the on-disk file
 * still contains it), and writes back atomically. Every branch of the prune/
 * cap application is inside the lock, so concurrent sessions cannot re-grow
 * the file past the cap by merging their own capped slices.
 *
 * Returns the merged, pruned, capped list for the caller to adopt as its
 * in-memory state. Best-effort: on any error the on-disk file is untouched and
 * the caller keeps its own records.
 */
export function appendRecords(
  dir: string,
  records: readonly SpendRecord[],
  incoming: readonly SpendRecord[],
  options: AppendOptions = {},
): SpendRecord[] {
  return withLedgerLock(dir, () => {
    const merged = mergeRecords(loadRecords(dir), [...records, ...incoming]);
    let result = merged;
    if (options.retentionDays !== undefined || options.maxRecords !== undefined) {
      result = capRecords(
        prune(merged, options.retentionDays ?? Number.POSITIVE_INFINITY, Date.now()),
        options.maxRecords ?? Number.POSITIVE_INFINITY,
      );
    }
    saveRecords(dir, result);
    return result;
  });
}
