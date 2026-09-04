# gitjig-pi

An agent-agnostic operating shell that enforces engineering work norms — the GitHub-standard flow (issue → branch → draft PR → review-gated merge), documentation, testing, and evidence discipline — for agent-driven development on the [pi harness](https://github.com/earendil-works/pi). Built for agents and the human operators who work with them.

## Status

Active development under the contract in [`SPEC.md`](SPEC.md).

## Getting started

There is no build step — the tree ships TypeScript sources that run directly. Two prerequisites:

- [`pi`](https://github.com/earendil-works/pi) available on `PATH` — the suite drives the real binary against disposable fixtures.
- A Node.js runtime with native TypeScript type-stripping.

To arm the local git-hook tier in a clone, run `bash .githooks/bind_local_tier.sh` from the repository root — idempotent; full contract in SPEC §3.2/§4.7.

Run the verification suite as:

```sh
node --test "test/*.test.ts"
```

Keep the glob quoted, and do not run a bare `node --test`: node's default discovery treats every file under `test/` as a test and executes the harness assets themselves, so that shape false-reds on a harness asset instead of measuring the runtime. The harness's own contract stays with its author-side home, the header of [`test/harness/run-pi.ts`](test/harness/run-pi.ts).

## Documentation

- [`MISSION.md`](MISSION.md) — canonical direction for this project.
- [`SPEC.md`](SPEC.md) — the behavioural SSOT: work norms, gate classes, and workflow contracts.
