#!/usr/bin/env python3
"""Generate the org_1c 1c-rollup fixture rows and append them to the shared
fixtures. Additive: 1b's org_test rows and expectations are untouched (every
launch pipe filters by org_id). Every fixture is appended (never overwritten) so
the org_test rows survive; append is idempotent, so re-running adds no duplicate
lines."""
import json
import os
from typing import Any

ORG = "org_1c"
REPO = "repo_1c"
SRC = "claude"
MODEL = "claude-opus-4-7"
PV = "v1"


def msg(**o: Any) -> dict[str, Any]:
    base = {
        "OrgId": ORG, "UserId": "user_1c", "CollectorId": "col_1c",
        "CollectorCredentialId": "cred_1c", "repo_fingerprint": REPO,
        "repo_source": "remote", "source": SRC, "parser_version": PV,
        "session_pk": "", "message_pk": "", "EventAt": "2026-05-20 10:00:00.000",
        "IngestedAt": "2026-05-20 12:00:00.000",
        "VendorStartedAt": "2026-05-20 10:00:00.000",
        "vendor_session_id": "", "vendor_message_id": "", "turn_index": 0,
        "role": "assistant", "model": MODEL, "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_creation_tokens": 0,
        "cache_creation_5m_tokens": 0, "cache_creation_1h_tokens": 0,
        "reasoning_tokens": 0, "token_coverage": "full", "cache_coverage": "full",
        "agent_depth": 0, "is_subagent_spawn": 0, "is_sidechain": 0, "agent_id": "",
        "normalized_git_remote": "", "repo_path_fallback": "", "git_branch": "",
        "git_head_sha": "", "dropped_sensitive": 0, "cost_usd": None,
    }
    base.update(o)
    return base


def tool(**o: Any) -> dict[str, Any]:
    base = {
        "OrgId": ORG, "UserId": "user_1c", "CollectorId": "col_1c",
        "CollectorCredentialId": "cred_1c", "repo_fingerprint": REPO,
        "repo_source": "remote", "source": SRC, "parser_version": PV,
        "session_pk": "", "tool_use_pk": "", "EventAt": "2026-05-20 10:00:00.000",
        "IngestedAt": "2026-05-20 12:00:00.000", "vendor_session_id": "",
        "vendor_message_id": "", "tool_use_id": "", "source_block_index": 0,
        "tool_name": "Bash", "command_family": "git", "command_program": "",
        "command_subcommand": "", "status": "success", "exit_code": 0,
        "duration_ms": 0, "repo_relative_paths": [], "extracted_provider": "",
        "extracted_repo": "", "extracted_pr_number": 0, "command_excerpt": "",
        "error_excerpt": "", "extracted_subagent_agent_id": "",
        "extracted_subagent_model": "", "extracted_subagent_input_tokens": 0,
        "extracted_subagent_output_tokens": 0,
        "extracted_subagent_cache_read_tokens": 0,
        "extracted_subagent_cache_creation_tokens": 0, "dropped_sensitive": 0,
    }
    base.update(o)
    return base


def fevent(**o: Any) -> dict[str, Any]:
    base = {
        "OrgId": ORG, "UserId": "user_1c", "CollectorId": "col_1c",
        "CollectorCredentialId": "cred_1c", "repo_fingerprint": REPO,
        "repo_source": "remote", "source": SRC, "parser_version": PV,
        "session_pk": "", "file_event_pk": "", "EventAt": "2026-05-20 10:00:00.000",
        "IngestedAt": "2026-05-20 12:00:00.000", "vendor_session_id": "",
        "vendor_message_id": "", "source_block_index": 0,
        "normalized_repo_path": "", "operation": "edit", "dropped_sensitive": 0,
    }
    base.update(o)
    return base


def pr(**o: Any) -> dict[str, Any]:
    base = {
        "OrgId": ORG, "UserId": "user_1c", "CollectorId": "col_1c",
        "CollectorCredentialId": "cred_1c", "session_pk": "",
        "pull_request_link_pk": "", "repo_fingerprint": REPO,
        "repo_source": "remote", "source": SRC, "parser_version": PV,
        "EventAt": "2026-05-20 10:00:00.000", "IngestedAt": "2026-05-20 12:00:00.000",
        "vendor_session_id": "", "source_event_id": "", "stable_turn_index": 0,
        "host": "github.com", "owner": "o", "repo": "r", "number": 0, "url": "",
        "confidence": "high", "evidence": "assistant_text", "dropped_sensitive": 0,
    }
    base.update(o)
    return base


# A) constant-cost: cc1 = 4 direct messages x 0.25 = 1.0; input 100 each => 400.
messages = [
    msg(session_pk="cc1", message_pk=f"m_cc1_{i}", vendor_message_id=f"v_cc1_{i}",
        turn_index=i, input_tokens=100, output_tokens=10, cost_usd=0.25)
    for i in range(4)
]
# B) two-day span: span1 spans 05-20 and 05-21 => exactly one session row.
messages.append(msg(session_pk="span1", message_pk="m_span1_0",
                    vendor_message_id="v_span1_0", EventAt="2026-05-20 09:00:00.000",
                    input_tokens=100, cost_usd=0.5))
messages.append(msg(session_pk="span1", message_pk="m_span1_1",
                    vendor_message_id="v_span1_1", turn_index=1,
                    EventAt="2026-05-21 09:00:00.000", input_tokens=100, cost_usd=0.5))
# C) subagent both-forms: sub1 has a sidechain message for agentX, so the matching
#    tool-result usage for agentX is suppressed (counted once).
messages.append(msg(session_pk="sub1", message_pk="m_sub1_top",
                    vendor_message_id="v_sub1_top", output_tokens=20, cost_usd=0.5))
messages.append(msg(session_pk="sub1", message_pk="m_sub1_side",
                    vendor_message_id="v_sub1_side", turn_index=1, agent_depth=1,
                    is_sidechain=1, agent_id="agentX", output_tokens=50, cost_usd=0.3))
# D) subagent fallback-only: sub2 has no sidechain for agentY, so the tool-result
#    usage is the only evidence => one fallback row, cost null, coverage 'fallback'.
messages.append(msg(session_pk="sub2", message_pk="m_sub2_top",
                    vendor_message_id="v_sub2_top", output_tokens=20, cost_usd=0.4))

tools = [
    tool(session_pk="cc1", tool_use_pk="t_cc1_a", tool_use_id="tu_cc1_a",
         command_family="git", status="success"),
    tool(session_pk="cc1", tool_use_pk="t_cc1_b", tool_use_id="tu_cc1_b",
         command_family="npm", status="failure", exit_code=1, duration_ms=5),
    # agentX subagent usage — suppressed by the sub1 sidechain message.
    tool(session_pk="sub1", tool_use_pk="t_sub1", tool_use_id="tu_sub1",
         extracted_subagent_agent_id="agentX", extracted_subagent_model=MODEL,
         extracted_subagent_output_tokens=50),
    # agentY subagent usage — fallback (no sidechain).
    tool(session_pk="sub2", tool_use_pk="t_sub2", tool_use_id="tu_sub2",
         extracted_subagent_agent_id="agentY", extracted_subagent_model=MODEL,
         extracted_subagent_output_tokens=70),
]

files = [
    fevent(session_pk="cc1", file_event_pk="f_cc1_0", normalized_repo_path="src/a.ts"),
    fevent(session_pk="cc1", file_event_pk="f_cc1_1", normalized_repo_path="src/b.ts"),
]

prs = [
    # cc1: exactly one canonical link => primary set.
    pr(session_pk="cc1", pull_request_link_pk="pr_cc1", number=1,
       url="https://github.com/o/r/pull/1"),
    # span1: two distinct links => ambiguous => primary stays ''.
    pr(session_pk="span1", pull_request_link_pk="pr_span1_a", number=2,
       url="https://github.com/o/r/pull/2"),
    pr(session_pk="span1", pull_request_link_pk="pr_span1_b", number=3,
       url="https://github.com/o/r/pull/3"),
]


def append(path: str, rows: list[dict[str, Any]]) -> None:
    existing: set[str] = set()
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    existing.add(json.dumps(json.loads(line), sort_keys=True))
    with open(path, "a") as fh:
        for r in rows:
            key = json.dumps(r, sort_keys=True)
            if key in existing:
                continue
            existing.add(key)
            fh.write(json.dumps(r) + "\n")


append("fixtures/agent_message_facts.ndjson", messages)
append("fixtures/agent_tool_event_facts.ndjson", tools)
append("fixtures/agent_file_event_facts.ndjson", files)
append("fixtures/agent_pull_request_facts.ndjson", prs)
print(f"messages+={len(messages)} tools+={len(tools)} files+={len(files)} prs={len(prs)}")
