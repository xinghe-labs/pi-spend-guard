/**
 * Durable state: the config file and the spend ledger.
 *
 * Writes are atomic (temp file + rename) so a crash or a full disk cannot leave
 * a truncated ledger behind. Reads are defensive: a hand-edited or corrupt file
 * degrades to "no records" instead of taking the session down.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RateSourceName, SpendRecord, TokenUsage } from "./types.ts";
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

/** Where the cached remote price list lives. */
export function ratesPath(dir: string): string {
  return join(dir, "rates-cache.json");
}

/**
 * Marker recording when the ledger was last cleared.
 *
 * `/budget reset` cannot be made durable by locking alone: another live session
 * holds its records in memory and re-merges them on its next write, so the
 * erased records come back. A timestamp is observed by every writer instead —
 * anything recorded at or before it is dropped, whoever writes it.
 */
export function clearedAtPath(dir: string): string {
  return join(dir, "ledger-cleared-at");
}

/** When the ledger was last cleared, or 0 if never. */
export function readClearedAt(dir: string): number {
  try {
    const value = Number(readFileSync(clearedAtPath(dir), "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Record that the ledger was cleared at `at`. */
export function writeClearedAt(dir: string, at: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(clearedAtPath(dir), `${at}\n`, "utf8");
}

/** Drop records that predate the last clear. */
function afterClear(records: readonly SpendRecord[], clearedAt: number): SpendRecord[] {
  if (clearedAt <= 0) return [...records];
  return records.filter((record) => record.at > clearedAt);
}

/**
 * Remove temp files a crash left behind between write and rename.
 *
 * Best-effort and only for files older than a minute, so a concurrent writer's
 * in-flight temp file is never deleted. Called from the lock's acquisition path
 * where the directory is already being touched.
 */
export function sweepTempFiles(dir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tmp")) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true });
      } catch {
        // Raced with another sweep or the owner; nothing to do.
      }
    }
  } catch {
    // The directory may not exist yet.
  }
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

/** The four rates stored on an estimated record, when they are usable. */
function parseRatesUsed(raw: unknown): { ratesUsed: { input: number; output: number; cacheRead: number; cacheWrite: number } } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const input = finiteNumber(source["input"]);
  const output = finiteNumber(source["output"]);
  const cacheRead = finiteNumber(source["cacheRead"]);
  const cacheWrite = finiteNumber(source["cacheWrite"]);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return undefined;
  if (input < 0 || output < 0 || cacheRead < 0 || cacheWrite < 0) return undefined;
  return { ratesUsed: { input, output, cacheRead, cacheWrite } };
}

/** True for a rate-source name this version understands. */
function isRateSourceName(value: unknown): value is RateSourceName {
  return value === "config" || value === "catalog" || value === "models.dev";
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
    // A negative cost is corrupt, not a refund: a single hand-edited record
    // could otherwise cancel out real spend and make every budget look
    // satisfied. Dropped for the same reason a non-finite one is.
    if (cost < 0) continue;

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
      // Additive in the same way: an older ledger simply has no source.
      ...(isRateSourceName(source["rateSource"]) ? { rateSource: source["rateSource"] } : {}),
      ...(typeof source["rateKey"] === "string" && source["rateKey"] !== ""
        ? { rateKey: source["rateKey"] }
        : {}),
      ...(finiteNumber(source["ratesFetchedAt"]) !== null
        ? { ratesFetchedAt: finiteNumber(source["ratesFetchedAt"]) as number }
        : {}),
      ...(parseRatesUsed(source["ratesUsed"]) ?? {}),
      usage: parseUsage(source["usage"]),
    });
  }
  return out;
}

/** Ledger file payload. Versioned so the format can change later without guessing. */
export function serializeRecords(records: readonly SpendRecord[]): unknown {
  return { version: 1, records: [...records] };
}

/** Read the ledger file from `dir`, honouring the last clear. */
export function loadRecords(dir: string): SpendRecord[] {
  const raw = readJson(ledgerPath(dir));
  if (raw === null) return [];
  // Accept both the versioned envelope and a bare array.
  const parsed = Array.isArray(raw)
    ? parseRecords(raw)
    : parseRecords((raw as Record<string, unknown>)["records"]);
  return afterClear(parsed, readClearedAt(dir));
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
 *
 * Cost is deliberately NOT part of the key: it is derived from the rates, so
 * the same call can be written once unpriced and once priced. Keying on cost
 * would keep both and double-count.
 */
function recordKey(record: SpendRecord): string {
  const u = record.usage;
  return [
    record.at,
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
  const index = new Map<string, number>();
  const out: SpendRecord[] = [];
  for (const record of [...base, ...incoming]) {
    const key = recordKey(record);
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, out.length);
      out.push(record);
      continue;
    }
    // Same call seen twice. A known price beats an unknown one, so an
    // unpriced copy can never shadow a priced one — that is what makes
    // re-pricing a record idempotent instead of a double count.
    const current = out[existing];
    if (current?.unpriced === true && record.unpriced !== true) out[existing] = record;
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
  return withFileLock(`${ledgerPath(dir)}.lock`, fn, timeoutMs);
}

/**
 * Serialize a callback while holding an exclusive lock on the rates cache.
 *
 * The cache is written by whichever session refreshed it; without a lock two
 * sessions finishing at once can interleave and persist the older snapshot.
 * Reads never take this lock, so enforcement stays lock-free.
 */
export function withRatesLock<T>(dir: string, fn: () => T, timeoutMs = 10_000): T {
  return withFileLock(`${ratesPath(dir)}.lock`, fn, timeoutMs);
}

/**
 * How long a lock may sit before a contender treats it as abandoned.
 *
 * Much shorter than the retry budget on purpose: the retry loop sleeps with a
 * synchronous `Atomics.wait`, so a lock left by a SIGKILLed session would
 * otherwise freeze the whole process — UI, timers and all — for the full
 * budget.
 *
 * The critical section is a merge of at most `MAX_RECORDS` records (tens of
 * milliseconds in practice), so two seconds is generous for a live holder.
 * It is still a heuristic: a process suspended mid-merge, or a pathologically
 * slow filesystem, could exceed it. The consequence is bounded but real — the
 * robbed holder's write can be lost, and it is only recovered if that process
 * persists again. Making the wait asynchronous and bounding the section is the
 * durable fix; this is the honest trade for now.
 */
const STALE_LOCK_MS = 2_000;

/** The lock itself: an atomic `mkdir`, a bounded retry, and stale-lock stealing. */
function withFileLock<T>(lockDir: string, fn: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let token: string | undefined;
  // The state directory may not exist yet (first persist creates it); make
  // sure the lock's parent does, or mkdir would fail with ENOENT and look
  // like a contention error.
  mkdirSync(dirname(lockDir), { recursive: true });
  sweepTempFiles(dirname(lockDir));
  for (;;) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      // Tag the lock with an owner token. If our lock is later stolen (the
      // stale path below), the thief replaces this file; checking the token
      // before cleanup stops a robbed holder from deleting the THIEF's live
      // lock, which would let a third process in mid-write.
      //
      // The token is only recorded once it is on disk: if the write fails, the
      // release path must fall back to removing the directory rather than
      // reading back a token that was never written and leaving the lock behind.
      const candidate = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        writeFileSync(join(lockDir, "owner"), candidate, "utf8");
        token = candidate;
      } catch {
        token = undefined;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;
      // A lock older than the staleness threshold is treated as abandoned.
      // Leaving it would permanently degrade every future write to unlocked
      // mode, so it is stolen — but ATOMICALLY: `rename` succeeds for exactly
      // one contender, so two processes that both judge the lock stale cannot
      // both end up holding it (a plain remove-then-create could).
      if (Date.now() >= deadline || isStaleLock(lockDir, STALE_LOCK_MS)) {
        const graveyard = `${lockDir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(lockDir, graveyard);
          rmSync(graveyard, { recursive: true, force: true });
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
      // delete its successor's live lock. Without a token (the write failed)
      // the directory is ours by construction, so remove it.
      let stillOurs = token === undefined;
      if (token !== undefined) {
        try {
          stillOurs = readFileSync(join(lockDir, "owner"), "utf8") === token;
        } catch {
          stillOurs = false;
        }
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
    const clearedAt = readClearedAt(dir);
    // A live session that still holds records from before a `/budget reset`
    // re-merges them here; dropping them again is what makes the reset durable.
    const merged = afterClear(mergeRecords(loadRecords(dir), [...records, ...incoming]), clearedAt);
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
