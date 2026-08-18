# shared-02: Wire Iris to Atlas for real

**What to build:** replace Atlas's sample colored patterns with Iris's live output, so a real Helios motif can be colored by Iris and then repeated across garment regions by Atlas, in one chain, with each engine's cost recorded separately and the chain traceable end to end.

**Objective:** both engines are built against sample data on purpose, so neither squad ever waits on the other. That decision is what makes the two sprints genuinely parallel, and it leaves exactly one piece of work behind: the actual connection. This ticket is that piece, and it is written down and owned so it cannot be the thing nobody picked up. In sprint 1, ticket 09's backend items sat unassigned as `TBD` and caused real delay; this is the same shape of risk, named in advance.

**Final result:** a Helios motif goes in one end and a patterned garment comes out the other. Three runs, three engines, three audit tables, joined by `source_p_invoc_id` forming a chain from Atlas back through Iris back to Helios.

**Blocked by:** both engines' sample-data phases being stable and merged, and both engines' real model calls working. Concretely: iris-05, iris-09, and Atlas's equivalents.

**Status:** blocked, and deliberately so. This lands late in the sprint, not early.

**Owner:** jointly, Maaz Bin Asif and Maaz Ahmad. One of them holds it, and it is written down here which: **to be filled in when both engines' Phase 2 is merged.**

**Duration:** 1 day. **Scheduled:** Fri Aug 28 to Fri Aug 28.

## Read this first

- `.scratch/iris-sprint-2/plan.md`, "Cross-engine contract", and `.scratch/atlas-sprint-2/plan.md`, the same section.
- `packages/shared-types/src/v1/iris.ts`, `IrisResultSchema`. Atlas's input type is literally this type, not a hand-maintained copy of it.
- `docs/sprint-2-3-conventions.md`, the paragraph on carrying `source_p_invoc_id` forward and why it matters before the databases are merged.

## Decisions

1. **Atlas's input type is Iris's output type, imported, not copied.** One definition in `packages/shared-types`, and everything else derived from it. A hand-maintained duplicate drifts the first time either side changes, and the drift shows up as a runtime shape error in the engine that did not change.
2. **The chain is driven by whoever calls the APIs, not by an engine.** There is no coordinator engine yet. Athena does not exist. Do not build one here, and do not have Iris call Atlas directly or Atlas call Iris. Each engine takes a reference to the previous engine's output as an input, and something outside both of them does the passing. That something is a person, or the playground, for now.
3. **Each engine records its own cost on its own rows.** No combined total is stored anywhere. A full-pipeline cost is computed by summing across the three tables, joined on the chain. Storing a combined total would mean deciding which engine owns it and keeping it correct as any of the three retries.
4. **The chain is `source_p_invoc_id`, one level per hop.** Iris's row points at its Helios run; Atlas's row points at its Iris run. Not a single "pipeline id" threaded through all three. One-level links survive an engine being run standalone, which all three still support and which is how they are all tested.
5. **Swapping the sample data for real data must be a change in data, not a change in shape.** If either engine needs a code change beyond changing what it points at, then its sample data did not match the contract and that is the actual bug this ticket found. Say so rather than patching it.
6. **Verify against a real chain before ticking anything, and budget for it.** The whole chain is one text call plus two image calls.

## Work

- [ ] Confirm Atlas's sample colored patterns validate against `IrisResultSchema` as written. If they do not, fix the sample data, not the schema, unless the schema is genuinely wrong. (**owner**)
- [ ] Confirm Iris's real output validates against the same schema at runtime, not just at compile time. It crosses a worker boundary, which is why `IrisResultSchema` is a schema rather than an interface. (**owner**)
- [ ] Point Atlas at a real Iris `image_url` instead of its fixture. If that is the entire change, decision 5 held and the sprint's parallel-work approach worked. Record that in the ticket either way. (**owner**)
- [ ] Confirm Atlas reads `width` and `height` from the Iris result rather than fetching and decoding the image. That is what those fields are on the result for. (**owner**)
- [ ] Confirm Atlas's `source_p_invoc_id` is populated with the Iris run's `p_invoc_id`, and Iris's with the Helios run's. Walk the chain by hand on a real run. (**owner**)
- [ ] Write down the query that produces a full-pipeline view across the three tables. Three separate reads stitched together in code today, one join once the databases are merged in shared-03. Put it in `docs/`, not only in this ticket, because in six months a ticket file is not where anyone looks. (**owner**)
- [ ] Decide and record what happens when the middle of the chain fails. If Iris fails, Atlas has nothing to place: does the caller retry Iris, or resume it? The answer is already implied by each engine's resume rules, so state it rather than deriving it again later. (**owner**)
- [ ] Do **not** build a coordinator (decision 2). If this ticket starts to feel like it wants one, that is a finding worth raising in the group, and it is Athena's scope, not this sprint's. (**owner**)

### Review gates

- [ ] The manager who does **not** own this ticket runs the full chain themselves, from a fresh concept, and confirms the output is a patterned garment. (**the other manager**)
- [ ] Confirm the three costs are separately readable and that they sum to something plausible. (**the other manager**)
- [ ] Confirm nothing in either engine imports the other engine's code. Both may import `packages/shared-types`; neither may import from `apps/`. `grep -rn "agent-iris" apps/agent-atlas/src` and the reverse should both return nothing. (**Saad Naik**)
- [ ] Nobody approves their own work. (**both managers**)

## Verification without burning budget

**Budget: about $0.007 for one full chain.** One Helios image call, one Iris text call, one Iris image call, one Atlas image call. Two or three full chains is under three cents. Do not loop the chain while debugging; debug each engine against the other's sample data, which is free, and spend only on the final joins.

1. Helios generates a motif. Copy its `image_url` and `p_invoc_id`.
2. Iris colors it. Copy its `image_url` and `p_invoc_id`.
3. Atlas repeats it across garment regions. Look at the output.
4. Query all three `/runs` routes and walk the chain backward from Atlas's row to Helios's using `source_p_invoc_id` alone.
5. Sum the costs across the three and sanity-check the total.

## Two things that will waste your afternoon

**A hand-copied input type passes typechecking on both sides and fails at runtime.** If Atlas defines its own `ColoredPattern` interface that happens to match `IrisResult` today, both engines compile, both test suites pass, and the first real call fails on a field name. Decision 1 is not a style preference. Check the import path before anything else.

**Debugging the chain by running the chain is the expensive way to do it.** Each full run costs four model calls, and a chain has three places to be wrong. Debug Iris against Atlas's fixture and Atlas against Iris's fixture, both free, and reserve real chains for confirming what you already believe works.
