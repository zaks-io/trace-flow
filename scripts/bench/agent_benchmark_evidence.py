"""Capture reproducibility metadata and synthetic boundary evidence without credentials."""

import hashlib
from datetime import datetime, timezone
import platform
import subprocess


def provenance(root, project, ch, container):
    def command(*args):
        return subprocess.check_output(args, cwd=root, text=True).strip()

    files = sorted(
        list((root / "scripts/bench").glob("*.py"))
        + list((root / "pipes").glob("agent_*.pipe"))
        + list((root / "copies").glob("repair_agent_*_snapshots.pipe"))
        + list((root / "datasources").glob("agent_*.datasource"))
    )
    return {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": command("git", "rev-parse", "HEAD"),
        "source_dirty": bool(command("git", "status", "--porcelain")),
        "source_sha256": {
            str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files
        },
        "generated_query_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((project / "pipes").glob("bench_*.pipe"))
        },
        "tinybird_cli": command("tb", "--version"),
        "python": platform.python_version(),
        "clickhouse": ch.rows("SELECT version() AS version")[0]["version"],
        "image": command("docker", "inspect", "--format", "{{.Image}}", container),
        "container_memory_bytes": int(
            command(
                "docker", "inspect", "--format", "{{.HostConfig.Memory}}", container
            )
        ),
        "cpu_count": int(command("nproc")),
        "method": "one warmup per path; ten warm alternating requests; strict hashes; max scan stats",
    }


def parts_at_start(ch):
    return ch.rows(
        "SELECT database, table, countIf(active) AS active_parts, countIf(NOT active) AS inactive_parts, "
        "sumIf(rows, active) AS active_rows, sumIf(bytes_on_disk, active) AS active_bytes "
        "FROM system.parts WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') "
        "GROUP BY database, table ORDER BY database, table"
    )


def boundary_evidence(ch, tables, end_ms):
    result = {}
    for table, physical in tables.items():
        timestamp = "DecidedAt" if table.endswith("attribution_versions") else "EventAt"
        result[table] = ch.rows(
            f"SELECT countIf(toDate({timestamp}) = toDate(fromUnixTimestamp64Milli({end_ms}, 'UTC'))) AS end_day_rows, "
            f"countIf({timestamp} >= fromUnixTimestamp64Milli({end_ms}, 'UTC')) AS after_end_rows, max({timestamp}) AS last_event, countIf({timestamp} > now()) AS future_rows "
            f"FROM {physical} FINAL WHERE OrgId = 'benchmark-org' AND IsDeleted = 0"
        )[0]
    if any(row["end_day_rows"] == 0 for row in result.values()):
        raise RuntimeError("Fixture is missing end-day facts")
    if any(row["future_rows"] for row in result.values()):
        raise RuntimeError("Fixture has future events at measurement start")
    physical = tables["agent_message_fact_versions"]
    result["crossing_sessions"] = ch.rows(
        "SELECT session_pk, count() AS messages, min(EventAt) AS first_event, max(EventAt) AS last_event "
        f"FROM {physical} FINAL WHERE OrgId = 'benchmark-org' AND IsDeleted = 0 AND "
        "session_pk IN (concat('benchmark-session-0-', lower(hex(SHA256('0')))), "
        "concat('benchmark-session-1920-', lower(hex(SHA256('1920')))), "
        "concat('benchmark-session-1280-', lower(hex(SHA256('1280')))), concat('benchmark-session-128-', lower(hex(SHA256('128')))), concat('benchmark-session-256-', lower(hex(SHA256('256')))), concat('benchmark-session-2560-', lower(hex(SHA256('2560')))), concat('benchmark-session-3200-', lower(hex(SHA256('3200'))))) "
        "GROUP BY session_pk ORDER BY session_pk"
    )
    physical = tables["agent_file_event_fact_versions"]
    result["crossing_file_paths"] = ch.rows(
        "SELECT session_pk, repo_fingerprint, normalized_repo_path, count() AS touches, "
        "groupArray(EventAt) AS touch_times, min(EventAt) AS first_touch, max(EventAt) AS last_touch "
        f"FROM {physical} FINAL WHERE OrgId = 'benchmark-org' AND IsDeleted = 0 "
        "AND normalized_repo_path = 'src/benchmark-retention-crossing.ts' "
        "GROUP BY session_pk, repo_fingerprint, normalized_repo_path ORDER BY session_pk"
    )
    return result
