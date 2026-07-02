# Agent Session Signal Query Performance

`agent_session_signals_top_runaway` is the representative session-risk read path for
`agent_session_signals`. It must be queried with:

- `org_id`
- `repo_fingerprint` or `repos`
- `start_time_ms` and `end_time_ms`
- a clamped `limit`

The bounded fixture probe is:

```bash
tb --local test run agent_session_signals_top_runaway
```

The repo performance wrapper includes the same probe:

```bash
bun run tinybird:agent-signal:perf --local
```

Representative fixture window:
`org_session_signals`, `repo_session_signals`, `2026-05-20T00:00:00Z` through
`2026-05-22T00:00:00Z`. The endpoint finalizes aggregate states from
`agent_session_signals`; it does not scan `agent_message_facts`,
`agent_tool_event_facts`, `agent_file_event_facts`, or
`agent_pull_request_facts` on the read path.
