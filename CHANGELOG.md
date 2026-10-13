# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/xinghe-labs/pi-spend-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xinghe-labs/pi-spend-guard/releases/tag/v0.1.0
