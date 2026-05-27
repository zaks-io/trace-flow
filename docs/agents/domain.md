# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

**Single-context.** One `CONTEXT.md` and one `docs/adr/` directory at the repo root cover the whole monorepo.

```
/
├── CONTEXT.md              ← glossary + domain language
├── docs/adr/               ← architectural decision records
│   ├── 0001-…md
│   └── 0002-…md
└── apps/, packages/, …
```

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/agents/repo-navigation.md`** for where code and docs live
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

If either is missing, **proceed silently**. Don't flag the absence; don't suggest creating them upfront. `/grill-with-docs` creates them lazily when terms or decisions actually crystallise.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
