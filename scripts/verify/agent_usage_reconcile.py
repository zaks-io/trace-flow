#!/usr/bin/env python3
"""Reconcile agent-analytics usage: raw local transcripts vs Tinybird vs (optionally) ccusage.

Independently recomputes token + cost ground truth from the raw `~/.claude/projects` and
`~/.codex/sessions` logs using the SAME dedup rules the Trace Flow parser uses, queries the live
Tinybird `agent_message_facts` datasource, and prints a per-source diff with a pass/fail tolerance. Use it
to catch parser/ingestion drift (dropped turns, double-counts, pricing skew) before trusting the UI.

Ground-truth rules (must match the parser — see docs/.../codex-usage-verification.md):
  - Claude: dedup assistant records by `message.id`. Claude re-emits one message.id across streaming
    records — output_tokens GROWS across them (take FIRST-seen = the billed value), while input/cache
    fields finalize on the LATER record (take MAX). Using max for output over-counts ~5%.
  - Codex: DIFF successive cumulative `total_token_usage` snapshots; skip rows whose cumulative did
    not advance (duplicate emissions); fall back to `last_token_usage` only on reset/rollback. Summing
    `last_token_usage` over-counts (ccusage#884); summing `total_token_usage` is the ~331x trap.

Why a small (<2%) diff is expected and OK: the script buckets a session by its start time, Tinybird
buckets each turn by its own `EventAt`. Sessions straddling the window edge split differently. The
tolerance accounts for this; a larger diff means real drift.

Usage:
  python3 scripts/verify/agent_usage_reconcile.py [--days 30] [--source claude|codex|all]
                                                  [--tolerance 0.03] [--ccusage]
Requires: `tb` authed to the target cloud workspace (`tb --cloud workspace current`). `--ccusage`
additionally requires the `ccusage` CLI (Claude only).

Exit code 0 if every checked metric is within tolerance, 1 otherwise (CI-friendly).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import time
from collections import defaultdict

CLAUDE_ROOT = os.path.expanduser("~/.claude/projects")
CODEX_ROOT = os.path.expanduser("~/.codex/sessions")

# models.dev rates (USD per 1M tokens). Kept here only for the script's own cost estimate; Tinybird's
# cost is authoritative (priced by the consumer against the live catalog). If models.dev changes, the
# absolute cost check may drift — token checks are the load-bearing ones.
PRICING = {
    "claude-opus-4-7": {"in": 15, "out": 75, "cr": 1.5, "cw": 18.75},
    "claude-opus-4-8": {"in": 15, "out": 75, "cr": 1.5, "cw": 18.75},
    "claude-sonnet-4-6": {"in": 3, "out": 15, "cr": 0.3, "cw": 3.75},
    "claude-haiku-4-5-20251001": {"in": 1, "out": 5, "cr": 0.1, "cw": 1.25},
    "claude-haiku-4-5": {"in": 1, "out": 5, "cr": 0.1, "cw": 1.25},
}
# gpt-5.5 has a context tier ≥272k prompt tokens; handled in codex cost below.
GPT55_BASE = {"in": 5, "out": 30, "cr": 0.5}
GPT55_TIER = {"in": 10, "out": 45, "cr": 1.0}
GPT55_THRESHOLD = 272_000


def iter_jsonl(path):
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def within_window(mtime, cutoff):
    return mtime >= cutoff


# --- Claude ground truth -------------------------------------------------------------------------

def claude_truth(cutoff):
    """Per-model token totals from raw Claude transcripts, deduped by message.id (first-seen output,
    max input/cache — see module docstring)."""
    seen = {}
    for f in glob.glob(CLAUDE_ROOT + "/**/*.jsonl", recursive=True):
        if not within_window(os.path.getmtime(f), cutoff):
            continue
        for o in iter_jsonl(f):
            if o.get("type") != "assistant":
                continue
            m = o.get("message") or {}
            u = m.get("usage")
            if not u:
                continue
            mid = m.get("id")
            if mid is None:
                continue
            inp = u.get("input_tokens", 0) or 0
            out = u.get("output_tokens", 0) or 0
            cc = u.get("cache_creation_input_tokens", 0) or 0
            cr = u.get("cache_read_input_tokens", 0) or 0
            prev = seen.get(mid)
            if prev is None:
                # First occurrence: its output_tokens is the BILLED value. Claude re-emits the same
                # message.id across streaming records with growing output_tokens, so first-seen output
                # matches ccusage / the parser; max/last over-counts output ~5%.
                seen[mid] = {"model": m.get("model", ""), "in": inp, "out": out, "cc": cc, "cr": cr}
            else:
                # Input/cache fields finalize on the LATER record (full cache info), so keep the max of
                # those; leave output at the first-seen value.
                prev["in"] = max(prev["in"], inp)
                prev["cc"] = max(prev["cc"], cc)
                prev["cr"] = max(prev["cr"], cr)
    agg = defaultdict(lambda: {"in": 0, "out": 0, "cc": 0, "cr": 0, "msgs": 0})
    for v in seen.values():
        a = agg[v["model"]]
        a["in"] += v["in"]
        a["out"] += v["out"]
        a["cc"] += v["cc"]
        a["cr"] += v["cr"]
        a["msgs"] += 1
    return agg


def claude_cost(model, t):
    p = PRICING.get(model)
    if not p:
        return None
    return (t["in"] * p["in"] + t["out"] * p["out"] + t["cr"] * p["cr"] + t["cc"] * p["cw"]) / 1e6


# --- Codex ground truth (ccusage-correct: diff cumulative + dedup) -------------------------------

def codex_truth(cutoff):
    totals = {"unc_in": 0, "cr": 0, "out": 0, "cost": 0.0, "turns": 0, "sessions": 0}
    for f in glob.glob(CODEX_ROOT + "/**/*.jsonl", recursive=True):
        if not within_window(os.path.getmtime(f), cutoff):
            continue
        prev = None  # (raw_in, cached, out, total)
        counted = False
        for o in iter_jsonl(f):
            p = o.get("payload", o)
            if (p.get("type") or o.get("type")) != "token_count":
                continue
            info = p.get("info") or {}
            tt = info.get("total_token_usage") or {}
            ci, cc, co, ct = (
                tt.get("input_tokens"), tt.get("cached_input_tokens"),
                tt.get("output_tokens"), tt.get("total_tokens"),
            )
            if None in (ci, cc, co, ct):
                continue
            if prev is None:
                d_raw, d_cached, d_out = ci, cc, co
            elif ct == prev[3]:
                continue  # duplicate snapshot
            elif ct < prev[3]:
                lt = info.get("last_token_usage") or {}
                d_raw = lt.get("input_tokens", 0) or 0
                d_cached = lt.get("cached_input_tokens", 0) or 0
                d_out = lt.get("output_tokens", 0) or 0
                prev = (ci, cc, co, ct)
                _add_codex(totals, d_raw, d_cached, d_out)
                counted = True
                continue
            else:
                d_raw, d_cached, d_out = ci - prev[0], cc - prev[1], co - prev[2]
            prev = (ci, cc, co, ct)
            _add_codex(totals, d_raw, d_cached, d_out)
            counted = True
        if counted:
            totals["sessions"] += 1
    return totals


def _add_codex(totals, raw_in, cached, out):
    unc = max(0, raw_in - cached)
    cached = max(0, cached)
    out = max(0, out)
    rates = GPT55_TIER if (unc + cached) >= GPT55_THRESHOLD else GPT55_BASE
    totals["unc_in"] += unc
    totals["cr"] += cached
    totals["out"] += out
    totals["cost"] += (unc * rates["in"] + cached * rates["cr"] + out * rates["out"]) / 1e6
    totals["turns"] += 1


# --- Tinybird ------------------------------------------------------------------------------------

def tb_scalar_row(where):
    """Query Tinybird, returning (in, out, cc, cr, cost) summed over `where`. Uses a concat sentinel
    so parsing is independent of tb's table formatting."""
    sql = (
        "SELECT concat('RECON|',"
        "toString(sum(input_tokens)),'|',toString(sum(output_tokens)),'|',"
        "toString(sum(cache_creation_tokens)),'|',toString(sum(cache_read_tokens)),'|',"
        "toString(round(sum(cost_usd),2))) r "
        f"FROM agent_message_facts WHERE {where}"
    )
    out = subprocess.run(
        ["tb", "--cloud", "sql", sql], capture_output=True, text=True, timeout=60
    )
    for line in out.stdout.splitlines():
        if "RECON|" in line:
            parts = line.split("RECON|", 1)[1].strip().split("|")
            vals = [p.strip() for p in parts]
            def num(x):
                return 0 if x in ("", "\\N", "None") else (float(x) if "." in x else int(x))
            return {
                "in": num(vals[0]), "out": num(vals[1]),
                "cc": num(vals[2]), "cr": num(vals[3]), "cost": num(vals[4]),
            }
    raise RuntimeError(f"could not parse tb output:\n{out.stdout}\n{out.stderr}")


# --- ccusage (Claude only, optional) -------------------------------------------------------------

def ccusage_claude(days):
    import datetime
    cut = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    out = subprocess.run(
        ["ccusage", "--json", "--breakdown"], capture_output=True, text=True, timeout=120
    )
    d = json.loads(out.stdout)
    T = {"in": 0, "out": 0, "cc": 0, "cr": 0, "cost": 0.0}
    for day in d.get("daily") or []:
        if (day.get("date") or "") < cut:
            continue
        for mb in day.get("modelBreakdowns", []) or []:
            T["in"] += mb.get("inputTokens", 0) or 0
            T["out"] += mb.get("outputTokens", 0) or 0
            T["cc"] += mb.get("cacheCreationTokens", 0) or 0
            T["cr"] += mb.get("cacheReadTokens", 0) or 0
            T["cost"] += mb.get("cost", 0) or 0
    return T


# --- diff + report -------------------------------------------------------------------------------

def pct(a, b):
    if b == 0:
        return 0.0 if a == 0 else 100.0
    return abs(a - b) / b * 100.0


def compare(label, truth, tb, tol, fields, failures):
    print(f"\n  {label}")
    print(f"    {'metric':14} {'ground truth':>16} {'tinybird':>16} {'Δ%':>7}  ok")
    for key, name in fields:
        gt = truth.get(key, 0)
        tv = tb.get(key, 0)
        delta = pct(tv, gt)
        ok = delta <= tol * 100
        if not ok:
            failures.append(f"{label} {name}: truth={gt:,} tb={tv:,} ({delta:.1f}% > {tol*100:.0f}%)")
        print(f"    {name:14} {gt:>16,.0f} {tv:>16,.0f} {delta:>6.2f}%  {'✓' if ok else '✗ FAIL'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--source", choices=["claude", "codex", "all"], default="all")
    ap.add_argument("--tolerance", type=float, default=0.03,
                    help="max fractional diff at 30d before a metric fails (default 0.03 = 3%%). "
                         "Auto-relaxed for shorter windows where edge-bucketing skew is larger.")
    ap.add_argument("--ccusage", action="store_true", help="also cross-check Claude vs ccusage")
    args = ap.parse_args()

    # The ground-truth-vs-Tinybird skew is dominated by sessions straddling the window edge (the script
    # buckets by session start, Tinybird by per-turn EventAt). That skew is ~constant in absolute terms,
    # so as a FRACTION it grows for shorter windows. Scale the tolerance by 30/days (floor at the base)
    # so a clean 7d run isn't a false failure while 30d+ stays strict.
    tol = max(args.tolerance, args.tolerance * 30.0 / max(args.days, 1))

    cutoff = time.time() - args.days * 86400
    where_window = f"role='assistant' AND EventAt >= now() - INTERVAL {args.days} DAY"
    failures = []

    print(f"Agent usage reconciliation — last {args.days} days "
          f"(tolerance {tol*100:.1f}%{'' if tol == args.tolerance else f', relaxed from {args.tolerance*100:.0f}% for the short window'})")
    print("ground truth = raw local transcripts (parser dedup rules); tinybird = agent_message_facts")

    if args.source in ("claude", "all"):
        agg = claude_truth(cutoff)
        ct = {"in": 0, "out": 0, "cc": 0, "cr": 0}
        for t in agg.values():
            for k in ct:
                ct[k] += t[k]
        tb = tb_scalar_row(f"source='claude' AND {where_window}")
        compare("CLAUDE (tokens)", ct, tb, tol,
                [("in", "input"), ("out", "output"), ("cc", "cache_create"), ("cr", "cache_read")],
                failures)
        # per-model token table (no pass/fail, informational)
        print("\n    per-model (ground truth tokens):")
        for model, t in sorted(agg.items(), key=lambda x: -sum(x[1].values())):
            c = claude_cost(model, t)
            cstr = f"${c:,.2f}" if c is not None else "unpriced"
            print(f"      {model:30} msgs={t['msgs']:>5} in={t['in']:>9,} out={t['out']:>9,} "
                  f"cr={t['cr']:>13,} est={cstr}")
        if args.ccusage:
            cc = ccusage_claude(args.days)
            compare("CLAUDE vs ccusage (tokens)", cc, tb, max(tol, 0.03),
                    [("in", "input"), ("out", "output"), ("cc", "cache_create"), ("cr", "cache_read")],
                    failures)

    if args.source in ("codex", "all"):
        cx = codex_truth(cutoff)
        truth = {"in": cx["unc_in"], "out": cx["out"], "cc": 0, "cr": cx["cr"], "cost": cx["cost"]}
        tb = tb_scalar_row(f"source='codex' AND {where_window}")
        compare("CODEX (tokens)", truth, tb, tol,
                [("in", "uncached_in"), ("out", "output"), ("cr", "cache_read")], failures)
        print(f"    codex est cost: ground truth ${cx['cost']:,.2f} vs tinybird ${tb['cost']:,.2f} "
              f"(Δ {pct(tb['cost'], cx['cost']):.1f}%)  [{cx['sessions']} sessions, {cx['turns']} turns]")

    print()
    if failures:
        print(f"✗ {len(failures)} metric(s) outside tolerance:")
        for f in failures:
            print(f"    - {f}")
        print("\nA few % is normal (window-edge bucketing). Larger gaps = investigate parser/ingestion.")
        sys.exit(1)
    print("✓ all checked metrics within tolerance — token counts reconcile.")
    sys.exit(0)


if __name__ == "__main__":
    main()
