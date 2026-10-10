# Agent snapshot retirement benchmark

This is the TRA-409 experiment, not a deployment or an accepted replacement design.
It uses synthetic facts and an owned Tinybird Local container. It never starts Workers.

From the repository root:

```sh
bun install --frozen-lockfile
bash scripts/bench/run-agent-snapshot-benchmark.sh --output /tmp/agent-snapshot-benchmark.json
```

The default fixture has two million base messages over a calendar retention year (365 or 366 days). Tools have the same
count, files half, and PR links, capability observations and review attributions one
hundredth. Four organizations have a 70/10/10/10 distribution. Corrections include
old-date tombstones and new-date live rows; deleted facts remain physically present.
Costs use binary fractions so exact numeric parity does not depend on float summation
order. One session deliberately crosses the requested window boundary. Its recent events
and high cost put it on the first browser and review-cost pages; its attribution
decision predates both measured windows.

The runner checks available memory and project processes, uses the repository's Tinybird
Local Compose file with a 8 GiB container limit, generates private local tokens, and
builds an isolated local workspace through the installed Tinybird CLI Python library.
Ingestion-only materializations are excluded from this read experiment.
Its uniquely named container carries `sbx.agent`. TCP ports 17181 and 17182 must be
available; a collision fails without stopping another server. Cleanup removes only
this run's Compose resources, including after SIGTERM or Ctrl-C. Generated facts and
database storage are temporary and never enter Git.

Facts load with deterministic `INSERT SELECT numbers()` statements. The actual nine
repository snapshot Copy pipes run serially for each organization over these facts.
A synchronous manifest append publishes each complete generation. This setup tests
read behavior and excludes the ingest transport and scheduling delays.

All web/MCP agent endpoints plus pricing and ADR 0019 signals are discovered by the
inventory function. `pipes/` here contains generated benchmark-only direct variants,
outside the deployment includes in the root Tinybird config. They reuse Copy
aggregation states and the current endpoint SQL, replacing published relations with
org-scoped canonical `FINAL` reads over the requested dates. Existing raw reads also
receive explicit bounds. This intentionally tests whether the bounded shape preserves
current results; lifetime session totals and attribution decisions may fail parity.

The runner alternates paths, discards one warmup per path, and records ten measured
requests per path for both 7 and 30 days. HTTP timing includes client JSON parsing.
Database timing, rows read and bytes read come from the endpoint's query statistics.
p95 uses nearest rank, so ten runs use the slowest measured request. The reported scan
volume is the maximum observed. Output hashes preserve row order and exact values.
Only `agent_priced_usage`, an unordered generic relation exposed as a local endpoint,
uses an exact row multiset. Duplicate multiplicity remains significant.

A negative budget or parity result is a completed experiment. Endpoint errors make the
runner exit nonzero after writing available evidence and cleaning up. The output
contains samples, hashes, mismatch examples, Copy timings and the actual fixture counts.
Timing varies with shared sandbox load. Use the guide's recorded image and CLI versions
when comparing reruns. The generated SQL can be refreshed without starting a container:

```sh
bash scripts/bench/run-agent-snapshot-benchmark.sh --write-queries --output /tmp/unused.json
python3 -m unittest discover -s scripts/bench -p 'test_*.py'
```

Use `--messages 20000` for a small end-to-end validation run. It proves the setup and
query path, not the full-scale performance budget. `--setup-only` builds every variant
and cleans up without loading facts or measuring requests.
