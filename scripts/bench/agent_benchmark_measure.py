"""Alternating endpoint measurements with strict, ordered JSON output parity."""

import hashlib
import json
import math
import statistics
import time

from agent_benchmark_queries import SIGNALS, LIFETIME


def output_hash(endpoint, data):
    rows = [
        json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False)
        for row in data
    ]
    if endpoint == "agent_priced_usage":
        # The generic priced-usage relation has no ORDER BY; compare its exact row multiset.
        rows.sort()
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def summarize(samples):
    def p95(values):
        return sorted(values)[math.ceil(len(values) * 0.95) - 1]

    return {
        "median_ms": statistics.median([x["wall_ms"] for x in samples]),
        "p95_ms": p95([x["wall_ms"] for x in samples]),
        "median_db_ms": statistics.median([x["db_ms"] for x in samples]),
        "rows_read": max(x["rows_read"] for x in samples),
        "bytes_read": max(x["bytes_read"] for x in samples),
    }


def measure(client, endpoints, end_ms, runs, output):
    records = []
    for days, retention in ((7, 7), (7, 30), (30, 30)):
        base = {
            "org_id": "benchmark-org",
            "start_time_ms": str(end_ms - days * 86400000),
            "end_time_ms": str(end_ms),
            "retention_days": str(retention),
        }
        for endpoint in endpoints:
            params = dict(base)
            if endpoint in SIGNALS:
                params["repo_fingerprint"] = (
                    "benchmark-repo-0-" + hashlib.sha256(b"0").hexdigest()
                )
            if endpoint == "agent_session_identity":
                params["session_pk"] = (
                    "benchmark-session-0-" + hashlib.sha256(b"0").hexdigest()
                )
            current = (
                "bench_current_" + endpoint
                if endpoint == "agent_priced_usage"
                else endpoint
            )
            paths = {"current": current, "direct": "bench_direct_" + endpoint}
            if endpoint in LIFETIME:
                paths["two_stage"] = "bench_two_stage_" + endpoint
            samples = {path: [] for path in paths}
            hashes = {path: [] for path in paths}
            output_rows = {}
            examples = {}
            error = None
            try:
                for iteration in range(runs + 1):
                    order = (
                        tuple(paths) if iteration % 2 == 0 else tuple(reversed(paths))
                    )
                    for path in order:
                        started = time.perf_counter()
                        result = client.pipe_data(paths[path], params=params)
                        wall_ms = (time.perf_counter() - started) * 1000
                        stats = result["statistics"]
                        data = result["data"]
                        digest = output_hash(endpoint, data)
                        sample = {
                            "wall_ms": wall_ms,
                            "db_ms": stats["elapsed"] * 1000,
                            "rows_read": stats["rows_read"],
                            "bytes_read": stats["bytes_read"],
                        }
                        output_rows[path] = len(data)
                        if not iteration:
                            examples[path] = data[:2]
                        if iteration:
                            samples[path].append(sample)
                            hashes[path].append(digest)
            except Exception as exc:
                # Fixture identifiers only. Never include HTTP exception URLs carrying local credentials.
                error = type(exc).__name__
            record = {
                "endpoint": endpoint,
                "days": days,
                "retention_days": retention,
                "params": params,
                "parity_examples": examples,
                "samples": samples,
                "output_rows": output_rows,
                "hashes": hashes,
                "error": error,
            }
            if not error:
                record.update(
                    {path: summarize(values) for path, values in samples.items()}
                )
                current_bytes = record["current"]["bytes_read"]
                for path in paths:
                    if path == "current":
                        continue
                    parity = len(set(hashes["current"] + hashes[path])) == 1
                    stats = record[path]
                    budget = (
                        stats["median_ms"] <= 1000
                        and stats["p95_ms"] <= 2000
                        and stats["bytes_read"] <= current_bytes * 3
                    )
                    ratio = (
                        stats["bytes_read"] / current_bytes if current_bytes else None
                    )
                    if path == "direct":
                        record.update(
                            parity=parity,
                            budget_passed=budget,
                            byte_ratio=ratio,
                            passed=parity and budget,
                        )
                    else:
                        record["two_stage_result"] = dict(
                            parity=parity,
                            budget_passed=budget,
                            byte_ratio=ratio,
                            passed=parity and budget,
                        )
            records.append(record)
            output.write_text(json.dumps(records, indent=2) + "\n")
            print(
                json.dumps(
                    {
                        k: record.get(k)
                        for k in (
                            "endpoint",
                            "days",
                            "retention_days",
                            "current",
                            "direct",
                            "parity",
                            "two_stage",
                            "two_stage_result",
                            "passed",
                            "error",
                        )
                    }
                ),
                flush=True,
            )
    return records
