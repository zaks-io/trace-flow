# Opus 5.5 final causal-link correction review

Session: `77ba62d0-fbed-4d20-bcd8-0466c3a16512`, high effort, read-only static review.
Target: uncommitted working tree at `e3643a9f19da87fe8cb03fb6f8c89f16c9ce68ba`.
Source fingerprint at final correction review start: `3adb189db8f2450f457c8461e5a585db94239e465005ef089cb37176e57be233`.

# Review of the `beforeSendSpan` removal

**Verdict: conditional approval for local handoff, provided the rerun of the full local CI passes.** I found no material issues. This approves nothing for production, deploy, commit or merge.

**Scope:** a static review of the current source in the uncommitted working tree on base `e3643a9`. I didn't run any tests; the pass counts below are from your report.

## Causal links now survive

- `sentryRequestPrivacy()` returns only the integrations, `beforeSend` and `beforeSendTransaction` (`sentry-tracing.ts:80-91`).
- Nothing in `apps/` or `packages/` sets `beforeSendSpan`, `ignoreSpans` or span streaming. So transactions skip the root conversion in `processBeforeSend` (`client.js:736-778`) and go straight to `beforeSendTransaction`.
- `scrubRequestEvent` edits `contexts.trace.data`, each `event.spans[].data` and breadcrumb data in place. It never rebuilds the trace context, so links on the root (alarm to producer) and on child spans (the batch flush span) are left alone.
- **Tests:** the unchanged AgentDelivery alarm tests (`agent-delivery-tracing.integration.test.ts:254,310`) assert `contexts.trace.links` on the exported transaction, and `sentry-tracing.test.ts:26,65` checks that links survive the scrubber.

## Privacy still holds

- The root span's attributes and every child span's attributes are scrubbed directly. That covers the same keys the old span callback handled: the URL fields, query and fragment, and `http.request.header.*`.
- `request-privacy.integration.test.ts:106` now asserts that no envelope item of type `span` is emitted with these options, which closes the only path a span-level callback would have covered.
- **Your correction is accepted:** the global fetch mock bypasses the SDK's own fetch instrumentation, so the Proxy test does not exercise real outgoing fetch spans. Child-span URL and header scrubbing is proven by the helper test's serialized child spans. The Proxy root span, rate-limit span, exception and full envelope export are real SDK output.

## Sampling context (unchanged since my last report)

- On our own traces at a sample rate of 1, `trace_id`, `public_key` and `sample_rate: "1"` are always present.
- A field is omitted only when an incoming customer-headed value fails validation, for example an exponent-form `sample_rate`. That trades sampling-context completeness for not exporting untrusted values. Local trace IDs, span IDs and flags are unaffected, so this isn't material.

## Mechanical changes

- **`consumer.test.ts:15`:** the `getActiveSpan: () => undefined` mock matches what the native helper sees in that deliberately uninstrumented test, and the test's assertions are unchanged.
- **Fact-batcher:** the `30` constant is the same value as before and the inaccurate comment is gone.

## Verification after review

The final full local gate passed on 2026-10-05:64/64 tasks, 3,060 package tests,
one existing skip. Log: `/tmp/trace-flow-correlation-verified-ci.log`.
The conditional local approval's CI requirement is satisfied.

One test-only delta after this static review removes a redundant remote-error
preflight/eviction cycle. It observes the reconstructed error during the real
cold RPC inside the caller flow instead. Its remote, retry, no-ack and trace
assertions remain; all 3 focused tests and 352 Agent Consumer tests pass.
Production source is unchanged since the reviewed snapshot. Author QA inspected
this delta; no new independent review of that test-only rewrite is claimed.
Current source fingerprint:
`212d180ae6e3fe51b791778e14067ae65578a339095b223f171f97c5e5078272`.
