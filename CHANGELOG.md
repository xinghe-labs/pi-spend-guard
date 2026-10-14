# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-10-14

- Sync the Chinese Limitations list with the network disclosure the English one
  already carried: the published list is a list price rather than an invoice, it
  is fetched from the network unless disabled, and the fetch is the only network
  access. (0.6.0 was staged but superseded by this before approval.)

## [0.6.0] - 2026-10-14
## [0.6.0] - 2026-10-14

Hardening the remote trust boundary introduced in 0.5.0, from a third review
round. 0.5.0 added the project's first external input; this release stops
treating it as trustworthy by default, and fixes a first-run warning that
stated something untrue.

### Fixed

- **The first-run unpriced warning no longer lies.** It ran in the same
  synchronous stretch as the background refresh, so on a cold cache it always
  saw "no list" and asserted `The published list (…) had no entry for it` — a
  claim that was never retracted, on the exact path 0.5.0 exists to fix. The
  warning now waits for the refresh to settle (so a model the list prices is
  never reported unpriced), and the wording distinguishes "no list available
  (offline, still fetching, or the fetch failed)" from "the list has no entry".
- **The cache is keyed by source URL.** It was keyed by timestamp alone, so
  after changing `rates.remote.url` — or a second `--budget-config` sharing the
  state dir — the guard kept pricing from the old list while `/budget` named the
  new one. A snapshot whose `source` differs is now discarded.
- **`rates.remote.enabled=false` takes effect immediately**, including for a
  fetch already in flight, and the loaded list stops pricing at once. The
  refresh also re-checks the URL after the await, so an in-flight response is
  never cached under the wrong source.
- **A sub-millisecond `timeoutMs` no longer disables the feature silently.**
  `Math.floor(0.5)` was `0`, and `AbortSignal.timeout(0)` aborts immediately.
- **An unreadable cache can no longer suppress the refresh.** `version` is now
  validated, an empty index is rejected, and keys are normalized on read exactly
  as on the network path (a hand-written cache was previously unreachable).
- **The ambiguity tie-break is deterministic.** It followed payload key order,
  so the chosen price could change on the next refresh with no signal. It now
  prefers the calling provider, then model owners over hosting platforms
  (`azure`/`amazon-bedrock` are not the first party for someone else's model),
  then breaks ties by name.
- **A timestamp is no longer validated as a rate.** Adding the rate ceiling
  initially applied it to `fetchedAt` too, which rejected every real
  epoch-millisecond value and made every cache unreadable — caught by the test
  suite before release.

### Added

- **Trust bounds on the published list**: `https` only (plus `http` on
  loopback), cross-origin redirects refused, a 32 MB response cap,
  `MAX_PLAUSIBLE_RATE` ($10,000/Mtok) with partial trust refused (an entry whose
  input is absurd is dropped whole, never recorded as `input: 0`), and a payload
  that is mostly implausible discarded entirely so the previous snapshot stands.
- **`rateSource` on each estimated record** (`config`, `catalog`, or
  `models.dev`), so the precedence chain is auditable after the fact. Additive
  and optional, like `unpriced`.
- **`--no-rates`** to skip the lookup for one run, alongside the existing config
  toggle.
- **The fetch is now demand-driven.** It is skipped when the offline sources
  already price the active model, so a catalog-priced setup never contacts a
  third party at all.
- 19 tests (199 total), covering the empty-payload guard, non-OK and non-JSON
  responses, a cross-origin redirect, a mid-flight disable, a URL change, the
  rate ceiling, cache-format validation, key normalization, numeric id tails,
  and the corrected warning wording.

## [0.5.0] - 2026-10-14
## [0.5.0] - 2026-10-14

Zero-configuration pricing. Until now the guard needed a hand-written `pricing`
table before it could measure anything on a gateway whose models carry no price,
and until that table existed every budget silently evaluated to zero.

### Added

- **Automatic rates from a published price list** ([models.dev](https://models.dev)
  by default). `src/rates.ts` parses the list, indexes it by `provider/model`
  and by bare model id, and `resolveRates` consults it after the config table and
  the catalog. The cache is read from disk at session start (offline, instant)
  and refreshed in the background once it is older than `rates.remote.ttlHours`;
  the fetch is never awaited, so a slow or unreachable list cannot delay a
  session or a provider request. A trimmed snapshot is cached (`~0.6 MB` from a
  5.6 MB payload), so later sessions need no network at all.
- **Conservative matching.** An exact `provider/model` wins; otherwise the bare
  model id is tried, so gateway prefixes like `global:glm-5.3` resolve. An id
  published by several providers is only used when a first-party provider is
  among them — otherwise the model stays `unpriced` rather than being assigned a
  reseller's guess, because a wrong price miscounts every budget while a missing
  one is reported.
- `rates.remote` config block (`enabled`, `ttlHours`, `url`, `timeoutMs`) and
  matching `/budget set rates.remote.*` overrides. Disabling it makes the guard
  fully offline.
- `/budget` names the resolved source (`config table`, `model catalog`,
  `published list`), and the unpriced warning now says whether the list was
  consulted.

### Changed

- **A provider-reported `$0` is no longer trusted on its own.** Verified against
  a real reseller gateway that reports `cost.total = 0` for calls it bills;
  trusting it recorded every call as free. With rates available the call is
  priced from them, and a `$0` with no rate anywhere is recorded as `unpriced`.

### Verified

Zero-config on a local gateway whose models carry no price anywhere: a config
containing only thresholds (`session.block: 0.001`) aborts the request
(`Request aborted`), and the same config with `rates.remote.enabled: false`
lets it through. A real `models.dev` fetch returns 7,717 priced entries and
resolves 4 of 5 of the gateway's models by bare id; the ledger then records the
exact published rate (1,417 input tokens at $1.4/Mtok = $0.001997).

## [0.4.2] - 2026-10-14

Follow-ups from the second review round, before 0.4.1 reached approval:

### Fixed

- **The lock is ownership-tagged.** A holder whose lock was stolen (stale-lock
  path) no longer force-removes its successor's live lock on exit — that
  briefly allowed a third writer into a critical section.
- **Session spend attributes every branch entry to its own model.** `usage`
  entries (cache warming), `compaction`, and `branch_summary` carry their own
  provider/model and are now priced accordingly instead of at the current
  model; assistant messages are attributed via `responseModel ?? model`,
  matching pi's own totals.
- **`compaction`/`branch_summary` usage is now actually counted.** The 0.4.1
  comment claimed parity with pi's accounting that the code did not deliver;
  the loop now covers them (and the comment matches the code).

### Fixed (tests)

- Two projection tests were vacuous — their config was written after
  `session_start`, so it was never loaded and both passed under the default
  $10 block. They now write config first, assert the discriminating case in
  both directions, and document the arithmetic.

### Docs

- Test count reconciled (README said 106, zh-CN said 142, CHANGELOG said 154;
  all now 154). zh-CN pre-flight section synced to 0.4.1 semantics. npm-vs-git
  version note added to both install sections. CHANGELOG explains the skipped
  0.4.0.

## [0.4.1] - 2026-10-14

(There is no 0.4.0: it was staged for npm but superseded by this release before
approval, and the version number was reused rather than published.)

Hardening pass from an independent four-way review (code, architecture, tests,
product): closes the race window the 0.3.0 merge only narrowed, makes retention
and the record cap actually hold, and fixes several silent-failure directions.

### Fixed

- **The ledger lock is now real.** `appendRecords` runs under an exclusive
  `mkdir`-based lock with bounded retry, so two sessions can no longer
  interleave read→merge→write and drop each other's records. On timeout the
  write proceeds unlocked rather than wedging a provider request, and a lock
  left by a crashed holder is stolen once it outlives the retry budget
  (previously it would degrade every future write to unlocked mode forever).
- **Retention and `MAX_RECORDS` now apply to the merged file.** Previously
  `prune`/`capRecords` ran on the in-memory slice before the merge, so the
  merge resurrected exactly what had been pruned and the ledger grew without
  bound. Both now run inside the lock on the merged result. Verified: 6,100
  records cap holds under 20 concurrent writers; expired records are pruned
  from disk, not revived.
- **`before_provider_request` re-reads the shared ledger before deciding.** The
  only handler that aborts was still evaluating a stale snapshot, so parallel
  sessions could each spend the same daily budget during a long run. Verified
  with two guard instances sharing one state dir: B's $9 spend aborts A's next
  request.
- **Session spend prices each branch entry with its own model's rates.** After
  an auto-downgrade, earlier expensive-model turns were re-priced at the cheap
  model's rates — understating session spend in exactly the direction that
  delays enforcement. Entries are now resolved against the model registry.
- **A malformed threshold falls back to the default instead of disabling the
  limit.** `daily.block: "fifty"` (a hand-edit typo) used to encode as `null` —
  silently removing the limit, the least safe outcome for a guard.
- **A provider-reported `$0` is no longer trusted when rates are available.**
  Verified against a real reseller gateway: it reports `cost.total = 0` for
  calls it bills. Trusting that would have recorded every call as free. The
  report is cross-checked against the rates; a `$0` with no rates anywhere
  stays flagged `unpriced` (indistinguishable from unknown).
- **Downgrade no longer oscillates.** The guard now latches after the first
  switch per session; previously `pickCheapest` excluded only the current
  model, so a still-over-budget session could flip between models on every
  run start.
- **The merge key includes the full token breakdown.** Two distinct calls in
  the same millisecond with the same total token count (plausible for short
  subagent replies, and unpriced calls all carry cost 0) no longer collapse
  into one record.
- **`toolResult` usage is recorded instead of ignored.** pi's own usage
  totals book a tool result's `usage` (the model calls the tool itself made)
  under "Tools/summaries"; the guard skipped it, systematically undercounting
  relative to pi's accounting. `branchSpend` now matches what gets recorded.
- Dead code removed (`spendByScope`/`sessionSpend` duplicated the scope
  arithmetic the extension does differently), the `applyOverrides` doc no
  longer lists an unimplemented `block` key, and the `mergeRecords` comment no
  longer claims "newest first" or that same-millisecond calls survive.

### Added

- **Cache-aware, output-adaptive pre-flight projection.** The projection used
  to price the whole context as uncached input — over-blocking long cached
  sessions by up to ~10× — and reserved a fixed 2,048 output tokens. It now
  takes the cached fraction from the most recent assistant usage and adapts
  the output estimate to the session's trailing actual replies, falling back
  to the configured `outputTokens` before any output is observed.
- Tests for all of the above: 154 (from 146), including toolResult accounting, deterministic
  concurrency tests through the real lock, retention/cap-through-the-merge,
  concurrent enforcement, per-entry session pricing, and both projection
  adaptations.

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

[Unreleased]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/xinghe-labs/pi-spend-guard/releases/tag/v0.1.0
