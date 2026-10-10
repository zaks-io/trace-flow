"""Owned local ClickHouse helpers and real snapshot Copy publication."""

import json
import re
import subprocess
import time
from datetime import datetime, timezone


class LocalClickHouse:
    def __init__(self, container):
        self.container = container

    def query(self, sql):
        return subprocess.check_output(
            [
                "docker",
                "exec",
                "-i",
                self.container,
                "clickhouse-client",
                "--multiquery",
            ],
            input=sql,
            text=True,
        )

    def rows(self, sql):
        return json.loads(self.query(sql + " FORMAT JSON"))["data"]

    def tables(self, client):
        from agent_benchmark_fixture import TABLES

        result = {}
        for datasource, _, primary_key, _ in TABLES:
            matches = self.rows(
                "SELECT database, table AS table_name FROM system.columns "
                f"WHERE name = '{primary_key}' "
                "AND (database, table) IN (SELECT database, name FROM system.tables WHERE engine LIKE '%ReplacingMergeTree%')"
            )
            if len(matches) != 1:
                raise RuntimeError(
                    f"Ambiguous local fact table for {datasource}: {matches}"
                )
            row = matches[0]
            if not all(
                re.fullmatch(r"[a-zA-Z0-9_]+", row[k])
                for k in ("database", "table_name")
            ):
                raise RuntimeError("Invalid local physical identifier")
            result[datasource] = f"`{row['database']}`.`{row['table_name']}`"
        return result


def publish_snapshots(client, root):
    copies = sorted((root / "copies").glob("repair_agent_*_snapshots.pipe"))
    rows = client.query(
        "SELECT OrgId, arraySort(groupUniqArray(toString(toDate(EventAt)))) AS days FROM agent_message_fact_versions FINAL WHERE IsDeleted = 0 GROUP BY OrgId FORMAT JSON"
    )["data"]
    jobs = []
    for generation, row in enumerate(rows, 1):
        params = {
            "org_id": row["OrgId"],
            "snapshot_days": ",".join(row["days"]),
            "snapshot_generation": str(generation),
            "copy_attempt": str(generation),
        }
        for copy in copies:
            started = time.perf_counter()
            receipt = client.pipe_run(copy.stem, "copy", params, "append")
            job_id = receipt.get("job", {}).get("job_id")
            if not job_id:
                raise RuntimeError(f"{copy.stem} returned no Copy receipt")
            client.wait_for_job(
                job_id, backoff_seconds=0.1, maximum_backoff_seconds=0.5
            )
            jobs.append(
                {
                    "org_id": row["OrgId"],
                    "pipe": copy.stem,
                    "wall_ms": (time.perf_counter() - started) * 1000,
                }
            )
            print(json.dumps(jobs[-1]), flush=True)
        manifest = {
            "OrgId": row["OrgId"],
            "SnapshotGeneration": generation,
            "SnapshotDays": row["days"],
            "PublishedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[
                :-3
            ],
        }
        receipt = client._req(
            "/v0/events?name=agent_snapshot_manifest&wait=true",
            method="POST",
            data=json.dumps(manifest).encode(),
            headers={"Content-Type": "application/json"},
        )
        if receipt.get("successful_rows") != 1 or receipt.get("quarantined_rows", 0):
            raise RuntimeError("Manifest was not durably acknowledged")
    return jobs
