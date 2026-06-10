# Verification scripts

Independent reconciliation checks that recompute ground truth from raw local sources and diff it
against what landed in the data plane — so you can trust the dashboard, or catch parser/ingestion
drift before you do.

## `agent_usage_reconcile.py`

Reconciles agent-analytics token + cost: **raw `~/.claude/projects` + `~/.codex/sessions` logs** vs
**Tinybird `agent_message_facts`** vs (optionally) **ccusage**. Recomputes ground truth with the same dedup
rules the Rust parser uses (Claude: first-seen output / max input+cache per `message.id`; Codex: diff
cumulative `total_token_usage` snapshots, skip non-advancing duplicates — ccusage#884).

```bash
# 30-day reconciliation, all sources, strict 3% tolerance, with ccusage cross-check:
python3 scripts/verify/agent_usage_reconcile.py --days 30 --ccusage

# just Codex, last 7 days:
python3 scripts/verify/agent_usage_reconcile.py --days 7 --source codex
```

- Exits non-zero if any metric is outside tolerance (CI-friendly).
- Tolerance auto-relaxes for short windows: the script buckets a session by its start time while
  Tinybird buckets each turn by `EventAt`, so sessions straddling the window edge create a larger
  _fractional_ skew at 7d than 30d. 30d+ is the strict check; trust that one.
- Requires `tb` authed to the target workspace (`tb --cloud workspace current`). `--ccusage` needs the
  `ccusage` CLI (Claude only — it does not price Codex models).

Background and a worked example: `docs/guides/agent-conversation-analytics/codex-usage-verification.md`.
