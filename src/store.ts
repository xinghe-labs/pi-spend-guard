/**
 * Durable state: the config file and the spend ledger.
 *
 * Writes are atomic (temp file + rename) so a crash or a full disk cannot leave
 * a truncated ledger behind. Reads are defensive: a hand-edited or corrupt file
 * degrades to "no records" instead of taking the session down.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SpendRecord, TokenUsage } from "./types.ts";

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
