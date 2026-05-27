# Goal: build Agent Conversation Analytics (Phases 0-4)

The **skill does the work**; the **goal just loops it**. Each turn the
[`agent-analytics-driver`](./SKILL.md) skill completes one safe unit of work from
`docs/guides/agent-conversation-analytics/ROADMAP.md` and reprints the board; the `/goal` evaluator
reads that board and decides whether to fire again. Paste the block below into Claude Code (or
`claude -p`).

## The goal

```text
/goal Implement Phases 0-4 of Agent Conversation Analytics by running the agent-analytics-driver skill
each turn. Done when the skill's printed board shows every Phase 0-4 task marked ✅ and merged to main
with CI green. Stop early and hand back if the skill reports a ⛔ blocker, hits a decision the ADR can't
answer, or adds no new ✅ across 6 turns; in any case stop after 150 turns.
```

## Before firing

- On the `agent-analytics` branch, cut off `main`.
- `tb workspace current` returns `trace_flow_dev` (never prod).
- The `code-review` skill / `code-reviewer` subagent is discoverable (`.claude/skills/code-review`
  resolves). CodeRabbit is optional — only needed if a slice hits the escalation rubric; auth it with
  `coderabbit auth status` then if so.
- The skill is discoverable: `.claude/skills/agent-analytics-driver` resolves to this folder.
- Effort: Opus 4.7 `/effort max` (or `xhigh` floor); GPT-5.5 `xhigh` (or `high` floor).

## Why the goal stays this short

`/goal` is a Stop-hook: it can only allow a stop or force a continue, judging from the transcript. So
the condition carries exactly two things: the done-check (board all ✅ and merged) and the off-switch
(blocker / stall / turn cap). Without the off-switch a blocked agent gets force-looped until its
context dies. Everything about _how_ to work (safety rules, file lanes, verify matrix, phase-merge
discipline) lives in [`SKILL.md`](./SKILL.md), so the loop itself never has to think. It only asks
"done or not?"
