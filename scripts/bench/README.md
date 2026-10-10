# Agent snapshot retirement benchmark

TRA-409 is a measured proposal. It uses synthetic facts in an owned Tinybird Local
container and starts no Workers.

From an isolated worktree with `SBX_AGENT_ID` set:

```sh
bun install --frozen-lockfile
bash scripts/bench/run-agent-snapshot-benchmark.sh \
  --messages 1000000 --runs 10 --output /tmp/agent-snapshot-benchmark.json
python3 -m unittest discover -s scripts/bench -p 'test_*.py'
```

The default and largest safely completed scale is one million base messages. Two
million failed during round 1 loading; 2M, cloud timing and concurrency remain
unvalidated. This round keeps the same 8 GiB container memory limit.

The fixture covers a calendar retention year plus the partial end day. Tools have
one row per message, files half, and PR links, capability observations and review
attributions one hundredth. Four organizations have a 70/10/10/10 distribution.
Corrections include old-date tombstones and new-date live rows. Deleted facts
remain physically present. Costs use binary fractions for exact numeric parity.
Sessions cross the 7-day and 30-day window starts and repeatedly touch `src/benchmark-retention-crossing.ts`; session zero has 46-day-old
messages and an old attribution. End-day facts include activity after the selected
minute-snapped end. The artifact records actual boundary counts and session dates.
The new generator was needed because `generate-agent-snapshot-benchmark.mjs`
generates manifest commits, rather than canonical facts for comparing both paths.

The runner checks `free -h`, requires 8 GiB available, prints `uptime` and `sbx-ps`,
and builds a private workspace using the installed Tinybird CLI Python library.
Run full CI and the benchmark serially: the project user slice has a 12 GiB
limit even when `free -h` reports more available sandbox memory.
Ingestion-only materializations are excluded from this read experiment. Its
uniquely named container carries `sbx.agent`; ports 17181 and 17182 bind only to
loopback. A collision fails without stopping another server. Cleanup removes only
this run's Compose resources, including after SIGTERM or Ctrl-C. Fixture data and
database storage stay in temporary directories and never enter Git.

Batched deterministic `INSERT SELECT numbers()` statements load the six canonical
fact categories. The nine repository snapshot Copy pipes run serially for each
organization, followed by a synchronous manifest append. Both paths read the same
facts. This tests reads and excludes ingest transport and scheduling delays.

The inventory discovers all web/MCP agent endpoints plus pricing and ADR 0019
signals. The runner generates benchmark `.pipe` files **only in its temporary
project**. No `.pipe` or `.datasource` may exist anywhere under `scripts/bench`;
the safety test checks recursively. Deployment safety therefore holds regardless
of Tinybird scan depth or deployment include settings.

Direct variants reuse Copy aggregation states and current serving SQL. Date-key
bounds include the partial end day with `toDate(EventAt) <= toDate(end - 1ms)`.
Start bounds mirror the endpoint's plan clamp, including prior periods and the
notable-changes trailing baseline. Downstream bucket/session predicates stay
unchanged. Three already-raw endpoints retain their existing contracts; priced
usage reads plan-visible facts and ignores the selected window.

Six lifetime endpoints also receive a two-stage variant. It discovers
sessions with last activity in the requested window or distribution's prior
period, probing through the current published day to exclude later activity. It then aggregates only
those sessions' facts from `now() - retention_days` to the selected end, using the
organization/date/session key prefix. Review attribution decisions are clipped to
that plan range too. These results inform a product decision about session history;
they do not silently redefine the deployed endpoints. File attention discovers
repo/session/path candidates using the Copy's structured-file and error-hint
contributors, then preserves candidate path membership after retained aggregation.
Other lifetime endpoints discover sessions from their message/tool/file/PR contributors.
Candidate subqueries may be evaluated repeatedly across contributors; reported
timing and scan costs include that work. Stage 1 has no `EventAt < now()` predicate, matching current published-day views.
Generated bounds reuse each endpoint's normalized `WITH` start/end expressions,
including its default and reversed-window behavior.

The runner measures 7/7, production-default 7/30 and 30/30 window/retention sets
with a minute-snapped end. It alternates path order, discards one warmup per path,
and records ten samples per path. HTTP timing includes JSON parsing. Database
timing and scan volume come from query statistics; p95 uses nearest rank and scan
volume uses the maximum observed. Hashes preserve exact values and row order;
only the unordered priced-usage relation uses an exact row multiset.

A parity or budget failure is a completed experiment. Endpoint errors cause a
nonzero exit after evidence and cleanup. The artifact retains synthetic parity
examples, samples, hashes, Copy timings, fixture counts, source/query hashes, CLI,
Python, ClickHouse and image versions, resource limits, and `system.parts` counts
at measurement start. Timing varies with shared sandbox load.

To inspect generated SQL without starting a container, use an external directory:

```sh
bash scripts/bench/run-agent-snapshot-benchmark.sh \
  --write-queries /tmp/tra-409-queries --output /tmp/unused.json
```

Use `--messages 100000` for a small end-to-end check of the setup and query paths.
It does not validate performance or every full-scale boundary session.
`--setup-only` builds every variant and cleans up without loading facts.

The recursive resource-discovery guard can run without Docker or fixture loading:

```sh
PYTHONPATH=scripts/bench python3 -m unittest \
  test_agent_benchmark.RunnerContractTests.test_no_deployable_benchmark_resources_at_any_depth
```

TRA-410 owns CI wiring; this benchmark adds no CI jobs. The full suite above also
checks the fail-fast end-day evidence assertion. Use at least 100,000 messages for
an end-to-end run so every category includes the designated end-day cases.
