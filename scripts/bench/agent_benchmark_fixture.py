"""Deterministic synthetic INSERT SELECT fixtures, executed by clickhouse-client.

Base ratios to messages: tools 1:1, files 1:2, PRs/capabilities/attributions
1:100 each (rounded down). Every 20 messages share a session. Each 1,000-message
block has 70% benchmark-org and 10% each benchmark-org-2/3/4. Smaller populations
have deterministic rounding. Dates cover the 366 complete UTC days preceding
end_ms's UTC midnight. With >=11 messages, session zero has facts 45 days older.

Per table, mutation buckets rotate every 100 ordinals to spread versions across
orgs. Bucket modulo 20 == 19 gets corrections (5%); bucket == 99 moves date
(1%, included in corrections); bucket == 98 gets deleted (1%).
Movement writes an old-key tombstone before the new-key live correction. Separate
INSERTs leave replacement work to FINAL; this module never runs SQL or merges.
Costs are integer multiples of 1/1024 USD, so their sums are exact at this scale.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
import re

DAY_MS = 86_400_000
TABLES = (
    ("agent_message_fact_versions", 1, "message_pk", "EventAt"),
    ("agent_tool_event_fact_versions", 1, "tool_use_pk", "EventAt"),
    ("agent_file_event_fact_versions", 2, "file_event_pk", "EventAt"),
    ("agent_pull_request_fact_versions", 100, "pull_request_link_pk", "EventAt"),
    (
        "agent_capability_snapshot_fact_versions",
        100,
        "capability_snapshot_pk",
        "EventAt",
    ),
    (
        "agent_review_unit_attribution_versions",
        100,
        "review_unit_attribution_pk",
        "DecidedAt",
    ),
)
QUOTED_IDENTIFIER = r'(?:`(?:[^`\\]|``)+`|"(?:[^"\\]|"")+")'


def _validate_messages(messages: int) -> None:
    if type(messages) is not int or not 1 <= messages <= 100 * (2**32 - 1):
        raise ValueError("messages must be positive with PR numbers fitting UInt32")


def fixture_counts(messages: int) -> dict[str, dict[str, int]]:
    """Counts before TTL; live means FINAL WHERE IsDeleted = 0, across all orgs."""
    _validate_messages(messages)
    result = {}
    for table, stride, _, _ in TABLES:
        count = messages // stride
        blocks, tail = divmod(count, 100)
        deleted = blocks + sum((i + blocks) % 100 == 98 for i in range(tail))
        moved = blocks + sum((i + blocks) % 100 == 99 for i in range(tail))
        corrected = blocks * 5 + sum((i + blocks) % 20 == 19 for i in range(tail))
        result[table] = dict(
            base=count,
            corrections=corrected,
            date_moves=moved,
            deletions=deleted,
            inserted=count + corrected + moved + deleted,
            live=count - deleted,
        )
    return result


def _schema(root: Path, table: str) -> list[tuple[str, str]]:
    text = (root / "datasources" / f"{table}.datasource").read_text()
    schema = text.split("SCHEMA >", 1)[1].split("\nENGINE", 1)[0]
    columns = re.findall(r"^\s*`([^`]+)`\s+([A-Za-z0-9]+(?:\([^)]*\))?)", schema, re.M)
    if not columns or len({name for name, _ in columns}) != len(columns):
        raise ValueError(f"Invalid or duplicate schema columns: {table}")
    return columns


def _id(prefix: str, value: str) -> str:
    return (
        f"concat('benchmark-{prefix}-', toString({value}), '-', "
        f"lower(hex(SHA256(toString({value})))))"
    )


def _expressions(table: str, pk: str, timestamp: str) -> dict[str, str]:
    fields = dict(
        DeliverySequence="version",
        ContentHash="content_hash_value",
        IsDeleted="deleted",
        OrgId="if(intDiv(s, 5) % 10 < 7, 'benchmark-org', "
        "concat('benchmark-org-', toString(intDiv(s, 5) % 10 - 5)))",
        UserId=_id("user", "s % 256"),
        CollectorId=_id("collector", "s % 64"),
        CollectorCredentialId=_id("credential", "s % 64"),
        session_pk="session_id",
        repo_fingerprint=_id("repo", "s % 128"),
        repo_source="if(s % 11 = 0, 'path', 'remote')",
        source="['claude', 'codex', 'cursor'][1 + s % 3]",
        parser_version="'benchmark-v1'",
        IngestedAt="fromUnixTimestamp64Milli(ingested_ms, 'UTC')",
        vendor_session_id="vendor_session",
        dropped_sensitive="0",
    )
    fields[pk] = _id(pk, "n")
    fields[timestamp] = "fromUnixTimestamp64Milli(event_ms, 'UTC')"
    if table in (TABLES[0][0], TABLES[1][0], TABLES[2][0]):
        fields.update(
            vendor_message_id=_id("vendor-message", "m"), source_block_index="m % 20"
        )
    if table == TABLES[0][0]:
        del fields["source_block_index"]
        fields.update(
            VendorStartedAt="fromUnixTimestamp64Milli(started_ms, 'UTC')",
            turn_index="m % 20",
            role="'assistant'",
            model="['claude-sonnet-4-5', 'gpt-5', 'claude-opus-4-1', 'gpt-5-mini'][1 + m % 4]",
            input_tokens="if(m % 41 = 0, 0, 1024 + m % 65536 + changed * 256)",
            output_tokens="if(m % 41 = 0, 0, 64 + (m * 17) % 2048 + changed * 32)",
            cache_read_tokens="if(m % 41 = 0 OR m % 7 = 0, 0, (m % 128) * 64)",
            cache_creation_tokens="if(m % 41 = 0, 0, (m % 8) * 128)",
            cache_creation_5m_tokens="if(m % 41 = 0, 0, (m % 8) * 64)",
            cache_creation_1h_tokens="if(m % 41 = 0, 0, (m % 8) * 64)",
            reasoning_tokens="if(m % 41 = 0, 0, (m % 16) * 32)",
            token_coverage="multiIf(m % 41 = 0, 'missing', m % 17 = 0, 'partial', 'full')",
            cache_coverage="if(m % 41 = 0 OR m % 7 = 0, 'missing', 'full')",
            agent_depth="if(m % 20 BETWEEN 5 AND 8, 1 + m % 2, 0)",
            is_subagent_spawn="m % 20 IN (3, 4)",
            is_sidechain="m % 20 = 8",
            agent_id="if(m % 20 BETWEEN 5 AND 8, direct_agent, '')",
            normalized_git_remote="concat('https://code.benchmark.invalid/synthetic/', repo_name, '.git')",
            repo_path_fallback="concat('synthetic-workspace/', repo_name, '/', repeat('component-', 12))",
            git_branch="branch_name",
            git_head_sha="lower(hex(SHA1(toString(s))))",
            cost_usd="if(m % 41 = 0, NULL, toFloat64(1 + m % 64 + changed * 4) / 1024)",
            parent_vendor_session_id="''",
            parent_session_pk="''",
        )
    elif table == TABLES[1][0]:
        fields.update(
            tool_use_id=_id("tool-use", "n"),
            tool_name="multiIf(m % 20 IN (3, 4), 'Task', m % 5 = 0, 'Read', 'Bash')",
            command_family="['rg', 'read', 'ls', 'cd', 'git', 'test'][1 + m % 6]",
            command_program="['rg', 'cat', 'ls', 'cd', 'git', 'bun'][1 + m % 6]",
            command_subcommand="if(m % 6 = 4, 'diff', '')",
            status="multiIf(m % 11 = 0, 'failure', m % 29 = 0, 'unknown', 'success')",
            error_category="if(m % 11 != 0 OR m % 7 = 0, 'unknown', "
            "['missing_file', 'stale_file_before_edit', 'runtime_env_mismatch', "
            "'human_or_policy_rejection'][1 + intDiv(m, 11) % 4])",
            error_category_coverage="multiIf(m % 11 != 0, 'not_applicable', "
            "m % 7 = 0, 'unknown', 'classified')",
            exit_code="if(m % 11 = 0, 1 + m % 3, 0)",
            duration_ms="25 + m % 30000 + changed * 100",
            is_navigation="m % 6 < 4",
            navigation_kind="['search', 'file_read', 'directory_list', 'directory_change', 'none', 'none'][1 + m % 6]",
            navigation_hint_coverage="multiIf(m % 6 >= 4, 'not_applicable', m % 13 = 0, 'unknown', 'structured')",
            navigation_path_hint="if(m % 6 < 4 AND m % 13 != 0, file_path, '')",
            navigation_pattern_hint="if(m % 6 = 0, concat('synthetic_symbol_', toString(m % 512)), '')",
            repo_relative_paths="[file_path, concat('tests/', toString(s % 128), '/synthetic.test.ts')]",
            extracted_provider="'github'",
            extracted_repo="concat('benchmark-synthetic/', repo_name)",
            extracted_pr_number="1 + intDiv(m, 100)",
            command_excerpt="concat('synthetic benchmark command ', toString(m), ' ', repeat('argument ', 64))",
            error_excerpt="if(m % 11 = 0, concat('synthetic failure ', toString(m), ' ', repeat('diagnostic ', 32)), '')",
            extracted_subagent_agent_id="multiIf(m % 20 = 3, direct_agent, m % 20 = 4, fallback_agent, '')",
            extracted_subagent_model="if(m % 20 IN (3, 4), 'gpt-5-mini', '')",
            extracted_subagent_input_tokens="if(m % 20 IN (3, 4), 512 + m % 8192, 0)",
            extracted_subagent_output_tokens="if(m % 20 IN (3, 4), 128 + m % 1024, 0)",
            extracted_subagent_cache_read_tokens="if(m % 20 IN (3, 4), 256, 0)",
            extracted_subagent_cache_creation_tokens="if(m % 20 IN (3, 4), 64, 0)",
        )
    elif table == TABLES[2][0]:
        fields.update(
            normalized_repo_path="concat(file_path, if(changed = 1, '.corrected', ''))",
            operation="['read', 'edit', 'write', 'create'][1 + n % 4]",
        )
    elif table == TABLES[3][0]:
        fields.update(
            source_event_id=_id("review-event", "n"),
            stable_turn_index="m % 20",
            host="'github.com'",
            owner="'benchmark-synthetic'",
            repo="repo_name",
            number="n + 1",
            url="review_url_value",
            confidence="if(changed = 1, 'medium', 'high')",
            evidence="['assistant_text', 'tool_output', 'transcript_record'][1 + n % 3]",
        )
    elif table == TABLES[4][0]:
        fields.update(
            source_snapshot_id=_id("snapshot", "n"),
            stable_turn_index="m % 20",
            capability_kind="['base_instructions', 'dynamic_tools', 'mcp_servers', 'other'][1 + n % 4]",
            item_count="8 + n % 64 + changed",
            total_size_bytes="4096 + n % 65536 + changed * 128",
            total_tokens_estimate="1024 + n % 16384 + changed * 32",
            content_hash="content_hash_value",
            redacted_label="concat('synthetic capability ', toString(n), ' ', repeat('redacted ', 16))",
        )
    else:
        del fields["dropped_sensitive"]
        fields.update(
            review_unit_key="concat('hosted:github.com/benchmark-synthetic/', repo_name, ':pull_request:', toString(n + 1))",
            review_url="review_url_value",
            review_host="'github.com'",
            review_owner="'benchmark-synthetic'",
            review_repo="repo_name",
            review_number="n + 1",
            git_branch="branch_name",
            attribution_method="'direct_link'",
            confidence="if(changed = 1, 'medium', 'high')",
            status="'attributed'",
            ambiguity_reason="''",
            evidence_pull_request_link_pk=_id("pull_request_link_pk", "n"),
            rule_version="'direct_link_v1'",
        )
    return fields


def fixture_sql(
    root: Path, table_map: dict[str, str], messages: int, end_ms: int
) -> Iterator[tuple[str, str]]:
    """Yield (label, SQL) in insertion order; table_map supplies quoted db.table names.

    Reuse the same end_ms for reproducible runs. All schema columns, including
    defaults, are emitted and cast to their versioned types. Schema drift fails
    before yielding SQL. Execute each statement separately, without force merges.
    """
    counts = fixture_counts(messages)
    if type(end_ms) is not int or end_ms < 366 * DAY_MS:
        raise ValueError(
            "end_ms must be integer epoch milliseconds after the first 366 days"
        )
    anchor = end_ms // DAY_MS * DAY_MS
    schemas = {}
    expressions = {}
    for table, _, pk, timestamp in TABLES:
        physical = table_map[table]
        if not re.fullmatch(
            rf"{QUOTED_IDENTIFIER}\s*\.\s*{QUOTED_IDENTIFIER}", physical
        ):
            raise ValueError(
                f"Expected fully quoted qualified table identifier: {table}"
            )
        schemas[table] = _schema(root, table)
        expressions[table] = _expressions(table, pk, timestamp)
        missing = {name for name, _ in schemas[table]} - expressions[table].keys()
        unknown = expressions[table].keys() - {name for name, _ in schemas[table]}
        if missing or unknown:
            raise ValueError(
                f"Schema drift for {table}: missing={sorted(missing)}, unknown={sorted(unknown)}"
            )
    stages = (
        ("base", 1, 0, 0, False, "1"),
        (
            "corrections",
            2,
            0,
            1,
            False,
            "mutation_bucket % 20 = 19 AND mutation_bucket != 99",
        ),
        ("date_move_tombstones", 2, 1, 0, False, "mutation_bucket = 99"),
        ("date_move_corrections", 3, 0, 1, True, "mutation_bucket = 99"),
        ("deletions", 4, 1, 0, False, "mutation_bucket = 98"),
    )
    for table, stride, _, _ in TABLES:
        names = ", ".join(f"`{name}`" for name, _ in schemas[table])
        select = ",\n    ".join(
            f"CAST({expressions[table][name]}, '{kind}')"
            for name, kind in schemas[table]
        )
        for label, version, deleted, changed, moved, predicate in stages:
            movement = f"if(day_offset = 1, -{DAY_MS}, {DAY_MS})" if moved else "0"
            aliases = [
                "toInt64(number) AS n",
                f"n * {stride} AS m",
                "intDiv(m, 20) AS s",
                "(n + intDiv(n, 100)) % 100 AS mutation_bucket",
                f"{version} AS version",
                f"{deleted} AS deleted",
                f"{changed} AS changed",
                "if(s = 0 AND m % 20 >= 10, 46, 1 + s % 366) AS day_offset",
                f"{anchor} - day_offset * {DAY_MS} + ((s * 137) % 80000 + m % 20) * 1000 AS base_ms",
                f"base_ms + {movement} + changed * 500 AS event_ms",
                f"{end_ms} + version * 1000 AS ingested_ms",
                f"{anchor} - if(s = 0, 46, 1 + s % 366) * {DAY_MS} + (s * 137) % 80000 * 1000 AS started_ms",
                f"{_id('session', 's')} AS session_id",
                f"{_id('vendor-session', 's')} AS vendor_session",
                f"{_id('direct-agent', 's')} AS direct_agent",
                f"{_id('fallback-agent', 's')} AS fallback_agent",
                "concat('repository-', toString(s % 128)) AS repo_name",
                "concat('benchmark/branch-', toString(s)) AS branch_name",
                "concat('src/', repo_name, '/', repeat('synthetic-component-', 6), toString(m % 512), '.ts') AS file_path",
                "concat('https://github.com/benchmark-synthetic/', repo_name, '/pull/', toString(n + 1)) AS review_url_value",
                f"lower(hex(SHA256(concat('{table}:{label}:', toString(n))))) AS content_hash_value",
            ]
            sql = (
                f"INSERT INTO {table_map[table]} ({names})\nWITH\n    "
                + ",\n    ".join(aliases)
                + f"\nSELECT\n    {select}\n"
                + f"FROM numbers({counts[table]['base']})\nWHERE {predicate};"
            )
            yield f"{table}:{label}", sql
