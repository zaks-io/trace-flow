#!/usr/bin/env python3
"""Synthetic, isolated Tinybird Local comparison. Never connects to cloud."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
import signal
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--messages", type=int, default=2_000_000)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--setup-only", action="store_true")
    parser.add_argument("--write-queries", action="store_true")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.write_queries:
        from agent_benchmark_queries import endpoint_inventory, write_variants

        write_variants(ROOT, ROOT / "scripts/bench", endpoint_inventory(ROOT))
        return
    if args.messages < 1 or args.runs < 10:
        parser.error("Positive fixture size and at least ten runs are required")

    def terminate(*_):
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, terminate)
    agent = os.environ.get("SBX_AGENT_ID")
    if not agent:
        raise RuntimeError("SBX_AGENT_ID is required for ownership")
    subprocess.run(["free", "-h"], check=True)
    subprocess.run(["uptime"], check=True)
    available = next(
        int(line.split()[1])
        for line in Path("/proc/meminfo").read_text().splitlines()
        if line.startswith("MemAvailable:")
    )
    if available < 8 * 1024 * 1024:
        raise RuntimeError("At least 8 GiB available memory is required")
    subprocess.run(["sbx-ps"], check=True)
    container = f"tra-409-{agent}-{uuid.uuid4().hex[:8]}"
    env = dict(os.environ)
    tokens = json.loads(
        subprocess.check_output(
            ["tb", "--output=json", "local", "generate-tokens"], text=True
        )
    )
    env.update(
        TB_LOCAL_HOST="127.0.0.1",
        TB_LOCAL_PORT="17181",
        TB_LOCAL_CLICKHOUSE_INTERFACE_PORT="17182",
        TB_LOCAL_USER_TOKEN=tokens["user_token"],
        TB_LOCAL_WORKSPACE_TOKEN=tokens["workspace_token"],
        TRACE_FLOW_TINYBIRD_CONTAINER=container,
        TRACE_FLOW_TINYBIRD_PROJECT=container,
        TRACE_FLOW_TINYBIRD_MEMORY="6g",
    )
    with tempfile.TemporaryDirectory(prefix="tra-409-") as private:
        env["TRACE_FLOW_TINYBIRD_VOLUMES"] = str(Path(private) / "volumes")
        override = Path(private) / "ownership.yml"
        override.write_text(
            f"services:\n  tinybird-local:\n    labels:\n      sbx.agent: {agent}\n"
        )
        compose = [
            "docker",
            "compose",
            "-f",
            str(ROOT / "scripts/dev/tinybird-local.compose.yml"),
            "-f",
            str(override),
        ]
        try:
            subprocess.run(compose + ["up", "-d"], env=env, check=True)
            for _ in range(120):
                import urllib.request

                try:
                    request = urllib.request.Request(
                        "http://127.0.0.1:17181/v1/user/workspaces",
                        headers={
                            "Authorization": "Bearer " + env["TB_LOCAL_USER_TOKEN"]
                        },
                    )
                    result = json.load(urllib.request.urlopen(request, timeout=2))
                    if "workspaces" not in result:
                        raise OSError("Local authentication is not ready")
                    break
                except OSError:
                    time.sleep(1)
            else:
                raise RuntimeError("Tinybird Local did not become healthy")
            project = Path(private) / "project"
            project.mkdir()
            for folder in ("datasources", "materializations", "pipes", "copies"):
                shutil.copytree(ROOT / folder, project / folder)
            (project / "tinybird.config.json").write_text(
                json.dumps(
                    {
                        "dev_mode": "local",
                        "include": [
                            "datasources",
                            "materializations",
                            "pipes",
                            "copies",
                        ],
                    }
                )
            )
            os.environ.update(
                TB_LOCAL_HOST="127.0.0.1",
                TB_LOCAL_PORT=env["TB_LOCAL_PORT"],
                TB_LOCAL_CLICKHOUSE_INTERFACE_PORT=env[
                    "TB_LOCAL_CLICKHOUSE_INTERFACE_PORT"
                ],
            )
            from tinybird.tb.modules.local_common import get_tinybird_local_client
            from tinybird.tb.modules.build_common import build_project
            from tinybird.tb.modules.project import Project

            os.chdir(project)
            client, _ = get_tinybird_local_client({"path": str(project)}, silent=True)
            if client.host != "http://127.0.0.1:17181":
                raise RuntimeError(
                    "Tinybird client escaped the owned loopback endpoint"
                )
            from agent_benchmark_queries import endpoint_inventory, write_variants

            endpoints = endpoint_inventory(ROOT)
            write_variants(ROOT, project, endpoints)
            build_project(
                Project(folder=str(project), workspace_name="tra409", max_depth=3),
                client,
                load_fixtures=False,
            )
            print("Local build complete", flush=True)
            if not args.setup_only:
                from agent_benchmark_fixture import fixture_sql, fixture_counts
                from agent_benchmark_local import LocalClickHouse, publish_snapshots
                from agent_benchmark_measure import measure

                ch = LocalClickHouse(container)
                table_map = ch.tables(client)
                end_ms = int(
                    datetime.now(timezone.utc)
                    .replace(hour=0, minute=0, second=0, microsecond=0)
                    .timestamp()
                    * 1000
                )
                for label, sql in fixture_sql(ROOT, table_map, args.messages, end_ms):
                    ch.query(sql)
                    print("Seeded " + label, flush=True)
                fixture = {}
                for table, physical in table_map.items():
                    timestamp = (
                        "DecidedAt"
                        if table.endswith("attribution_versions")
                        else "EventAt"
                    )
                    fixture[table] = ch.rows(
                        f"SELECT OrgId, count() AS live_rows, min({timestamp}) AS first_event, max({timestamp}) AS last_event FROM {physical} FINAL WHERE IsDeleted = 0 GROUP BY OrgId ORDER BY OrgId"
                    )
                jobs = publish_snapshots(client, ROOT)
                records = measure(client, endpoints, end_ms, args.runs, args.output)
                args.output.write_text(
                    json.dumps(
                        {
                            "messages": args.messages,
                            "runs": args.runs,
                            "end_ms": end_ms,
                            "copy_jobs": jobs,
                            "fixture": fixture,
                            "expected_fixture": fixture_counts(args.messages),
                            "image": subprocess.check_output(
                                [
                                    "docker",
                                    "inspect",
                                    "--format",
                                    "{{.Image}}",
                                    container,
                                ],
                                text=True,
                            ).strip(),
                            "records": records,
                        },
                        indent=2,
                    )
                    + "\n"
                )
                if any(row["error"] for row in records):
                    raise RuntimeError(
                        "Incomplete benchmark; endpoint errors recorded in output"
                    )

        finally:
            subprocess.run(compose + ["down"], env=env, check=True)


if __name__ == "__main__":
    main()
