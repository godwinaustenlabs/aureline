# Architecture Decision Records

An ADR records **why one decision was made and what was rejected**. The docs in [docs/](../) tell you what the system does; these tell you why it does it that way. Read them before changing architecture.

## The flat files, `0001` through `0010`

The ten files directly in this directory were written when Helios was the only engine, and several of them apply repo-wide rather than to Helios alone. **They stay exactly where they are, with their current names and numbers.** They are cited by bare number from both sprint plans, from fifteen ticket files and from code comments, so renumbering them would be tidier and would break every one of those references for no gain. Think of them as the foundational set: decisions made before there was more than one engine.

## New ADRs go in an engine's own directory

| Directory | For |
|---|---|
| [`iris/`](iris/) | Decisions affecting Iris only |
| [`atlas/`](atlas/) | Decisions affecting Atlas only |
| [`shared/`](shared/) | Decisions binding more than one engine |

**Each directory numbers from `0001` independently.** Two squads can never collide on a number, because they are not drawing from the same sequence. This is the same reasoning that keeps each engine's D1 database separate during parallel work, one level down — see [sprint-2-3-conventions.md](../../.scratch/shared-sprint-2/sprint-2-3-conventions.md).

A decision that affects one engine goes in that engine's directory **even if it was made in a shared meeting**. `shared/` is for decisions that genuinely bind several engines, such as consolidating the per-engine D1 databases.

## Citing one

The engine name is part of the citation:

- `ADR-0005` — a foundational one, flat in this directory
- `ADR-IRIS-0001` — `iris/0001-...`
- `ADR-ATLAS-0001` — `atlas/0001-...`
- `ADR-SHARED-0001` — `shared/0001-...`

That is why the engine name is not optional: a bare `ADR-0001` unambiguously means the foundational one and nothing else. A bare number written inside an engine directory would read as a foundational ADR to anyone skimming.

## Writing one

There is deliberately **no template, no index and no tooling**. Ten ADRs have been written in a consistent format without any, by reading the previous one first. Do that. [`0009`](0009-retry-policy-is-per-stage-not-per-pipeline.md) and [`0010`](0010-export-the-whole-do-before-pruning-any-of-it.md) are the two most recent and the ones to match.

One thing worth saying out loud: an ADR that only ever agrees with its predecessors is not doing its job. Where a decision departs from an earlier ADR, cite that ADR and **argue** the departure rather than quietly not mentioning it.
