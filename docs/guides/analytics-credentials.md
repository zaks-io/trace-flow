# Analytics identifiers and API credentials

Trace Flow authenticates the `X-Trace-Flow-Api-Key` credential against KV. After
authentication, the proxy derives `sha256:<lowercase SHA-256 digest>` for analytics.
The digest uses the existing Web Crypto implementation; see
[Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
API keys are randomly generated UUIDs, not user-selected passwords.

The existing queue `apiKey` and Tinybird `ApiKey` names are retained for wire and
schema compatibility. Their new values are identifiers, not usable credentials.
Both proxy and OTLP ingestion use the authenticated identifier. The consumer also
normalizes old queue messages and old durable batches before Tinybird insertion.
Legacy queue retries keep their original shard routing so their message ledger
still applies.

Convex derives the same identifiers for analytics tokens, filters, body ownership
queries, alerts, deletion, and retention updates. Read pipes normalize historical
raw-key rows and old token parameters, and return identifiers. This preserves
access to retained traces without including credentials in newly minted analytics
tokens. Credential management and proxy authentication still need the credential.

## Release and historical remediation

Deploy compatible Tinybird pipes before Convex begins issuing identifier-scoped
tokens. The production workflow enforces this dependency. The proxy and consumer
then stop new raw-key writes. Existing tokens and old dashboard tabs can continue
to send the previous parameters until they expire or refresh.

This change does not remove historical credentials from Tinybird tables, materialized
rollups, quarantine tables, queue/DLQ messages, durable trace ledgers, or backups.
It also does not redact arbitrary credentials a client places inside a captured
body or OTLP attribute. Do not claim existing credentials have been removed.

Before broader team access, explicitly approve and execute a production remediation:

1. Verify deployed proxy and OTLP requests contain identifiers in the queue and
   Tinybird, and verify org-scoped reads and cross-org rejection.
2. Inventory historical raw-key copies using counts, never credential values.
   Include retained legacy Tinybird tables and durable batcher storage.
3. Rotate affected API credentials through the normal credential-management flow.
   Expire rather than delete the old key records needed to authorize retained
   historical web traces. Hard-deleted records cannot identify those traces; MCP
   deliberately excludes expired keys, so include that access change in the plan.
4. Migrate or expire the historical copies under an approved data-retention plan.
   Account for materialized rollups and backups; changing new writes does not rewrite
   existing storage. A newly exported OTLP span across the identifier cutover has a
   different ledger identity from its pre-cutover copy.
5. Verify old credentials no longer authenticate and raw-key counts have reached
   the agreed retention/remediation target.

Production rotation, data rewrites, and deletion require separate approval. Reverting
the producer reintroduces raw-key writes and is not a safe privacy rollback.

## Done

The code fix is verified when proxy and OTLP queue messages exclude credentials,
legacy durable batches are normalized before insertion, analytics JWTs contain
identifiers, and legacy/current rows remain correctly tenant-scoped. Historical
remediation is complete only after the production checks above, not after unit tests.
