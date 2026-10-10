"""Benchmark-only direct variants preserve serving SQL and Copy aggregation states."""

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
EXTRAS = {"agent_priced_usage", "agent_priced_coverage"} | SIGNALS


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


def bounded_raw_reads(text: str) -> str:
    # Date predicates use replacement-key columns; mutable role/status filters stay after FINAL.
    pattern = r"(FROM (agent_\w+(?:fact_versions|attribution_versions))(?: AS (\w+))? FINAL\s+WHERE)"

    def replace(match):
        alias = match[3] or match[2]
        timestamp = (
            "DecidedAt" if match[2].endswith("attribution_versions") else "EventAt"
        )
        return (
            match[1]
            + "\n        "
            + alias
            + ".OrgId = {{ String(org_id) }}"
            + "\n        AND "
            + alias
            + "."
            + timestamp
            + " >= fromUnixTimestamp64Milli({{ Int64(start_time_ms) }})"
            + "\n        AND "
            + alias
            + "."
            + timestamp
            + " < fromUnixTimestamp64Milli({{ Int64(end_time_ms) }}) AND"
        )

    return re.sub(pattern, replace, text)


def write_variants(root: Path, project: Path, endpoints: list[str]) -> None:
    replacements = {}
    for copy in sorted((root / "copies").glob("repair_agent_*_snapshots.pipe")):
        target = re.search(r"^TARGET_DATASOURCE (\w+)$", copy.read_text(), re.M)[1]
        published = target.removesuffix("_snapshots") + "_published"
        name = "bench_direct_" + published
        replacements[published] = name
        sql = copy.read_text().split("SQL >", 1)[1].split("\nTYPE COPY", 1)[0]
        sql = re.sub(r"\s+SETTINGS max_threads = 1\s*$", "", sql)
        sql = sql.replace(
            "IN {{ Array(snapshot_days, 'Date') }}",
            ">= toDate(fromUnixTimestamp64Milli({{ Int64(start_time_ms) }}))\n"
            "      AND toDate(EventAt) < toDate(fromUnixTimestamp64Milli({{ Int64(end_time_ms) }}))",
        )
        sql = sql.replace("{{ UInt64(snapshot_generation) }}", "toUInt64(1)")
        sql = sql.replace("{{ UInt64(copy_attempt) }}", "toUInt64(1)")
        (project / f"pipes/{name}.pipe").write_text("NODE direct\nSQL >" + sql + "\n")
    for endpoint in endpoints:
        text = (root / f"pipes/{endpoint}.pipe").read_text()
        for published, direct in replacements.items():
            text = re.sub(rf"\b{published}\b", direct, text)
        text = bounded_raw_reads(text)
        if endpoint == "agent_priced_usage":
            text += "\nTYPE ENDPOINT\n"
        (project / f"pipes/bench_direct_{endpoint}.pipe").write_text(text)
        if endpoint == "agent_priced_usage":
            # This diagnostic generic pipe already reads FINAL. Expose it locally for identical stats.
            (project / f"pipes/bench_current_{endpoint}.pipe").write_text(
                (root / f"pipes/{endpoint}.pipe").read_text() + "\nTYPE ENDPOINT\n"
            )
