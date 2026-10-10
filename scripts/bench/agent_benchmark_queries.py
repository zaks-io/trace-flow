"""Generate benchmark SQL only in a caller-owned temporary Tinybird project."""

from pathlib import Path
import re

SIGNALS = {
    "agent_session_signals_top_runaway",
    "agent_file_attention_top_files",
    "agent_file_attention_top_directories",
    "agent_failure_leaderboard",
    "agent_tool_period_delta",
    "agent_notable_changes",
    "agent_context_health",
}
FILE_ATTENTION = {
    "agent_file_attention_top_files",
    "agent_file_attention_top_directories",
}
LIFETIME = FILE_ATTENTION | {
    "agent_sessions_browser",
    "agent_session_cost_distribution",
    "agent_session_signals_top_runaway",
    "agent_review_unit_costs",
}
EXTRAS = {"agent_priced_usage", "agent_priced_coverage"} | SIGNALS
START = "start_dt"
END = "end_dt"
RETENTION = "now() - toIntervalDay({{ Int32(retention_days, 7) }})"


def endpoint_inventory(root: Path) -> list[str]:
    text = (root / "packages/convex/integrations/tinybird.ts").read_text()
    names = set()
    for array in ("WEB_TINYBIRD_PIPES", "MCP_TINYBIRD_PIPES"):
        body = re.search(rf"export const {array} = \[(.*?)\] as const", text, re.S)
        if body is None:
            raise RuntimeError(f"Missing {array}")
        names.update(re.findall(r"'(agent_\w+)'", body[1]))
    contract = (
        root / "packages/mcp-core/src/tools/agentAnalyticsContract.ts"
    ).read_text()
    names.update(re.findall(r"'agent_\w+'", contract))
    names = {name.strip("'") for name in names} | EXTRAS
    for name in names:
        if not (root / f"pipes/{name}.pipe").exists():
            raise RuntimeError(f"Unknown agent endpoint {name}")
    return sorted(names)


def normalized_bounds(text: str) -> str:
    bounds = re.search(r"    WITH\n(.*?)\n    SELECT", text, re.S)
    if (
        bounds is None
        or " AS start_dt" not in bounds[1]
        or " AS end_dt" not in bounds[1]
    ):
        raise ValueError("Endpoint is missing normalized start/end bounds")
    return "    WITH\n" + bounds[1] + "\n"


def retained_start(text: str) -> str:
    lower = "prior_start_dt" if "prior_start_dt" in text else START
    if "baseline_start_dt" in text:
        lower = f"least({lower}, baseline_start_dt)"
    return f"greatest({lower}, {RETENTION})"


def copy_sql(
    copy: Path, lower: str, bounds: str, extra: str = "", end_day: str | None = None
) -> str:
    sql = copy.read_text().split("SQL >", 1)[1].split("\nTYPE COPY", 1)[0]
    sql = re.sub(r"\s+SETTINGS max_threads = 1\s*$", "", sql)
    end_day = end_day or f"toDate({END} - toIntervalMillisecond(1))"
    sql = sql.replace(
        "IN {{ Array(snapshot_days, 'Date') }}",
        f">= toDate({lower})\n      AND toDate(EventAt) <= {end_day}{extra}",
    )
    sql = sql.replace("    SELECT", bounds + "    SELECT", 1)
    return sql.replace("{{ UInt64(snapshot_generation) }}", "toUInt64(1)").replace(
        "{{ UInt64(copy_attempt) }}", "toUInt64(1)"
    )


def file_activity_node(copy: Path, lower: str, bounds: str) -> str:
    # File views select by last touch of each session/path, not by the session's last event.
    sql = copy_sql(copy, lower, bounds, end_day="today()")
    return (
        "NODE retention_file_activity\nSQL >" + sql + "\n\n"
        "NODE retention_candidates\nSQL >\n    %\n"
        + bounds
        + "    SELECT repo_fingerprint, session_pk, normalized_repo_path "
        "FROM retention_file_activity GROUP BY repo_fingerprint, session_pk, normalized_repo_path "
        f"HAVING maxMerge(LastTouchedAt) >= {lower} AND maxMerge(LastTouchedAt) < {END}\n\n"
    )


def activity_node(signal: bool, lower: str, bounds: str) -> str:
    # Match each Copy's live contributors and billable-message predicate before discovering sessions.
    tables = ["message", "tool_event", "file_event", "pull_request"]
    selects = []
    for category in tables:
        predicate = " AND role = 'assistant'" if category == "message" else ""
        if category == "pull_request":
            predicate = " AND url != ''"
        selects.append(
            "SELECT session_pk, repo_fingerprint, EventAt "
            f"FROM agent_{category}_fact_versions FINAL "
            "WHERE OrgId = {{ String(org_id) }} "
            f"AND toDate(EventAt) >= toDate({lower}) "
            "AND toDate(EventAt) <= today() "
            f"AND EventAt >= {lower} AND IsDeleted = 0{predicate}"
        )
    keys = "repo_fingerprint, session_pk" if signal else "session_pk"
    return (
        "NODE retention_candidates\nSQL >\n    %\n"
        + bounds
        + f"    SELECT {keys} FROM ({' UNION ALL '.join(selects)}) "
        f"GROUP BY {keys} HAVING max(EventAt) >= {lower} AND max(EventAt) < {END}\n\n"
    )


def write_variants(root: Path, project: Path, endpoints: list[str]) -> None:
    if project.resolve().is_relative_to((root / "scripts/bench").resolve()):
        raise ValueError("Benchmark resources must be generated outside scripts/bench")
    (project / "pipes").mkdir(parents=True, exist_ok=True)
    copies = {}
    for copy in sorted((root / "copies").glob("repair_agent_*_snapshots.pipe")):
        target = re.search(r"^TARGET_DATASOURCE (\w+)$", copy.read_text(), re.M)[1]
        copies[target.removesuffix("_snapshots") + "_published"] = copy
    for endpoint in endpoints:
        original = (root / f"pipes/{endpoint}.pipe").read_text()
        for kind in ("direct", "two_stage") if endpoint in LIFETIME else ("direct",):
            text = original
            aggregate_nodes = ""
            lower = retained_start(original)
            bounds = normalized_bounds(original) if "_published" in original else ""
            prefix = f"bench_{kind}_{endpoint}"
            for published, copy in copies.items():
                if not re.search(rf"\b{published}\b", original):
                    continue
                name = (
                    prefix
                    + "_"
                    + published.removeprefix("agent_").removesuffix("_published")
                )
                extra = ""
                if kind == "two_stage":
                    keys = (
                        "(repo_fingerprint, session_pk)"
                        if endpoint.endswith("top_runaway")
                        or endpoint in FILE_ATTENTION
                        else "session_pk"
                    )
                    extra = f"\n      AND EventAt >= {RETENTION} AND EventAt < {END}\n      AND {keys} IN (SELECT {keys} FROM retention_candidates)"
                    lower = RETENTION
                if kind == "two_stage":
                    aggregate_nodes += (
                        f"NODE {name}\nSQL >"
                        + copy_sql(copy, lower, bounds, extra)
                        + "\n\n"
                    )
                else:
                    (project / f"pipes/{name}.pipe").write_text(
                        "NODE direct\nSQL >"
                        + copy_sql(copy, lower, bounds, extra)
                        + "\n"
                    )
                text = re.sub(rf"\b{published}\b", name, text)
            if endpoint == "agent_review_unit_costs":
                text = text.replace("    SELECT", bounds + "    SELECT", 1)
                lower = RETENTION if kind == "two_stage" else retained_start(original)
                text = text.replace(
                    "AND rua.IsDeleted = 0",
                    f"AND toDate(rua.DecidedAt) >= toDate({lower})\n"
                    f"      AND toDate(rua.DecidedAt) <= toDate({END} - toIntervalMillisecond(1))\n"
                    f"      AND rua.DecidedAt >= {lower} AND rua.DecidedAt < {END}\n"
                    + (
                        "      AND rua.session_pk IN (SELECT session_pk FROM retention_candidates)\n"
                        if kind == "two_stage"
                        else ""
                    )
                    + "      AND rua.IsDeleted = 0",
                )
            if kind == "two_stage":
                if endpoint in FILE_ATTENTION:
                    discovery = file_activity_node(
                        copies["agent_session_file_signals_published"],
                        retained_start(original),
                        bounds,
                    )
                    text = text.replace(
                        "HAVING last_touched_at >= start_dt",
                        "HAVING (repo_fingerprint, session_pk, normalized_repo_path) IN "
                        "(SELECT repo_fingerprint, session_pk, normalized_repo_path FROM retention_candidates)\n"
                        "                AND last_touched_at >= start_dt",
                    )
                else:
                    discovery = activity_node(
                        endpoint.endswith("top_runaway"),
                        retained_start(original),
                        bounds,
                    )
                text = discovery + aggregate_nodes + text
            if endpoint == "agent_priced_usage":
                # Already FINAL and plan-clamped, with no selected-window contract. Preserve it.
                text += "\nTYPE ENDPOINT\n"
                (project / f"pipes/bench_current_{endpoint}.pipe").write_text(text)
            (project / f"pipes/{prefix}.pipe").write_text(text)
