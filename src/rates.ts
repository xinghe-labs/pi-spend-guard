/**
 * Rates from a published price list (models.dev by default).
 *
 * Pure functions only — parsing, indexing, matching, staleness. Fetching and
 * caching live in `extension.ts`/`store.ts` so this module stays testable
 * without a network or a filesystem.
 *
 * This source exists because the two offline sources fail together: the config
 * `pricing` table is empty on a fresh install, and the model catalog is empty
 * for local gateways, resellers, and unlisted models. A guard with no rate
 * silently never fires, so a zero-config fallback is the difference between
 * "installed" and "actually protecting you".
 *
 * Matching is deliberately conservative. A wrong price is worse than no price:
 * no price is reported as `unpriced` and the user is told, while a wrong price
 * quietly miscounts every budget forever. So an ambiguous model id yields no
 * rate unless a first-party provider can be identified.
 */
import type { ModelRates } from "./ledger.ts";

/** One model's rates, as published in the remote list. */
export interface RemoteRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * A parsed price list plus the indexes matching needs.
 *
 * `byProviderModel` serves exact lookups; `byModel` maps a bare model id to
 * every provider that publishes it, so ambiguity can be detected rather than
 * silently resolved.
 */
export interface RatesSnapshot {
  fetchedAt: number;
  /** Where the snapshot came from, for reporting and debugging. */
  source: string;
  byProviderModel: Map<string, RemoteRate>;
  byModel: Map<string, Array<{ provider: string; rate: RemoteRate }>>;
}

/**
 * Providers whose published price is the model's own list price, most
 * authoritative first.
 *
 * Order matters and is deliberate: a model id published by several providers is
 * ambiguous, so the winner is chosen by rank rather than by whichever entry
 * happens to come first in the payload (which would change on the next refresh
 * with no signal). Model owners outrank hosting platforms that also publish
 * prices for other vendors' models — `azure` and `amazon-bedrock` are not the
 * first party for an OpenAI or Anthropic model.
 */
const FIRST_PARTY_RANK: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "zai",
  "moonshotai",
  "moonshot",
  "mistral",
  "xai",
  "meta",
  "qwen",
  "alibaba",
  // Hosting platforms: they publish prices for models they do not own, so they
  // rank below every model owner above.
  "google-vertex",
  "google-ai-studio",
  "azure",
  "amazon-bedrock",
  "cohere",
  "perplexity",
];

const FIRST_PARTY = new Set(FIRST_PARTY_RANK);

/**
 * Highest rate (USD per million tokens) accepted from a published list.
 *
 * The list is the only external input the guard trusts, and a poisoned or
 * broken one can do real damage: the pre-flight projection prices the next
 * request from these numbers and aborts it, and the resulting cost is written
 * to the ledger for the whole retention window. A units change at the source
 * (per-1k instead of per-Mtok) is a 1000× error. Anything above this ceiling is
 * treated as garbage rather than as a price.
 */
export const MAX_PLAUSIBLE_RATE = 10_000;

function positive(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value > MAX_PLAUSIBLE_RATE) return undefined;
  return value;
}

/**
 * A finite, non-negative number with no magnitude ceiling.
 *
 * Timestamps must not go through `positive`: an epoch-millisecond value is
 * larger than any plausible per-million-token rate, so the ceiling would reject
 * every real `fetchedAt` and silently make every cache unreadable.
 */
function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Model-id candidates to try against the bare-id index, most specific first.
 *
 * Gateways commonly prefix a model with their own namespace — `global:glm-5.3`,
 * `openai/gpt-5` — so the published id is the segment after the separator. The
 * full id is tried first because some published ids legitimately contain a
 * slash (`deepseek-ai/DeepSeek-V4.1-Flash`).
 */
function idCandidates(modelId: string): string[] {
  const normalized = normalize(modelId);
  const out = [normalized];
  const afterColon = normalized.split(":").pop();
  if (afterColon && afterColon !== normalized) out.push(afterColon);
  const afterSlash = normalized.split("/").pop();
  if (afterSlash && afterSlash !== normalized) out.push(afterSlash);
  // A purely numeric tail is a version suffix, not a model id (Bedrock-style
  // `…-v1:0`), so looking it up would only ever match the wrong model.
  return [...new Set(out)].filter((candidate) => candidate !== "" && !/^\d+$/.test(candidate));
}

/**
 * Read a published cost block.
 *
 * Returns the rate, `undefined` when the block publishes no price at all, or
 * `"implausible"` when a field is present but outside the accepted range.
 * Partial trust is not an option: accepting `{ input: 1e9, output: 5 }` as
 * `input: 0` would under-count input, which delays enforcement — the dangerous
 * direction for a spend guard.
 */
function readRate(c: Record<string, unknown>): RemoteRate | "implausible" | undefined {
  const keys = ["input", "output", "cache_read", "cache_write"] as const;
  const values: Record<string, number | undefined> = {};
  let anyPresent = false;

  for (const key of keys) {
    const raw = c[key];
    if (raw === undefined || raw === null) continue;
    anyPresent = true;
    const parsed = positive(raw);
    if (parsed === undefined) return "implausible";
    values[key] = parsed;
  }

  if (!anyPresent) return undefined;
  const input = values["input"];
  const output = values["output"];
  if (input === undefined && output === undefined) return undefined;

  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(values["cache_read"] !== undefined ? { cacheRead: values["cache_read"] } : {}),
    ...(values["cache_write"] !== undefined ? { cacheWrite: values["cache_write"] } : {}),
  };
}

/**
 * Parse models.dev's `api.json` (or anything with the same shape) into indexes.
 *
 * Entries with no usable rate are dropped rather than indexed as zero, because
 * a zero-rate entry would shadow nothing useful and is indistinguishable from
 * an absent one.
 */
export function parseRatesSnapshot(raw: unknown, source: string, fetchedAt: number): RatesSnapshot {
  const byProviderModel = new Map<string, RemoteRate>();
  const byModel = new Map<string, Array<{ provider: string; rate: RemoteRate }>>();

  if (typeof raw !== "object" || raw === null) {
    return { fetchedAt, source, byProviderModel, byModel };
  }

  // Counted so a payload full of implausible numbers can be rejected wholesale
  // instead of quietly pricing a few models and dropping the rest.
  let rejected = 0;

  for (const [providerId, providerValue] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;
    const models = (providerValue as Record<string, unknown>)["models"];
    if (typeof models !== "object" || models === null) continue;
    const provider = normalize(providerId);

    for (const [modelId, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (typeof modelValue !== "object" || modelValue === null) continue;
      const cost = (modelValue as Record<string, unknown>)["cost"];
      if (typeof cost !== "object" || cost === null) continue;

      const rate = readRate(cost as Record<string, unknown>);
      if (rate === "implausible") {
        rejected++;
        continue;
      }
      if (rate === undefined) continue;
      // A published entry of all zeros prices nothing; indexing it would only
      // make `lookupRemoteRates` return an unusable rate.
      if (rate.input === 0 && rate.output === 0 && !rate.cacheRead && !rate.cacheWrite) continue;

      const key = `${provider}/${normalize(modelId)}`;
      byProviderModel.set(key, rate);
      const bucket = byModel.get(normalize(modelId));
      if (bucket) bucket.push({ provider, rate });
      else byModel.set(normalize(modelId), [{ provider, rate }]);
    }
  }

  // More rejected than accepted means the payload's units or shape are wrong,
  // not that a few models are exotic. Refusing it wholesale keeps the previous
  // snapshot in place rather than pricing from garbage.
  if (rejected > byProviderModel.size) {
    return { fetchedAt, source, byProviderModel: new Map(), byModel: new Map() };
  }

  return { fetchedAt, source, byProviderModel, byModel };
}

/**
 * Rates for a model from the snapshot, or `undefined` when it cannot be
 * determined confidently.
 *
 * Order: exact `provider/model`, then the bare model id (so a gateway prefix
 * does not hide a published price). A bare id published by several providers is
 * only used when a first-party provider is among them; otherwise the model
 * stays unpriced rather than being assigned a reseller's guess.
 */
export function lookupRemoteRates(
  snapshot: RatesSnapshot | undefined,
  provider: string | undefined,
  modelId: string | undefined,
): RemoteRate | undefined {
  if (!snapshot) return undefined;

  if (provider && modelId) {
    const exact = snapshot.byProviderModel.get(`${normalize(provider)}/${normalize(modelId)}`);
    if (exact) return exact;
  }
  if (!modelId) return undefined;

  for (const candidate of idCandidates(modelId)) {
    const bucket = snapshot.byModel.get(candidate);
    if (!bucket || bucket.length === 0) continue;
    if (bucket.length === 1) return bucket[0]?.rate;

    // The provider the call actually came through is the best evidence
    // available: if it publishes this id, its own number describes this setup.
    if (provider) {
      const own = bucket.find((entry) => entry.provider === normalize(provider));
      if (own) return own.rate;
    }

    // Otherwise pick by rank (model owner before hosting platform), and break
    // ties by name so the choice is stable across refreshes instead of
    // following payload key order.
    const ranked = [...bucket].sort((a, b) => {
      const ra = rank(a.provider);
      const rb = rank(b.provider);
      if (ra !== rb) return ra - rb;
      return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
    });
    const best = ranked[0];
    if (best && FIRST_PARTY.has(best.provider)) return best.rate;
    // Ambiguous across non-first-party providers: no rate is better than a
    // wrong one. The model is reported as unpriced and the user can pin it
    // with a `pricing` entry.
    return undefined;
  }
  return undefined;
}

/** Rank of a provider in the first-party preference order; unranked sorts last. */
function rank(provider: string): number {
  const index = FIRST_PARTY_RANK.indexOf(provider);
  return index === -1 ? FIRST_PARTY_RANK.length : index;
}

/** Convert a remote entry into the guard's internal rates shape. */
export function remoteToRates(rate: RemoteRate): ModelRates {
  // Cache rates fall back to the input rate for the same reason the config
  // table does: under-counting cache tokens lets a budget slip past.
  return {
    input: rate.input,
    output: rate.output,
    cacheRead: rate.cacheRead ?? rate.input,
    cacheWrite: rate.cacheWrite ?? rate.input,
  };
}

/** True when the snapshot is older than the cache lifetime. */
export function snapshotIsStale(snapshot: RatesSnapshot | undefined, ttlMs: number, now: number): boolean {
  if (!snapshot) return true;
  if (!Number.isFinite(snapshot.fetchedAt)) return true;
  return now - snapshot.fetchedAt > ttlMs;
}

/** Serialize a snapshot for the on-disk cache. */
export function serializeSnapshot(snapshot: RatesSnapshot): unknown {
  return {
    version: 1,
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
    entries: Object.fromEntries(snapshot.byProviderModel),
  };
}

/** Rebuild a snapshot from the on-disk cache, or `undefined` if unusable. */
export function deserializeSnapshot(raw: unknown): RatesSnapshot | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  // A cache written by a different format version must not be trusted: its
  // inner fields may mean something else, and silently reading it as empty
  // would disable the published list for a whole TTL with no message.
  if (obj["version"] !== 1) return undefined;
  const fetchedAt = finiteNonNegative(obj["fetchedAt"]);
  const entries = obj["entries"];
  if (fetchedAt === undefined) return undefined;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return undefined;

  const byProviderModel = new Map<string, RemoteRate>();
  const byModel = new Map<string, Array<{ provider: string; rate: RemoteRate }>>();
  for (const [rawKey, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const input = positive(v["input"]);
    const output = positive(v["output"]);
    if (input === undefined && output === undefined) continue;
    const rate: RemoteRate = {
      input: input ?? 0,
      output: output ?? 0,
      ...(positive(v["cacheRead"]) !== undefined ? { cacheRead: positive(v["cacheRead"]) } : {}),
      ...(positive(v["cacheWrite"]) !== undefined ? { cacheWrite: positive(v["cacheWrite"]) } : {}),
    };
    // Normalize on the way in, exactly as the network path does: a cache this
    // code did not write (hand-edited, or from another tool) would otherwise be
    // unreachable, since lookups always normalize their key.
    const key = normalize(rawKey);
    byProviderModel.set(key, rate);

    const slash = key.indexOf("/");
    const modelId = slash === -1 ? key : key.slice(slash + 1);
    const provider = slash === -1 ? "" : key.slice(0, slash);
    const bucket = byModel.get(modelId);
    if (bucket) bucket.push({ provider, rate });
    else byModel.set(modelId, [{ provider, rate }]);
  }

  // An empty index is not a usable snapshot: accepting it would look fresh and
  // suppress the refresh that would have filled it.
  if (byProviderModel.size === 0) return undefined;

  return {
    fetchedAt,
    source: typeof obj["source"] === "string" ? obj["source"] : "cache",
    byProviderModel,
    byModel,
  };
}
