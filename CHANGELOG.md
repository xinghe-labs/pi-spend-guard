# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-14

Concurrent sessions no longer lose each other's accounting, and a crash no
longer erases the spend a session just made.

### Fixed

- **Concurrent pi sessions no longer overwrite each other's ledger records.**
  Every save re-reads the file and merges by (timestamp, cost, model, usage),
  so the last writer no longer wipes what other sessions recorded while holding
  a stale snapshot. Verified with four real concurrent pi processes: the ledger
  keeps all four sessions' records instead of only the last one to exit.
- **Records are persisted at `message_end`, not only at `session_shutdown`.**
  Previously a session that crashed or was killed mid-run lost every record it
  had made — the ledger only learned about them on a clean exit. Verified by
  SIGKILL-ing a real pi process right after its first reply: the record
  survives.
- **Daily/monthly budgets now see concurrent sessions' spend.** Enforcement
  re-reads the shared ledger before every decision, so two parallel sessions
  can no longer each spend the same daily budget in ignorance of each other.
- `/budget reset` now overwrites instead of merging — otherwise the merge logic
  would immediately resurrect the records it was asked to erase.

### Added

- `mergeRecords` and `appendRecords` in `src/store.ts`: deduplicating merge and
  read-merge-write append, the basis for safe concurrent persistence.

## [0.2.0] - 2026-10-14

Preventive enforcement — and a fix for the setup where the guard could not
measure anything at all.

### Added

- **Pre-flight cost estimation.** `before_provider_request` now projects what the
  request about to be sent will cost — the current context size as input tokens,
  `estimate.outputTokens` (default 2048) as output — adds that to every scope,
  and blocks the request if the projection crosses a threshold. Enforcement is no
  longer limited to money already spent, and the block message says
  `would take session spend to $X` instead of claiming an exhaustion that has
  not happened.
- **A `pricing` table** in the guard's own config, so models pi has no price for
  can still be measured. Rates are USD per million tokens, matched
  most-specific-first (`provider/model` → `provider/*` → `model` → `*`), with
  `cacheRead`/`cacheWrite` falling back to the input rate and optional
  request-level `tiers` for models that charge more above a token threshold.
- `src/pricing.ts`: pure, dependency-free rate resolution — the config table
  first, then the pi model catalog.
- `SpendRecord.unpriced`, keeping "the price is unknown" distinct from "this call
  was free".
- `/budget` now reports the resolved pricing source, the effective rates, and how
  many unpriced calls are on record.
- `examples/pricing.json` and `examples/estimate.json`.

### Changed

- **Cost resolution is now three-tier:** provider-reported `usage.cost.total`,
  then the `pricing` table, then the catalog. Previously only the first two
  existed, and the fallback needed `cost` to be present in the model definition.
- The downgrade target is chosen with the same resolved rates, so a user-supplied
  `pricing` table also drives which model counts as cheapest. Reading `model.cost`
  directly would leave every candidate unpriceable on a catalog-less setup.
- The unpriced-model warning now names the exact config key to add.
- An entry that cannot price anything (all rates zero) is skipped instead of
  shadowing a broader wildcard key.
- `devDependencies` aligned with the pi release actually tested against (1.2.0).

### Fixed

- **The guard silently did nothing when pi had no price for the active model.**
  Every call was recorded at `$0`, so no threshold could ever fire. This is the
  default state for local gateways, self-hosted proxies, and any model pi does
  not ship a price for. The `pricing` table fixes it, and `unpriced` makes any
  remaining case visible instead of looking like a free call.

### Verified

- 142 unit tests, no network access and no model calls.
- Real pi process, real provider, model with **no catalog price at all**: with a
  `pricing` entry the request is aborted before it is sent; without it the request
  goes out. Same model, same thresholds, `$0` spent — the only difference is the
  pricing table.

## [0.1.0] - 2026-10-13

First public release.

### Added

- Budget enforcement across three independent scopes: `session`, `daily`, and
  `monthly`.
- Three escalating tiers per scope — `warn` (notify), `downgrade` (switch to a
  cheaper model for the rest of the run), and `block` (abort the request before
  it is sent).
- Enforcement on `before_provider_request`, so every provider call is checked,
  including follow-up turns inside a single run rather than only the first one.
- Automatic downgrade to the cheapest model present in the catalog.
- Spend totals rebuilt from the session branch instead of in-memory state, so
  forks, reloads, and resumed sessions report correct figures.
- Provider-reported `usage.cost.total` preferred over catalog rates;
  catalog-derived amounts are flagged `estimated: true`.
- A session-start warning when the active model has no price data — the failure
  mode that silently disables every threshold.
- A persisted ledger with configurable retention (`retentionDays`, default 120)
  and a 20,000-record cap.
- Configuration through `config.json`, the `/budget` command, and CLI flags.
- No runtime dependencies.

[Unreleased]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/xinghe-labs/pi-spend-guard/releases/tag/v0.1.0
