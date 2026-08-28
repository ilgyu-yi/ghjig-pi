# Mission

## What this exists for

An **agent-agnostic operating shell** that enforces engineering work norms — the GitHub-standard flow (issue → branch → draft PR → review-gated merge) together with documentation, testing, and evidence discipline — for work performed by agents and their operators, running on the [pi harness](https://github.com/earendil-works/pi). pi provides no built-in permission system; the shell therefore treats its enforcement layer as the only safety net — a commitment independent of any permissions the substrate may later grow. Without this shell, agentic work degrades to unreviewed, unevidenced change: nothing structural stands between an agent's mistake and the main branch.

## Success looks like

- **Traceability** — every merged change is traceable through the standard flow (issue → branch → draft PR → review-gated merge), observable in the repository history at any date.
- **Enforcement** — norm violations are blocked or surfaced by the shell's enforcement layer (the gate classes the SPEC enumerates); because pi has no permission system of its own, nothing else stands behind that layer.
- **Agent-agnosticism** — no enforced norm depends on a specific agent or model; a different agent harness can operate under the same norms.
- **Evidence** — durable artifacts (issues, PR bodies, commits) carry their claims as pointers or pinned command output, never as unverifiable assertions.

## Explicitly NOT goals

- Being an agent or a harness itself — the shell governs work; it does not perform it.
- Forking or wrapping any specific agent product.
- Serving as a general-purpose permission system for pi — the enforcement layer guards the shell's own norms, not arbitrary substrate access.

## Stakeholders

Maintainer: ilgyu-yi (decision maker). Primary users: the agents and human operators working under the shell.

## Last reviewed: 2026-08-28
