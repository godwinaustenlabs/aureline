# shared-04: Per-engine ADR directories

**What to build:** three subdirectories under `docs/adr/`, one per engine plus one for cross-engine decisions, and a short README explaining the scheme. The ten existing ADRs stay exactly where they are and are not renumbered.

**Objective:** ADRs are currently one flat numbered sequence, and two squads are about to write into it at the same time. Whoever merges second finds their number taken, and the fix is a rename that breaks every citation already written against it. This is the same class of shared mutable resource that `docs/sprint-2-3-conventions.md` warns about with D1 databases, and it has the same fix: give each squad its own space during parallel work. It is a fifteen-minute ticket that has to land before either squad writes its first ADR, which is what makes it worth naming rather than leaving to be sorted out on the day.

**Final result:** the Iris squad and the Atlas squad can each write an ADR without coordinating, every ADR has an unambiguous citation, and no existing reference to `ADR-0001` through `ADR-0010` changes.

**Blocked by:** nothing. Do this first. It blocks iris-10 and atlas-04, both of which write an ADR.

**Status:** ready-for-human.

**Owner:** Maaz Bin Asif. **Reviewer:** Maaz Ahmad.

## Read this first

- `docs/adr/`, the ten existing files, just to see the naming and the format. `0009-retry-policy-is-per-stage-not-per-pipeline.md` and `0010-export-the-whole-do-before-pruning-any-of-it.md` are the two most recent and the ones to match.
- `docs/sprint-2-3-conventions.md`, the paragraph on separate D1 databases. The reasoning there is the same reasoning here, one level down.

## Decisions

1. **`0001` through `0010` stay exactly where they are, at `docs/adr/`, with their current names and numbers.** They are cited by number from both sprint plans, from fifteen ticket files, and from code comments. Moving them would be tidier and would break every one of those references for no gain. They become, in effect, the foundational set: decisions made before there were multiple engines.
2. **New ADRs go in `docs/adr/iris/`, `docs/adr/atlas/`, or `docs/adr/shared/`.** Each directory numbers from `0001` independently. Two squads can never collide, because they are not drawing from the same sequence.
3. **Citation format is `ADR-IRIS-0001`, `ADR-ATLAS-0001`, `ADR-SHARED-0001`.** The engine name is part of the citation, so `ADR-0001` unambiguously means the flat foundational one and nothing else. A bare number in a new directory would read as a foundational ADR to anyone skimming.
4. **`shared/` is for decisions that bind more than one engine.** shared-03's consolidation reasoning goes there. If a decision only affects one engine, it goes in that engine's directory even if it was made in a shared meeting.
5. **A README, not a convention that lives in someone's head.** Sprint 1's retro was explicit that a rule nobody can check is a rule nobody follows, and this one cannot be checked automatically. Writing it down where the files are is the next best thing.
6. **Do not add a template, an index, or tooling.** Ten ADRs have been written without any, in a consistent format, by reading the previous one. Adding process here is solving a problem nobody has.

## Work

- [ ] Create `docs/adr/iris/`, `docs/adr/atlas/` and `docs/adr/shared/`. A `.gitkeep` in each until its first ADR lands. (**Maaz Bin Asif**)
- [ ] Write `docs/adr/README.md`. Three short paragraphs: what the flat `0001` to `0010` files are and why they stay put, where a new ADR goes and how it is numbered, and the citation format with one real example of each. (**Maaz Bin Asif**)
- [ ] Do **not** move, rename or renumber any existing file (decision 1). `git status` should show only new files. (**Maaz Bin Asif**)
- [ ] Update `.scratch/iris-sprint-2/issues/10-failure-handling-and-resume.md`. Its work list currently says to number the ADR `0011` in `docs/adr/`. It becomes `docs/adr/iris/0001-...`, cited as `ADR-IRIS-0001`. This is the only hard-coded new ADR number in any of the three backlogs. (**Maaz Bin Asif**)
- [ ] Update `.scratch/shared-sprint-2/issues/03-d1-consolidation.md`, decision 7, which says its ADR belongs in `docs/adr/`. It goes in `docs/adr/shared/`. (**Maaz Bin Asif**)
- [ ] Tell both squads in the group, not just in this ticket. Two people are about to write ADRs and neither will read this file first. (**Maaz Bin Asif**)

### Review gates

- [ ] Confirm no existing ADR file moved or changed. `git status` shows only additions. (**Maaz Ahmad**)
- [ ] Confirm the README's citation examples match what iris-10 and atlas-04 will actually write, by reading those two tickets' ADR boxes against it. (**Maaz Ahmad**)
- [ ] Confirm iris-10 and shared-03 were both updated, since a ticket still saying `0011` would put someone straight back into the collision this ticket exists to prevent. (**Maaz Ahmad**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero, permanently.**

1. `git status` shows three new directories, one new README, and two edited ticket files. Nothing else.
2. `grep -rn "ADR-0011" .scratch/ docs/` returns nothing.
3. Both squads know. Ask them.

## Two things that will waste your afternoon

**Renumbering the existing ten while you are in there is the obvious tidy-up and it is the one thing this ticket forbids.** Every ADR reference in the repo is a bare number in prose, so nothing would fail to compile and nothing would fail a test. The breakage is silent and it lands on whoever next follows a citation to the wrong document.

**Doing this after someone has already written `0011` costs more than doing it now.** The file exists, it is cited from a ticket and probably from a code comment, and moving it means finding all of those. The whole value of this ticket is that it is fifteen minutes on day one instead of an hour in week three.
