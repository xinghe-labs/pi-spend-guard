/**
 * Configuration loading, validation, and normalization.
 *
 * User config files are hand-edited, so every field is treated as untrusted and
 * coerced into a complete {@link BudgetConfig}. Unknown keys are ignored and
 * malformed values fall back to the default rather than throwing at startup.
 */
import type {
  BudgetConfig,
  BudgetLimits,
  BudgetScope,
  BudgetThresholds,
  DowngradePolicy,
  NotifyPolicy,
} from "./types.ts";
import { SCOPE_ORDER } from "./policy.ts";

export const DEFAULT_CONFIG: BudgetConfig = {
  enabled: true,
  limits: {
    session: { warn: 2, downgrade: 5, block: 10 },
    daily: { warn: 10, downgrade: 25, block: 50 },
    monthly: { warn: 100, downgrade: 250, block: 500 },
  },
  downgrade: {
    enabled: true,
    model: null,
    preferProviders: [],
  },
  block: { enabled: true },
  notify: {
    onWarn: true,
    onDowngrade: true,
    onBlock: true,
  },
  retentionDays: 120,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or `null` when the value is absent or unusable. */
function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function normalizeThresholds(raw: unknown, fallback: BudgetThresholds | undefined): BudgetThresholds | undefined {
  if (!isPlainObject(raw)) return fallback;

  const out: BudgetThresholds = {};
  for (const key of ["warn", "downgrade", "block"] as const) {
    if (!(key in raw)) {
      // Inherit the default for keys the user did not mention.
      const inherited = fallback?.[key];
      if (inherited !== undefined) out[key] = inherited;
      continue;
    }
    // An explicit null disables this threshold.
    out[key] = raw[key] === null ? null : optionalNumber(raw[key]);
  }
  return out;
}

function normalizeLimits(raw: unknown): BudgetLimits {
  const defaults = DEFAULT_CONFIG.limits;
  if (!isPlainObject(raw)) {
    // Deep copy: a shallow `{ ...defaults }` would let callers mutate
    // DEFAULT_CONFIG through the returned object.
    return {
      session: defaults.session ? { ...defaults.session } : undefined,
      daily: defaults.daily ? { ...defaults.daily } : undefined,
      monthly: defaults.monthly ? { ...defaults.monthly } : undefined,
    };
  }

  const out: BudgetLimits = {};
  for (const scope of SCOPE_ORDER) {
    if (!(scope in raw)) {
      const inherited = defaults[scope];
      // Copy: never hand out a reference into DEFAULT_CONFIG, or a caller
      // mutating the result would poison every later load.
      if (inherited !== undefined) out[scope] = { ...inherited };
      continue;
    }
    // An explicit `null` disables the scope entirely; omitting the key inherits it.
    if (raw[scope] === null) continue;
    const normalized = normalizeThresholds(raw[scope], defaults[scope]);
    if (normalized !== undefined) out[scope] = normalized;
  }
  return out;
}

function normalizeDowngrade(raw: unknown): DowngradePolicy {
  const defaults = DEFAULT_CONFIG.downgrade;
  if (!isPlainObject(raw)) return { ...defaults, preferProviders: [] };

  const model = typeof raw["model"] === "string" && raw["model"].trim() !== "" ? raw["model"].trim() : null;
  return {
    enabled: booleanOr(raw["enabled"], defaults.enabled),
    model,
    preferProviders: stringArray(raw["preferProviders"]),
  };
}

function normalizeNotify(raw: unknown): NotifyPolicy {
  const defaults = DEFAULT_CONFIG.notify;
  if (!isPlainObject(raw)) return { ...defaults };
  return {
    onWarn: booleanOr(raw["onWarn"], defaults.onWarn),
    onDowngrade: booleanOr(raw["onDowngrade"], defaults.onDowngrade),
    onBlock: booleanOr(raw["onBlock"], defaults.onBlock),
  };
}

/** Coerce arbitrary parsed JSON into a complete, usable config. */
export function normalizeConfig(raw: unknown): BudgetConfig {
  if (!isPlainObject(raw)) {
    return structuredCloneConfig(DEFAULT_CONFIG);
  }

  const retention = optionalNumber(raw["retentionDays"]);
  return {
    enabled: booleanOr(raw["enabled"], DEFAULT_CONFIG.enabled),
    limits: normalizeLimits(raw["limits"]),
    downgrade: normalizeDowngrade(raw["downgrade"]),
    block: isPlainObject(raw["block"])
      ? { enabled: booleanOr((raw["block"] as Record<string, unknown>)["enabled"], true) }
      : { ...DEFAULT_CONFIG.block },
    notify: normalizeNotify(raw["notify"]),
    retentionDays: retention !== null && retention > 0 ? Math.floor(retention) : DEFAULT_CONFIG.retentionDays,
  };
}

/** Parse a config file's text. Throws only on invalid JSON; shape errors are tolerated. */
export function parseConfig(text: string): BudgetConfig {
  return normalizeConfig(JSON.parse(text));
}

function structuredCloneConfig(config: BudgetConfig): BudgetConfig {
  return {
    enabled: config.enabled,
    limits: {
      session: config.limits.session ? { ...config.limits.session } : undefined,
      daily: config.limits.daily ? { ...config.limits.daily } : undefined,
      monthly: config.limits.monthly ? { ...config.limits.monthly } : undefined,
    },
    downgrade: { ...config.downgrade, preferProviders: [...config.downgrade.preferProviders] },
    block: { ...config.block },
    notify: { ...config.notify },
    retentionDays: config.retentionDays,
  };
}

/**
 * Apply `key=value` overrides from the command line.
 *
 * Supported keys: `enabled`, `block`, `<scope>.<threshold>` (e.g.
 * `daily.block=20`), `downgrade.model`, and `downgrade.enabled`.
 * Unrecognized keys are returned in `unknown` so the caller can report them.
 */
export function applyOverrides(
  config: BudgetConfig,
  overrides: readonly string[],
): { config: BudgetConfig; unknown: string[] } {
  const next = structuredCloneConfig(config);
  const unknown: string[] = [];

  for (const raw of overrides) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      unknown.push(raw);
      continue;
    }

    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();

    if (key === "enabled") {
      next.enabled = value !== "false" && value !== "0";
      continue;
    }
    if (key === "downgrade.enabled") {
      next.downgrade.enabled = value !== "false" && value !== "0";
      continue;
    }
    if (key === "downgrade.model") {
      next.downgrade.model = value === "" || value === "none" ? null : value;
      continue;
    }

    const dot = key.indexOf(".");
    if (dot > 0) {
      const scope = key.slice(0, dot) as BudgetScope;
      const field = key.slice(dot + 1) as keyof BudgetThresholds;
      if (SCOPE_ORDER.includes(scope) && (field === "warn" || field === "downgrade" || field === "block")) {
        const parsed = value === "none" || value === "off" ? null : optionalNumber(value);
        const thresholds: BudgetThresholds = next.limits[scope] ?? {};
        thresholds[field] = parsed;
        next.limits[scope] = thresholds;
        continue;
      }
    }

    unknown.push(raw);
  }

  return { config: next, unknown };
}

/** Render the effective config for `/budget show`. */
export function formatConfig(config: BudgetConfig): string {
  const lines: string[] = [];
  lines.push(`enabled: ${config.enabled}    block: ${config.block.enabled}    retention: ${config.retentionDays}d`);

  for (const scope of SCOPE_ORDER) {
    const t = config.limits[scope];
    if (!t) {
      lines.push(`${scope.padEnd(7)} —`);
      continue;
    }
    const cell = (value: number | null | undefined): string =>
      typeof value === "number" ? `$${value}` : "—";
    lines.push(
      `${scope.padEnd(7)} warn ${cell(t.warn).padEnd(8)} downgrade ${cell(t.downgrade).padEnd(8)} block ${cell(t.block)}`,
    );
  }

  const downgrade = config.downgrade.enabled
    ? config.downgrade.model ?? (config.downgrade.preferProviders.length > 0
        ? `cheapest from ${config.downgrade.preferProviders.join(", ")}`
        : "cheapest available")
    : "disabled";
  lines.push(`downgrade: ${downgrade}`);

  return lines.join("\n");
}
