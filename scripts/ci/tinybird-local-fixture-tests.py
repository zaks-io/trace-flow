#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from tinybird.tb.modules import test_common
from tinybird.tb.modules.build_common import process as build_project
from tinybird.tb.modules.local_common import get_tinybird_local_client
from tinybird.tb.modules.project import Project
from tinybird_baseline_version_fixtures import (
    bounded_day_chunks,
    verify_baseline_versions,
)


ROOT = Path.cwd()
BASELINE_SOURCES = (
    ("capability_snapshots", "agent_capability_snapshot_facts", "EventAt"),
    ("file_events", "agent_file_event_facts", "EventAt"),
    ("messages", "agent_message_facts", "EventAt"),
    ("pull_request_links", "agent_pull_request_facts", "EventAt"),
    ("review_unit_attributions", "agent_review_unit_attributions", "DecidedAt"),
    ("tool_events", "agent_tool_event_facts", "EventAt"),
)
SNAPSHOT_TARGETS = (
    "agent_context_call_buckets_hourly_snapshots",
    "agent_repositories_snapshots",
    "agent_session_file_signals_snapshots",
    "agent_session_signals_snapshots",
    "agent_session_summaries_snapshots",
    "agent_tool_usage_daily_snapshots",
    "agent_tool_usage_hourly_snapshots",
    "agent_usage_daily_snapshots",
    "agent_usage_hourly_snapshots",
)
VERSION_DAYS = (
    ("agent_capability_snapshot_fact_versions", "EventAt"),
    ("agent_file_event_fact_versions", "EventAt"),
    ("agent_message_fact_versions", "EventAt"),
    ("agent_pull_request_fact_versions", "EventAt"),
    ("agent_review_unit_attribution_versions", "DecidedAt"),
    ("agent_tool_event_fact_versions", "EventAt"),
)
PERFORMANCE_FAMILIES = {
    "agent_session_signals_top_runaway": "session risk",
    "agent_file_attention_top_files": "file hotspots",
    "agent_failure_leaderboard": "tool failures",
    "agent_notable_changes": "repo baselines",
}


def query_rows(client, sql: str) -> list[dict]:
    result = client.query(f"{sql} FORMAT JSON")
    rows = result.get("data")
    if not isinstance(rows, list):
        raise RuntimeError("Tinybird Local SQL returned no data array")
    return rows


def run_copy(client, pipe: str, params: dict[str, str]) -> None:
    response = client.pipe_run(pipe, "copy", params, "append")
    job_id = response.get("job", {}).get("job_id")
    if not isinstance(job_id, str) or not job_id:
        raise RuntimeError(f"{pipe} returned no job receipt")
    client.wait_for_job(job_id, backoff_seconds=0.05, maximum_backoff_seconds=0.25)


def seed_versioned_facts(client) -> None:
    copy_attempt = str(int(time.time() * 1000))
    for category, datasource, timestamp_column in BASELINE_SOURCES:
        rows = query_rows(
            client,
            f"""
            SELECT
                OrgId,
                toString(min(toDate({timestamp_column}))) AS StartDay,
                toString(max(toDate({timestamp_column}))) AS EndDay
            FROM {datasource}
            GROUP BY OrgId
            ORDER BY OrgId
            """,
        )
        for row in rows:
            start_day = str(row["StartDay"])
            end_day = str(row["EndDay"])
            for chunk_start_day, chunk_end_day in bounded_day_chunks(start_day, end_day):
                run_copy(
                    client,
                    f"repair_agent_{category}_versions_baseline",
                    {
                        "org_id": str(row["OrgId"]),
                        "start_day": start_day,
                        "end_day": end_day,
                        "chunk_start_day": chunk_start_day,
                        "chunk_end_day": chunk_end_day,
                        "copy_attempt": copy_attempt,
                    },
                )


def published_days(client) -> dict[str, list[str]]:
    unions = " UNION ALL ".join(
        f"SELECT OrgId, toDate({timestamp_column}) AS SnapshotDay FROM {datasource} FINAL WHERE IsDeleted = 0"
        for datasource, timestamp_column in VERSION_DAYS
    )
    rows = query_rows(
        client,
        f"""
        SELECT OrgId, arraySort(groupUniqArray(toString(SnapshotDay))) AS SnapshotDays
        FROM ({unions})
        GROUP BY OrgId
        ORDER BY OrgId
        """,
    )
    result: dict[str, list[str]] = {}
    for row in rows:
        days = row.get("SnapshotDays")
        if not isinstance(days, list) or not days or not all(isinstance(day, str) for day in days):
            raise RuntimeError("Canonical fixture query returned invalid snapshot days")
        result[str(row["OrgId"])] = days
    return result


def seed_published_snapshots(client) -> None:
    generation = 1
    manifests = []
    for org_id, days in published_days(client).items():
        params = {
            "org_id": org_id,
            "snapshot_days": ",".join(days),
            "snapshot_generation": str(generation),
            "copy_attempt": str(generation),
        }
        for target in SNAPSHOT_TARGETS:
            run_copy(client, f"repair_{target}", params)
        manifests.append(
            {
                "OrgId": org_id,
                "SnapshotGeneration": generation,
                "SnapshotDays": days,
                "PublishedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            }
        )

    payload = "\n".join(json.dumps(row, separators=(",", ":")) for row in manifests)
    receipt = client._req(
        "/v0/events?name=agent_snapshot_manifest&wait=true",
        method="POST",
        data=payload.encode(),
        headers={"Content-Type": "application/json"},
    )
    if receipt.get("successful_rows") != len(manifests) or receipt.get("quarantined_rows") != 0:
        raise RuntimeError("Snapshot manifest fixture insert was not fully acknowledged")


def main() -> None:
    config = {"path": str(ROOT), "name": "trace_flow_prod"}
    project = Project(folder=str(ROOT), workspace_name="trace_flow_prod", max_depth=3)
    client, _ = get_tinybird_local_client(config, test=True, silent=True)

    def build_with_published_snapshots(*args, **kwargs):
        error = build_project(*args, **kwargs)
        if not error:
            # The official fixture runner has no setup hook between its isolated build and
            # assertions, so seed through the production Copy contracts at this exact boundary.
            seed_versioned_facts(client)
            seed_published_snapshots(client)
            verify_baseline_versions(client, BASELINE_SOURCES, query_rows, run_copy)
        return error

    request_ms: dict[str, float] = {}
    get_pipe_data = test_common.get_pipe_data

    def timed_pipe_data(client, pipe_name: str, test_params: str):
        started_at = time.monotonic()
        try:
            return get_pipe_data(client, pipe_name, test_params)
        finally:
            request_ms[pipe_name] = request_ms.get(pipe_name, 0) + (
                time.monotonic() - started_at
            ) * 1000

    test_common.build_project = build_with_published_snapshots
    test_common.get_pipe_data = timed_pipe_data
    test_common.run_tests(tuple(sys.argv[1:]), project, client, config)
    for pipe_name, family in PERFORMANCE_FAMILIES.items():
        if pipe_name in request_ms:
            print(
                f'agent-signal-perf family="{family}" pipe={pipe_name} '
                f"test={pipe_name} elapsed_ms={round(request_ms[pipe_name])} status=passed"
            )


if __name__ == "__main__":
    main()
