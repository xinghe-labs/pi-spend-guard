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
 * Providers whose published price is the model's own list price.
 *
 * A model id published by several providers is ambiguous; one of these winning
 * means the first-party price was chosen rather than a reseller's.
 */
const FIRST_PARTY = new Set([
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "google-ai-studio",
  "deepseek",
  "zai",
  "moonshotai",
  "moonshot",
  "mistral",
  "xai",
  "meta",
  "alibaba",
  "qwen",
  "amazon-bedrock",
  "azure",
  "cohere",
  "perplexity",
]);

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
  return [...new Set(out)];
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

  for (const [providerId, providerValue] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;
    const models = (providerValue as Record<string, unknown>)["models"];
    if (typeof models !== "object" || models === null) continue;
    const provider = normalize(providerId);

    for (const [modelId, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (typeof modelValue !== "object" || modelValue === null) continue;
      const cost = (modelValue as Record<string, unknown>)["cost"];
      if (typeof cost !== "object" || cost === null) continue;
      const c = cost as Record<string, unknown>;

      const input = positive(c["input"]);
      const output = positive(c["output"]);
      if (input === undefined && output === undefined) continue;

      const rate: RemoteRate = {
        input: input ?? 0,
        output: output ?? 0,
        ...(positive(c["cache_read"]) !== undefined ? { cacheRead: positive(c["cache_read"]) } : {}),
        ...(positive(c["cache_write"]) !== undefined ? { cacheWrite: positive(c["cache_write"]) } : {}),
      };
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
    const firstParty = bucket.find((entry) => FIRST_PARTY.has(entry.provider));
    if (firstParty) return firstParty.rate;
    // Ambiguous across non-first-party providers: no rate is better than a
    // wrong one. The model is reported as unpriced and the user can pin it
    // with a `pricing` entry.
    return undefined;
  }
  return undefined;
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
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const fetchedAt = positive(obj["fetchedAt"]);
  const entries = obj["entries"];
  if (fetchedAt === undefined || typeof entries !== "object" || entries === null) return undefined;

  const byProviderModel = new Map<string, RemoteRate>();
  const byModel = new Map<string, Array<{ provider: string; rate: RemoteRate }>>();
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
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
    byProviderModel.set(key, rate);

    const modelId = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
    const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : "";
    const bucket = byModel.get(modelId);
    if (bucket) bucket.push({ provider, rate });
    else byModel.set(modelId, [{ provider, rate }]);
  }

  return {
    fetchedAt,
    source: typeof obj["source"] === "string" ? obj["source"] : "cache",
    byProviderModel,
    byModel,
  };
}
