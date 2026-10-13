# pi-spend-guard

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

## Install

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

## Commands

| Command | Purpose |
|---|---|
| `/budget` | Show spend, verdict, and effective config |
| `/budget set daily.block=20` | Change a threshold and persist it |
| `/budget set session.warn=none` | Disable a single threshold |
| `/budget set downgrade.model=deepseek-chat` | Pin the fallback model |
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

CLI flags: `--budget-config <path>` points at a different config file; `--no-budget` disables enforcement for one run.

### Models without prices

If pi does not know what a model costs, budgets cannot be enforced for it. Add the
rates to `~/.pi/agent/models.json` (USD per million tokens):

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

`pi-spend-guard` warns once at session start when the active model has no price,
so a misconfigured setup never looks protected when it is not.

## How it works

```
before_agent_start ──► evaluate ──► downgrade (pi.setModel)
before_provider_request ──► evaluate ──► block (ctx.abort)
message_end ──► record cost ──► ledger.json
session_start ──► load config + ledger, warn if the model has no price
```

Three deliberate design decisions:

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

## Limitations

Stated plainly, because a budget guard that quietly does nothing is worse than none:

- **A model with no catalog price cannot be measured.** pi only knows what a
  model costs if its provider definition includes `cost` rates and the provider
  reports usage cost. When neither is available the guard says so once at
  session start instead of pretending to protect you.
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
