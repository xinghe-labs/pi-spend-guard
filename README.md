# pi-spend-guard

[![npm](https://img.shields.io/npm/v/pi-spend-guard)](https://www.npmjs.com/package/pi-spend-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/xinghe-labs/pi-spend-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/xinghe-labs/pi-spend-guard/actions/workflows/ci.yml)

**Hard budget enforcement for [pi](https://pi.dev).** Warn, automatically downgrade to a cheaper model, and block requests before you overspend.

[English](./README.md) | [简体中文](./README.zh-CN.md)

pi already tells you what you spent. Nothing stops you from spending it.

---

## The problem

There is no shortage of pi extensions that *display* cost — status bars, observability plugins, dashboards. They are all read-only. When a runaway agent loops through 40 tool calls at 3am, a status bar is not a control.

`pi-spend-guard` is the control. It reads real provider-reported cost and escalates:

| Spend reaches | What happens |
|---|---|
| `warn` | You get a notification |
| `downgrade` | The session switches to a cheaper model for the rest of the run |
| `block` | The request is **aborted before it is sent** |

Each threshold is configured independently per scope: **session**, **daily**, and **monthly**.

### How this differs from a session spend cap

A session-only cap is the common approach: one limit, abort when it is hit. That
leaves two gaps.

- **A session is not a billing period.** Fifty small sessions in a day can each
  stay under a per-session cap while the month quietly runs away. This extension
  enforces `daily` and `monthly` budgets from a persisted ledger, alongside
  `session`.
- **Aborting is the last resort, not the first.** Crossing a soft threshold
  switches to a cheaper model so the work can finish instead of stopping. No
  session cap does this.

It also warns when a model has no price data — the one failure mode that makes
every budget silently useless.

## Install from npm

```bash
pi install npm:pi-spend-guard
```

Try it without touching your settings:

```bash
pi -e npm:pi-spend-guard
```

### From git (no npm account needed)

The extension has no runtime dependencies, so it installs straight from the
repository:

```bash
pi install git:github.com/xinghe-labs/pi-spend-guard
```

Git installs behave identically. The only difference is visibility: only npm
packages are listed in the [pi package gallery](https://pi.dev/packages).

## Quick start

That is it. Defaults are active immediately:

| Scope | warn | downgrade | block |
|---|---|---|---|
| session | $2 | $5 | $10 |
| daily | $10 | $25 | $50 |
| monthly | $100 | $250 | $500 |

Check where you stand at any time:

```
/budget
```

```
session $3.42   daily $11.80   monthly $63.10
Budget warning: $11.80 of $10.00 (daily)

enabled: true    block: true    retention: 120d
session warn $2       downgrade $5       block $10
daily   warn $10      downgrade $25      block $50
monthly warn $100     downgrade $250     block $500
downgrade: cheapest available
```

## Verified behaviour

Blocking is not a claim, it is observable. With `block: 0`:

```console
$ pi -ne -e ./src/extension.ts --budget-config ./examples/block-all.json -p "Reply with exactly: ok"
Request aborted
```

The same command with a normal budget returns `ok`.

Pre-flight estimation blocks the request that *would* cross the line, before it
is sent. Here the model has **no price in the pi catalog at all** — only the
guard's own `pricing` table can price it — and nothing has been spent yet:

```console
$ PI_CODING_AGENT_DIR=/tmp/verify pi -ne -e ./src/extension.ts --budget-config /tmp/with-pricing.json -p "hi"
Request aborted
$ PI_CODING_AGENT_DIR=/tmp/verify pi -ne -e ./src/extension.ts --budget-config /tmp/no-pricing.json -p "hi"
Connection error.
```

Same model, same thresholds, same `$0` spent. The only difference is the
`pricing` table, and it is the difference between a guard that enforces and one
that does nothing.

## Commands

| Command | Purpose |
|---|---|
| `/budget` | Show spend, verdict, pricing status, and effective config |
| `/budget set daily.block=20` | Change a threshold and persist it |
| `/budget set session.warn=none` | Disable a single threshold |
| `/budget set downgrade.model=deepseek-chat` | Pin the fallback model |
| `/budget set estimate.enabled=false` | Turn off pre-flight projection |
| `/budget set estimate.outputTokens=4096` | Assume a longer reply when projecting |
| `/budget on` / `/budget off` | Toggle enforcement |
| `/budget reset` | Clear the persisted ledger |
| `/budget models` | Per-model spend, highest first |

## Configuration

Config lives at `<agent dir>/pi-spend-guard/config.json` — normally
`~/.pi/agent/pi-spend-guard/config.json`. See [`examples/config.json`](./examples/config.json)
for a fully commented starting point.

```json
{
  "enabled": true,
  "limits": {
    "session": { "warn": 2, "downgrade": 5, "block": 10 },
    "daily":   { "warn": 10, "downgrade": 25, "block": 50 },
    "monthly": { "warn": 100, "downgrade": 250, "block": 500 }
  },
  "downgrade": {
    "enabled": true,
    "model": null,
    "preferProviders": ["deepseek"]
  },
  "block": { "enabled": true },
  "estimate": { "enabled": true, "outputTokens": 2048 },
  "pricing": {
    "my-provider/*": { "input": 0.5, "output": 1.5 }
  },
  "notify": { "onWarn": true, "onDowngrade": true, "onBlock": true },
  "retentionDays": 120
}
```

Notes:

- Omit a scope to inherit its defaults; set it to `null` to disable that scope entirely.
- Omit a single threshold to inherit it; set it to `null` to disable just that one.
- `0` is a real threshold and fires immediately.
- `block.enabled: false` keeps the warning but never aborts — useful for a trial run.
- `downgrade.model` wins over `preferProviders`. With neither set, the cheapest available model is chosen.
- `estimate` controls pre-flight projection. It needs a price to work with, and
degrades to spend-only enforcement when there is none.
- `pricing` is the guard's own rate table, for models pi has no price for.

CLI flags: `--budget-config <path>` points at a different config file; `--no-budget` disables enforcement for one run.

### Pricing: how the guard learns what a model costs

Cost is resolved in three steps, most trustworthy first:

1. **What the provider reported.** `Usage.cost.total` reflects real discounts,
   request-wide pricing tiers, and provider-side cache pricing that nothing
   local can know.
2. **Your `pricing` table**, in the guard's own config.
3. **The pi model catalog** — the `cost` block on the model definition in
   `~/.pi/agent/models.json`.

Steps 2 and 3 exist because step 1 often reports nothing: local gateways,
self-hosted proxies, and any model pi does not ship a price for.

```json
{
  "pricing": {
    "workbuddy/global:glm-5.3": { "input": 0.27, "output": 1.1 },
    "workbuddy/*": { "input": 0.5, "output": 1.5 },
    "deepseek-chat": { "input": 0.28, "output": 0.42 },
    "*": { "input": 1, "output": 3 }
  }
}
```

Rates are **USD per million tokens**. Keys match most-specific-first:
`provider/model`, then `provider/*`, then a bare `model`, then `*`. An entry
that cannot price anything (all rates zero) is skipped rather than allowed to
shadow a broader key. `cacheRead` and `cacheWrite` fall back to the `input`
rate when omitted, and a request-level `tiers` array is supported for models
that charge more above a token threshold:

```json
{
  "pricing": {
    "anthropic/claude-sonnet": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "tiers": [{ "inputTokensAbove": 200000, "input": 6, "output": 22.5 }]
    }
  }
}
```

A practical source for rates is [models.dev](https://models.dev) — its
[`api.json`](https://models.dev/api.json) lists costs for hundreds of providers.
Take the **first-party** entry for a model (provider `zai`, `deepseek`,
`moonshotai`, …), not a reseller's, and copy `cache_write` explicitly: the
config table falls back `cacheWrite` to the `input` rate when omitted, and for
models like Kimi K3 that charges $3/Mtok cache-write versus $3 input, or GLM
whose cache-write is genuinely $0, an omitted field can be wrong by orders of
magnitude.

Alternatively, put the rates in the pi catalog where they belong:

```json
{
  "providers": {
    "my-provider": {
      "models": [
        {
          "id": "my-model",
          "cost": { "input": 0.5, "output": 1.5, "cacheRead": 0.05, "cacheWrite": 0.5 }
        }
      ]
    }
  }
}
```

**If nothing can price a call, the guard does not pretend it was free.** The
record is stored with `"unpriced": true`, a session-start warning names the
exact model and the config key to add, and `/budget` reports how many unpriced
calls are on record. An unknown price and a genuine zero are different things,
and the ledger keeps them apart.

### Pre-flight estimation

Spend-only checks can only stop a request *after* the money is gone. With
`estimate` enabled (the default) the guard also projects what the request about
to be sent will cost, and blocks it if that projection crosses a threshold —
before it reaches the provider. See
[`examples/estimate.json`](./examples/estimate.json) for a runnable demo:

```console
$ pi -ne -e ./src/extension.ts --budget-config ./examples/estimate.json -p "hi"
Request aborted
```

Nothing was spent — `session spend` was `$0` when the request was stopped. The
block message distinguishes the two cases, so it never claims you have already
spent money you have not:

```
Budget: this request (~$0.0033) would take session spend to $0.0033, past the $0.001 limit — blocked before sending
```

The projection uses the current context size as the input tokens and
`estimate.outputTokens` (default `2048`) as the output tokens. That assumption is
deliberately conservative: `maxTokens` is the model's ceiling, not the likely
reply, and using it would block requests that would have cost far less. Set
`estimate.enabled` to `false` for pure spend-only enforcement, or raise
`estimate.outputTokens` to be more cautious.

Estimation needs a price. When the input size or the rates are unknown it
degrades to spend-only enforcement rather than inventing a number.

## How it works

```
before_agent_start ──► evaluate ──► downgrade (pi.setModel)
before_provider_request ──► project cost ──► evaluate ──► block (ctx.abort)
message_end ──► resolve cost ──► merge + write ledger.json (immediately)
session_start ──► load config + ledger, warn if the model has no price
```

Five deliberate design decisions:

**Session spend is rebuilt from the session branch, not accumulated in memory.**
Every evaluation walks `ctx.sessionManager.getBranch()` and sums both `message`
entries (assistant `usage`) and `usage` entries (cache warming and friends).
Forks, `/reload`, and resuming a session therefore all produce the same number —
an in-memory counter would drift. Skipping the non-message `usage` entries would
silently under-count.

**Provider-reported cost always wins over the catalog.**
`Usage.cost.total` reflects real discounts, request-wide pricing tiers, and
provider-side cache pricing that a local lookup cannot know about. Catalog rates
are a fallback only, and the resulting record is flagged `"estimated": true` so
you can tell measured cost from guessed cost.

**Enforcement happens at `before_provider_request`.**
That hook fires before *every* provider call, including each follow-up turn
inside one agent run — not just once at the start. `before_agent_start` is used
separately for downgrades, so a cheaper model applies to the whole run.

**Concurrent sessions share one ledger without losing records.**
Every write re-reads the file and merges by (timestamp, cost, model, usage), and
every enforcement decision re-reads before evaluating. Two pi windows running
at once therefore both survive — the last writer does not erase the other's
accounting, and daily/monthly budgets see the whole machine's spend rather than
one session's stale snapshot. Records land on disk at `message_end`, so a crash
cannot erase the spend a session just made. `/budget reset` is the one
deliberate exception: it overwrites instead of merging, because the user asked
for the ledger to be erased.

**Enforcement is preventive, not just accounting.**
Before sending, the guard projects the request's own cost and adds it to every
scope. A request that would cross a limit is stopped while spend is still under
it, and the message says so — `would take session spend to $X` rather than
claiming exhaustion that has not happened. The projection fails safe: with no
context size or no rates it returns `0` and enforcement falls back to money
already spent, instead of guessing a number that could block good requests.

## Limitations

Stated plainly, because a budget guard that quietly does nothing is worse than none:

- **A model with no price anywhere cannot be measured.** Provider-reported cost,
  the `pricing` table, and the catalog are consulted in that order. When all
  three are silent the guard says so at session start, flags the call
  `"unpriced": true`, and reports it in `/budget` — it never counts an unknown
  price as `$0` and calls the budget enforced.
- **Pre-flight estimation is an estimate.** It assumes `estimate.outputTokens`
  of output; a long reply can cost more than projected and be caught on the
  *next* call rather than this one. It is a guard rail, not a hard cap on a
  single request.
- **Daily and monthly totals start accumulating when the extension is first
  installed.** They come from the persisted ledger, which only knows about
  sessions that ran with the extension loaded. Session spend has no such gap —
  it is rebuilt from the branch.
- Only spend that flows through pi is counted. Usage in other tools is invisible.
- The ledger is a local JSON file. There is no sync, no multi-machine
  aggregation, and no cloud anything.

## Development

```bash
npm install --ignore-scripts
npm test          # 106 tests, no network, no model calls
npm run typecheck
```

The core logic in `src/policy.ts`, `src/ledger.ts`, `src/config.ts`, and
`src/store.ts` is pure and dependency-free, so it is tested exhaustively without
an agent. `test/extension.test.ts` drives the real extension factory through a
fake `ExtensionAPI`, which is why the enforcement paths are covered end to end
without spending a cent.

| File | Responsibility |
|---|---|
| `src/extension.ts` | pi integration: hooks, flags, `/budget` command |
| `src/policy.ts` | Threshold evaluation, verdict severity, model selection |
| `src/ledger.ts` | Cost arithmetic, time windows, estimation from catalog rates |
| `src/config.ts` | Config normalization and CLI overrides |
| `src/store.ts` | Atomic, defensive JSON persistence |

## License

MIT
