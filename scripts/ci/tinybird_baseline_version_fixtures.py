"""Exercise the deployed baseline Copy SQL inside Tinybird Local's fixture workspace."""

import json
import re
import subprocess
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
        backdated_old = {**old, key: "baseline-backdated-fact", timestamp: new_time}
        backdated_new = {**new, key: "baseline-backdated-fact", timestamp: old_time}
        payload = "\n".join(
            json.dumps(row) for row in [old, new, new, backdated_old, backdated_new]
        )
        receipt = client._req(
            f"/v0/events?name={table}&wait=true",
            method="POST",
            data=payload.encode(),
            headers={"Content-Type": "application/json"},
        )
        if receipt.get("successful_rows") != 5 or receipt.get("quarantined_rows") != 0:
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
                FROM {target} FINAL WHERE OrgId='{org}' AND {key}='baseline-fact'""",
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
        if int(count[0]["n"]) != 5:
            raise RuntimeError(f"Baseline Copy changed preserved source rows in {category}")
    verify_resumed_proof(client, org, previous, today, query_rows)
    print("Baseline Copy version regressions passed for all six categories")


def verify_resumed_proof(client, org, previous, today, query_rows) -> None:
    renderer = """
        import {inspectBaseline,verifyBaseline} from './scripts/ingest-recovery/agent-migration-proof';
        import {CATEGORIES} from './scripts/ingest-recovery/agent-data';
        const {org,copyWindow,retainedWindow}=JSON.parse(await Bun.stdin.text());
        const queries=[];
        let currentCategory;
        const capture={sql:async query=>{
            const kind=query.includes('HAVING uniqExact')?'conflict':query.includes('argMax(')?'inspection':'parity';
            queries.push({kind,query,category:currentCategory});
            return {data:kind==='conflict'?[]:kind==='inspection'?[{rows:0,days:[]}]:[
                {source_rows:0,target_rows:0,invalid_metadata:0,missing_target:0,unexpected_target:0}
            ],meta:[]};
        }};
        await inspectBaseline(capture,org,retainedWindow,copyWindow);
        for(const category of CATEGORIES) {
            currentCategory=category;
            await verifyBaseline(capture,org,retainedWindow,{category,rows:0,days:[]},copyWindow);
        }
        console.log(JSON.stringify(queries));
    """
    inputs = {
        "org": org,
        "copyWindow": {"startDay": previous.strftime("%Y-%m-%d"), "endDay": today.strftime("%Y-%m-%d")},
        "retainedWindow": {
            "startDay": (previous + timedelta(days=1)).strftime("%Y-%m-%d"),
            "endDay": today.strftime("%Y-%m-%d"),
        },
    }
    rendered = subprocess.check_output(["bun", "-e", renderer], input=json.dumps(inputs), text=True)
    totals = {}
    for entry in json.loads(rendered):
        rows = query_rows(client, entry["query"])
        if entry["kind"] == "conflict":
            valid = rows == []
        elif entry["kind"] == "inspection":
            valid = len(rows) == 1 and int(rows[0]["rows"]) == 1 and rows[0]["days"] == [today.strftime("%Y-%m-%d")]
        else:
            valid = len(rows) == 1 and int(rows[0]["source_rows"]) == int(rows[0]["target_rows"])
            valid = valid and not any(int(rows[0].get(field, 0)) for field in ["invalid_metadata", "missing_target", "unexpected_target"])
            kind = "content" if "invalid_metadata" in entry["query"] else "index"
            key = (entry["category"], kind)
            totals[key] = totals.get(key, 0) + int(rows[0]["source_rows"])
        if not valid:
            raise RuntimeError(f"Resumed baseline {entry['kind']} revived an aged-out correction")
    if totals != {(category, kind): 1 for category in BASELINE_KEYS for kind in ["content", "index"]}:
        raise RuntimeError("Resumed baseline proof did not cover every retained winner")
