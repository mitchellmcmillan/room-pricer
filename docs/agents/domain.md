# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root.
- `docs/adr/` for ADRs that touch the area you're about to work in.

If these files do not exist yet, proceed silently.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`.

If the concept you need is not in the glossary yet, note the gap rather than inventing a synonym.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
