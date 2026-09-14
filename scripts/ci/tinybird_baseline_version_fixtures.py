"""Exercise the deployed baseline Copy SQL inside Tinybird Local's fixture workspace."""

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


BASELINE_KEYS = {
    "capability_snapshots": ("capability_snapshot_pk", "agent_capability_snapshot_fact_versions"),
    "file_events": ("file_event_pk", "agent_file_event_fact_versions"),
    "messages": ("message_pk", "agent_message_fact_versions"),
    "pull_request_links": ("pull_request_link_pk", "agent_pull_request_fact_versions"),
    "review_unit_attributions": (
        "review_unit_attribution_pk",
        "agent_review_unit_attribution_versions",
    ),
    "tool_events": ("tool_use_pk", "agent_tool_event_fact_versions"),
}


def verify_baseline_versions(client, sources, query_rows, run_copy) -> None:
    org = "org_baseline_version_regression"
    today = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    previous = today - timedelta(days=32)
    old_time = previous.strftime("%Y-%m-%d %H:%M:%S.000")
    new_time = today.strftime("%Y-%m-%d %H:%M:%S.000")
    for category, table, timestamp in sources:
        key, target = BASELINE_KEYS[category]
        fixture = Path("fixtures") / f"{table}.ndjson"
        if fixture.exists():
            sample = json.loads(fixture.read_text().splitlines()[0])
        elif category == "capability_snapshots":
            sample = {
                "CollectorId": "baseline-collector",
                "CollectorCredentialId": "baseline-credential",
                "repo_fingerprint": "baseline-repo",
                "repo_source": "remote",
                "source": "codex",
                "parser_version": "baseline-test",
                "vendor_session_id": "baseline-session",
                "source_snapshot_id": "baseline-snapshot",
                "stable_turn_index": 0,
                "capability_kind": "tool",
                "item_count": 1,
                "total_size_bytes": 8,
                "total_tokens_estimate": 2,
                "content_hash": "baseline-hash",
                "redacted_label": "baseline-test",
                "dropped_sensitive": 0,
            }
        else:
            raise RuntimeError(f"Missing baseline fixture for {category}")
        old = {
            **sample,
            "OrgId": org,
            "UserId": "older",
            "session_pk": "baseline-session",
            key: "baseline-fact",
            timestamp: old_time,
            "IngestedAt": old_time,
        }
        new = {**old, "UserId": "newer", timestamp: new_time, "IngestedAt": new_time}
        if category == "messages":
            new["cost_usd"] = None
        payload = "\n".join(json.dumps(row) for row in [old, new, new])
        receipt = client._req(
            f"/v0/events?name={table}&wait=true",
            method="POST",
            data=payload.encode(),
            headers={"Content-Type": "application/json"},
        )
        if receipt.get("successful_rows") != 3 or receipt.get("quarantined_rows") != 0:
            raise RuntimeError(f"Baseline version fixture insert failed for {category}")
        run_copy(
            client,
            f"repair_agent_{category}_versions_baseline",
            {
                "org_id": org,
                "start_day": previous.strftime("%Y-%m-%d"),
                "end_day": today.strftime("%Y-%m-%d"),
                "copy_attempt": str(int(today.timestamp() * 1000)),
            },
        )
        columns = re.findall(r"^\s+`([^`]+)`\s", Path(f"datasources/{table}.datasource").read_text(), re.M)
        projection = ",".join(f"`{column}`" for column in columns)
        rows = query_rows(
            client,
            f"""SELECT UserId,toString(toDate({timestamp})) AS EventDay,
                DeliverySequence, IsDeleted,
                ContentHash=lower(hex(SHA256(toJSONString(tuple({projection}))))) AS hash_matches
                {',isNull(cost_usd) AS null_preserved' if category == 'messages' else ''}
                FROM {target} FINAL WHERE OrgId='{org}'""",
        )
        if len(rows) == 1:
            rows[0]["DeliverySequence"] = int(rows[0]["DeliverySequence"])
        if len(rows) != 1 or rows[0] != {
            "UserId": "newer",
            "EventDay": today.strftime("%Y-%m-%d"),
            "DeliverySequence": 1,
            "IsDeleted": 0,
            "hash_matches": 1,
            **({"null_preserved": 1} if category == "messages" else {}),
        }:
            raise RuntimeError(f"Baseline Copy did not preserve the exact latest version in {category}")
        count = query_rows(client, f"SELECT count() AS n FROM {table} WHERE OrgId='{org}'")
        if int(count[0]["n"]) != 3:
            raise RuntimeError(f"Baseline Copy changed preserved source rows in {category}")
    print("Baseline Copy version regressions passed for all six categories")
