# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-10-14

Round-5 review follow-ups. The theme: the guard must not silently do less than
it advertises — three of these were exactly that.

### Added

- **Unpriced records are re-priced instead of staying at $0 forever.** When a
  published list arrives (or on the next session, from the cache), records whose
  price was unknown are recomputed from their stored usage and re-persisted.
  This was the root cause behind the 1.5 s accounting wait: without it, any call
  that arrived before the list did stayed unknown for the whole retention
  window, so the wait was load-bearing rather than a nicety. Verified on a real
  process: a call recorded while the list was unreachable is priced on the next
  run (`unpriced: 1` → `0`).
- **`/budget reset` is now durable.** A marker records when the ledger was
  cleared, and every writer drops records from at or before it. Locking alone
  could not fix this: another live session holds its records in memory and
  re-merges them on its next write, so the erased records came back minutes
  later.
- **Provenance is complete enough to check a past number**: estimated records
  store the matched `rateKey` and the `ratesUsed` (the four rates actually
  applied), and `/budget models` shows the key per model — a `provider/*` or `*`
  hit is now distinguishable from an exact entry in the ledger itself.
- A ledger that cannot be written is reported once per session instead of
  failing silently while daily/monthly quietly stop learning anything.
- 7 tests (241 total), including the re-price pass, its idempotence, the durable
  reset against a session holding the old records, an oversized response, the
  persist-failure warning, and `ratesUsed` provenance.

### Fixed

- **The 32 MB response cap bounded what was kept, not what was read.** The body
  was buffered in full before the check, so a chunked response with no
  `content-length` was materialised regardless. The body is now read through a
  capped stream that abandons an oversized response mid-read.
- **The accounting wait was gated on the wrong model**: it asked whether the
  *active* model was priced while the record is priced from the *served* one, so
  a routed `responseModel` could be recorded unpriced with the list in flight.
- The remote-rate lookup (alias, fallback, ambiguity) existed in three places
  that could drift; it is now one helper used by pricing, `/budget explain`,
  provenance and the re-price pass.
- The `*` catch-all is gone from the copyable README config example too, not
  only from `examples/`.

## [0.8.0] - 2026-10-14
## [0.8.0] - 2026-10-14

Round-4 review follow-ups. Two of the defects were introduced by 0.7.0 itself,
and one of them made a documented invariant false.

### Fixed

- **The rates cache could adopt a snapshot from a different URL.** The re-read
  under `withRatesLock` compared only `fetchedAt`, so a newer file written by a
  different `rates.remote.url` (a second `--budget-config`, or another tool)
  was adopted for pricing while `/budget` reported the configured URL — the
  same wrong-list class 0.6.0 fixed for the load path.
- **The accounting wait could stall a turn for the whole fetch timeout.** The
  docs and the 0.7.0 changelog claimed the fetch is "never awaited"; pi awaits
  `message_end` before the run continues, so an unreachable list stalled the
  turn for up to 10 s. The wait is now bounded at 1.5 s, and the README,
  zh-CN README and comments say what actually happens.
- **A ledger record ignored `responseModel`.** pi reports the model the provider
  actually resolved the request to; the session scope already priced per served
  model while the ledger priced per active model, so the same call could be
  valued two different ways — in the scope that survives restarts.
- **A stale lock cost the whole retry budget.** The retry loop sleeps with a
  synchronous `Atomics.wait`, so a lock left by a SIGKILLed session froze the
  process for 10 s before being stolen. Staleness is now judged at 2 s, so a
  dead holder costs one retry.
- **`/budget reset` wrote outside the ledger lock**, so a concurrent session's
  merge could resurrect the erased records.
- **A failed owner-token write leaked the lock** for the stale window: the
  release path read back a token that had never been written and concluded the
  lock was not ours.
- **The bare `*` catch-all outranked the catalog and the published list**, and
  the shipped examples taught it — copying an example priced every model of
  every provider at $1/$3, a large under-count. It is now a genuine last resort
  and has been removed from `examples/`.
- **`ratesRefresh` was tracked on only one branch**, so a mid-session switch to
  an unpriced model could be recorded unpriced while a refresh was in flight —
  the defect 0.7.0 fixed, on the other path.
- **`/budget explain` could contradict itself** when an alias target missed: it
  reported the published tier from the alias target only, while pricing fell
  back to the unaliased lookup.
- Negative costs are ignored by every aggregator, a non-finite total no longer
  displays as `$0.00`, the `UNPRICED` badge is suppressed when enforcement is
  off, and the unpriced message distinguishes "no entry" from "refused as
  ambiguous".

### Added

- **Rate provenance is now specific**: records store the matched `rateKey`
  (so a `provider/*` or `*` hit is distinguishable from an exact entry) and the
  published list's `ratesFetchedAt`, so a past number stays explainable after a
  refresh. `/budget explain` prints the matched key for every tier.
- **Alias fallback**: a bare alias target whose published id contains a slash is
  retried as a whole id, since a provider pin and a slashed id are otherwise
  indistinguishable.
- Alias keys are normalized once at load rather than re-scanned per lookup.
- The status line no longer re-reads the whole ledger on every message.
- 9 tests (234 total), including the merge-key behaviour that makes re-pricing
  safe, `responseModel` attribution, the reset lock, the stale-lock threshold,
  the bounded accounting wait, and the persisted `on`/`off` state.

## [0.7.0] - 2026-10-14
## [0.7.0] - 2026-10-14

Closes the remaining v1.0 items from the third review round, and fixes a crash
the review could not see: it only appears when the extension runs inside a real
pi process.

### Fixed

- **A deferred callback crashed the process at exit.** The rate refresh is not
  awaited at session start, and its continuation touched the pi `ctx` — which pi
  asserts is still active and **throws** on once the session is replaced or a
  `-p` run has finished. Every short run with an unpriced model ended in a stack
  trace and a non-zero exit code. Both helpers are now stale-ctx safe, and the
  test harness models pi's throwing behaviour so this cannot come back.
- **The first cold-cache call is no longer recorded as unpriced.** The list was
  fetched in the background and the record was written before it landed, so the
  first call of the first session was priced at $0 with `unpriced: true` while
  the list that would have priced it was still downloading. Accounting now waits
  for an in-flight refresh when nothing else can price the model — bounded by the
  fetch's own timeout, and invisible to the user because the provider response
  has already been streamed. Session start itself still never waits.
- **A negative cost can no longer mask spend.** `parseRecords` accepted any
  finite cost, so one corrupt record could cancel out real spend and make every
  budget look satisfied; the aggregators now ignore negatives as well.

### Added

- **Rate aliases** (`rates.aliases`), for the verified real case of a gateway
  that renames a model: `global:deepseek-v4.1-flash` is published as
  `deepseek-flash`. Keys match most-specific-first like the `pricing` table, and
  the value may pin a provider. Without an alias the model correctly stays
  unpriced, which previously left the user hand-copying rates.
- **`/budget explain`** prints what every tier would charge for the active model
  — provider-reported, config table, model catalog, published list — and which
  one wins, including the alias followed. The precedence chain decides real
  money and was previously only visible as a single label.
- **`/budget models` reports the pricing source** per model, so a surprising
  number can be traced after the fact.
- **The status line shows `UNPRICED`** when the active model cannot be priced.
  Previously a user who missed the one startup warning saw a healthy spend
  figure while enforcement was structurally inert.
- `CONTRIBUTING.md`, including the compatibility rules for the ledger and config.
- 26 tests (225 total): real cross-process lock contention with spawned
  processes, timezone and DST matrices for the day/month boundaries via child
  processes in fixed zones, alias resolution, explain output, source reporting,
  the status indicator, `/budget on|off`, announcement dedup, notification
  severity, negative-cost handling, and stale-ctx safety.

### Changed

- `withLedgerLock` is now a thin wrapper over a shared `withFileLock`, and the
  rates cache is written under the same discipline (`withRatesLock`), so two
  sessions refreshing at once cannot persist the older snapshot.

## [0.6.1] - 2026-10-14
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
