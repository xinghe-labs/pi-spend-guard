# Contributing

Thanks for looking. This is a small, focused extension; the goal is that every
line is defensible.

## Setup

```bash
npm install --ignore-scripts
npm test          # the whole suite, no network, no model calls
npm run typecheck
```

Node >= 22.19 is required. There are no runtime dependencies, and that is
deliberate — the extension runs inside someone else's agent process, so every
dependency is a liability.

## What the project cares about

**A budget guard that silently does nothing is worse than no guard.** Most of
the design follows from that one rule:

- Never count an unknown price as `$0`. If nothing can price a call, the record
  is flagged `unpriced` and the user is told, because a guard that looks healthy
  while enforcing nothing is the failure mode this project exists to remove.
- Never invent a number. An ambiguous published price yields no price rather
  than a plausible guess; a missing input makes the pre-flight projection return
  `0` rather than a guess that could block a good request.
- Fail open. Every hook is wrapped so a budgeting bug cannot take down a
  session or wedge a provider request. Where a trade-off is unavoidable it is
  documented in the code next to the decision.
- Say what actually happened. A block message says `would take session spend to
  $X`, not `exhausted`, when nothing has been spent yet.

## Tests

Changes are expected to come with tests that would fail if the change were
reverted. Some things worth knowing:

- `test/extension.test.ts` drives the real extension through a fake
  `ExtensionAPI`. The fake models pi's behaviour where it matters — including
  that accessing a stale `ctx` **throws**, which is how a deferred callback that
  touches a finished session was caught.
- Time-dependent and cross-process behaviour is tested with real child
  processes (`test/store.test.ts`, `test/ledger.test.ts`), not by calling a
  synchronous function in a loop. A lock that is never contended is not tested.
- If a test needs a threshold to sit between two possible outcomes, work out the
  arithmetic in the comment so the next reader can check it. Several tests exist
  purely to pin an exact dollar value.

## Ledger and config compatibility

`ledger.json` is versioned. New fields on a record must be additive and optional
(see `unpriced` and `rateSource`) so an older ledger still loads; never repurpose
an existing field. The config normalizer treats every value as untrusted and
falls back to a default rather than throwing — and a malformed threshold must
fall back to the default rather than to `null`, because `null` means "disabled".

## Network

The only network access is the published price list, and it is treated as
untrusted input: `https` only (plus `http` on loopback), cross-origin redirects
refused, a size cap, a plausibility ceiling on rates, and the whole payload
discarded if it is mostly implausible. Keep it that way, and keep it off the
enforcement path — the guard must never block a request on a fetch.

## Pull requests

- One concern per PR, with the reasoning in the commit message.
- Run `npm test` and `npm run typecheck` before opening it.
- If you change behaviour the README or CHANGELOG describes, update them in the
  same commit. Doc drift is treated as a bug here.
