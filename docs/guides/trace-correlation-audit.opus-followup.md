> Review provenance: focused read-only follow-up in persistent Opus 5.5 high session `fcb69b93-21bc-41d5-9d0f-e3ab663e4e9d`, 2026-10-04. Ten CLI turns, no permission denials. Reviewed the final copied-header fix and report corrections; verdict conditional on final CI and validation wording. The report is preserved below. Several cited line numbers refer to diff output rather than current source: the shared constant is near the beginning of `packages/utils/src/trace-context.ts`, and the per-envelope comment is in `processQueueBatch` in the consumer entry. Use current source for exact locations. No hosted review, merge or deployment approval is implied.

## FOLLOW-UP REVIEW REPORT

**Review mode:** INDEPENDENT focused follow-up in the same Opus 5.5 high session, read-only. I didn't run any commands, so I have not run or observed CI.
**Target:** working tree on `codex/trace-correlation-audit` against base `e3643a9`.
**Delta reviewed:**

- the parts of `/tmp/trace-flow-audit-review-final.diff` that differ from the initial snapshot (`apps/mcp/src/index.ts`, `apps/mcp/src/__tests__/index.test.ts`, `packages/utils/src/trace-context.ts`, `apps/proxy/src/pipeline/forwardToUpstream.ts`, `apps/proxy-consumer/src/index.ts`, the `sentry-tracing.ts` comment)
- the updated sections of `docs/guides/trace-correlation-audit.md`

### F1 (record validation and review): resolved, with one wording fix

- `audit.md:197-254` now records the CI results, the runtime limits (Node 24.21 and Bun 1.4.2, plus why pinned Bun 1.3.5 couldn't run), the author QA, a link to the verbatim initial review (the file is present), the pending follow-up, and that hosted review is still required on the exact committed head. Done (`:262`) is now backed by that section, as long as the final CI result gets added.
- **Remaining correction (P3, docs):** `audit.md:217` says "Full local CI passed" with no timing. That run happened before the G1 header change. Until the rerun finishes, say it was on the tree before the header change, then add the final result. Otherwise the doc implies the final tree is green.

### G1 (copied trace headers to Convex): resolved

- `TRACE_CONTEXT_HEADERS` (`packages/utils/src/trace-context.ts:586-591`) is exported through the utils barrel (`utils/src/index.ts:2`). The provider list now spreads the shared constant, so provider stripping still covers `sentry-trace`, `tracestate`, `baggage` and `traceparent`, and the existing test still covers all four.
- **`proxyConnect`:** headers are deleted on the cloned `new Request(url, c.req.raw)`. That leaves the request body, method and `Authorization` alone. The register test still checks the JSON body comes through, and the metadata and register tests check that none of the four headers reach the backend.
- **`proxyToken`:** headers are deleted on the cloned `Headers` before the content-type check and body read. The form body, the `resource` default, the 415 and 413 paths, and the auth and OAuth contract are unchanged. The token test checks the headers are absent and the form fields arrive intact.
- **No ingress stripping:** only the clones are changed; `c.req.raw` isn't touched. Sentry's ingress handling, the IP rate limit (`index.ts:297-303`) and `mcpResourceUrl` all read the original request. The SDK won't add its own headers back: the test origin `connect.test` doesn't match any target, and production `connect.*` is excluded by the regex covered in `sentry-tracing.test.ts`. This is an outbound-only policy fix; ingress trust is unchanged.

### Other corrections

- **G2:** the trust and unsampled caveats are at `audit.md:73-75`. Accepted.
- **G5:** the coordinated upgrade constraint is at `audit.md:188-190`. Accepted.
- **G6:** the skipped OTel setup and unwrapped DO are noted at `audit.md:213-215`. Accepted.
- **G7:** the comment at `proxy-consumer/src/index.ts:326` no longer claims a memory improvement over baseline. Accepted.
- **G8:** `ResolvedMessage.resolved` is now `ResolvedQueueItem`. The hypothetical inline throw is left unchanged on purpose. Accepted.
- **G3 and G4** stay explicitly acknowledged as a trade-off and as debt. Accepted as documented.
- **Nit, no action needed:** the reflowed `sentry-tracing.ts` comment breaks oddly at "would / match". Prettier won't flag it.

### Findings

No new blocking findings. I found no regression in the delta.

### Verdict

**APPROVE**, provided that:

1. the full CI rerun on the final tree comes back green, and its result is recorded in `audit.md`;
2. `audit.md:217` says the earlier pass ran on the tree before the header change.

Further notes:

- **Review evidence label:** LEAVE UNCHANGED. This is still an uncommitted working tree with no PR or fingerprint, and I haven't been authorised to approve a commit, PR or deploy.
- **Hosted review:** still required before merge, on the exact committed head, because this changes queue ack and data-flow behaviour.
