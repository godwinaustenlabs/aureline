# atlas-08: Failure handling and the resume route

**What to build:** the decision about which of Atlas's failures retry themselves and which need a person, recorded in an ADR; and `POST /resume`, which re-runs an existing invocation's image call using the placement already on disk.

**Objective:** Atlas has exactly one billable call, and it is the whole engine. That makes the retry question simpler than Iris's and the answer more consequential: there is no cheap stage to auto-retry, so every automatic retry is a full duplicate charge. Without a resume route, a failed call means the run is thrown away and the caller starts over by hand. With one, the failure can be re-attempted deliberately, under a cap, with the whole history readable from `atlas_runs` alone.

**Final result:** `POST /resume` takes a `p_invoc_id`, refuses clearly when resuming makes no sense, and otherwise generates a fresh garment image from the stored placement under a spend cap. A brief's full history, including its retries, is reconstructable from the audit table.

**Blocked by:** atlas-06 for the decision work, which can start immediately. atlas-07 must be merged before the route can be finished and verified.

**Status:** ready-for-human, for the decision half.

**Owner:** Maaz Bin Asif. **Reviewer:** Maaz Ahmad.

## Read this first

- ADR-0009 in full, and `ADR-IRIS-0001` from iris-10. Between them they are the retry reasoning for the other two engines. Most of it transfers; the parts that do not are the substance of this ticket.
- `.scratch/iris-sprint-2/issues/10-failure-handling-and-resume.md`. Written by the same person, one engine earlier. This ticket is deliberately a short informed diff off it rather than a copy, and the differences below are the point.
- `apps/agent-helios/src/services/resume.ts` (198 lines). Six refusals, a spend cap counted over the root brief, a resumed row, then a re-entry into the image stage. It is its own file because it is a second entry point into the pipeline rather than a step within it.
- `.scratch/helios-sprint-1/issues/08-failure-handling.md`, decisions 4, 5, 6 and 15. Those four are the contract Atlas is keeping.
- `docs/helios-runs-conventions.md`, for what the resume markers mean on a row.

## Decisions

1. **Nothing in Atlas auto-retries. Not one thing.** ADR-0009 says the policy is decided per stage, and Atlas has one stage, which is expensive, one-shot, and likely to fail the same way twice. Iris's text stage auto-retries because a slightly-wrong JSON reply is cheap and usually succeeds on a second attempt; Atlas has no such stage. Say this in the ADR explicitly rather than leaving "per stage" to be read as "the same as Iris".
2. **A resumed run writes exactly one row, not two.** In Helios and Iris a resume writes a resumed text row carrying the markers plus a new image row. Atlas has one row per invocation (`ADR-ATLAS-0001`), so the markers go on that one row and there is nothing else to write. This also means the marker-only-on-the-text-row trap that Helios and Iris both have cannot happen here.
3. **A failed run returns HTTP 200 with a settled status in the body** (ticket 08, decision 4). Already built in atlas-06. Restated because this is the ticket where it would be tempting to make a refusal a 500.
4. **A refusal is a 409, not a failed result.** A refusal never became an invocation: no row written, no model called, nothing billed. Returning a `failed` result would claim a run happened.
5. **The resumed run gets a new `p_invoc_id`.** The original is never reused. Each attempt is its own invocation with its own row and its own cost.
6. **Three markers in `model_metadata`: `root`, `resumed_from`, `attempt`.** `root` is the original brief, which is what the cap counts over. `resumed_from` is the immediate parent, so a chain is walkable. `attempt` is the ordinal.
7. **`root` is what the cap counts, not `resumed_from`.** Counting the immediate parent lets a chain of resumes each start a fresh count and spend without limit. `countResumeAttempts` from atlas-04 takes a root for this reason.
8. **The cap is `config.maxResumeAttempts`**, resolved from KV. Because Atlas has one billable call, this number is exactly the ceiling on what one brief can cost: three means the original plus three retries, so four times $0.003.
9. **Resume re-enters at `runImageStage`, never at `runPipeline`.** This is why atlas-06 exported it separately.
10. **Re-validate the stored placement before using it.** `garment_regions` is a JSON column typed `unknown`. It was valid when written, but the schema may have moved since. Parse it with `AtlasPlacementSchema` and refuse with a clear message rather than sending something malformed to a billed call.
11. **Resume must not produce a second image for a run that already has one.** That is a paid call producing a duplicate nobody asked for.
12. **Decide what an unfetchable pattern or an unfetchable garment reference means, and record it.** Both are Atlas's most likely real failures. The pattern depends on another engine's storage and on that engine's own retention pruning; the garment reference depends on wherever the caller uploaded it, which Atlas does not control at all. Either one that existed at generate time may not exist at resume time. Decide whether each is a refusal or a failure and write it down. They can share one decision if the reasoning is genuinely the same, but they still need two distinct refusal messages, because a caller told "the reference is unfetchable" with no indication of which one has no way to fix it.

## Agreed shapes, do not invent your own

```ts
// apps/agent-atlas/src/services/resume.ts
export type ResumeOutcome =
  | { ok: false; reason: string }
  | { ok: true; result: AtlasResult };

export async function resumeRun(
  db: AtlasDb, p_invoc_id: string, env: Env, origin: string
): Promise<ResumeOutcome>;
```

The refusals. Each needs a distinct message, because the message is the only thing the caller gets.

| Situation | Refusal message, roughly |
|---|---|
| No such run in this session | `no run {id} in this session` |
| The run already has an image | `this run already has an image, and resuming would generate and charge for a second one` |
| The run is still `running` | `this run is still being generated. Wait for it to settle before resuming` |
| The stored placement no longer validates | `the stored placement is no longer valid: {field}: {message}` |
| The cap is reached | `this brief has already been resumed N times, the limit is M. Send a new POST /generate if it is still worth pursuing` |
| The pattern is no longer fetchable | decided in this ticket, see decision 12 |
| The garment reference is no longer fetchable | decided in this ticket, see decision 12; needs its own message so a caller knows which of the two inputs to fix |

Helios has six refusals and Iris has seven. Atlas now has seven too, though for a different reason than Iris: "the planner never succeeded, so there are no params to reuse" still has no analogue here, but Atlas's own second reference image (`garment_ref`, added after this file was first written) adds a refusal Iris does not have. Two engines landing on the same count by coincidence, not by copying.

Markers in `model_metadata`, on the resumed run's single row:

```jsonc
{ "root": "<original p_invoc_id>", "resumed_from": "<immediate parent>", "attempt": 2 }
```

## Work

### The decision, first, before any code

- [ ] Write the ADR at `docs/adr/atlas/0002-...`, following shared-04's scheme, cited as `ADR-ATLAS-0002`. State that nothing auto-retries and why, for Atlas specifically (decision 1). Where the answer matches ADR-0009, say why the reasoning transfers rather than only citing it. (**Maaz Bin Asif**)
- [ ] In the same ADR, decide the unfetchable-pattern and unfetchable-garment-reference questions (decision 12). For the pattern, include the case where Iris's own retention pruning removed the source run, because that is a real interaction between two engines' lifecycles and it will happen. For the garment reference, name that it is always an external URL (there is no upload endpoint, atlas-01 decision 6), fetched fresh on every attempt including a resume, so it can go stale for reasons entirely outside our control: the link expires, the host takes the image down, the caller's own storage changes. That is a different, less predictable failure mode than the pattern's, which at least depends on our own retention policy. (**Maaz Bin Asif**)
- [ ] In the same ADR, state what `max_retries` governs in Atlas, given nothing on the image path retries. If the honest answer is "nothing today", say that, so the next person does not assume it is load-bearing. (**Maaz Bin Asif**)
- [ ] Do **not** re-answer the two open notes from `Considerations for Sprint 2.md` here. `ADR-IRIS-0001` answers both, and this ADR cites it. Two ADRs answering the same question differently is worse than one. (**Maaz Bin Asif**)

### The route

- [ ] Write `src/services/resume.ts`, its own file because it is a second entry point into the pipeline rather than a step within it. (**Maaz Bin Asif**)
- [ ] Implement all seven refusals, each with its own message. A single generic "cannot resume" is useless to a caller and worse than no route. (**Maaz Bin Asif**)
- [ ] Count the cap over `root` using `countResumeAttempts` (decisions 6 and 7). (**Maaz Bin Asif**)
- [ ] Re-validate the stored placement with `AtlasPlacementSchema.parse` and refuse with `firstIssueMessage` on failure (decision 10). (**Maaz Bin Asif**)
- [ ] Call `runImageStage` with the markers as `metadataExtras`, so they land on the resumed run's row (decision 2). There is only one row, so there is only one place they can go and no way to get this half right. (**Maaz Bin Asif**)
- [ ] Do **not** write a resumed non-image row for symmetry with Helios and Iris. There is no planner call to record the absence of. (**Maaz Bin Asif**)
- [ ] Wire `POST /resume` in `agent.ts`: validate with `AtlasResumeRequestSchema`, 400 on a malformed body, 409 on a refusal, 200 with the result otherwise. Replace atlas-06's not-implemented stub. (**Maaz Bin Asif**)
- [ ] Confirm `/resume` routes to the DO by the same `scopeKey` rule `/generate` does. A run can only be resumed from the DO that holds it. atlas-02 already did this; verify it. (**Maaz Bin Asif**)
- [ ] Confirm `exportAndPrune` runs on a resumed run's exit paths too, not just `runPipeline`'s. (**Maaz Bin Asif**)

### Tests

- [ ] Write `services/resume.test.ts` with one test per refusal. Seven refusals, seven tests, each asserting the specific message. (**Maaz Bin Asif**)
- [ ] Test the cap counting over `root` across a **chain**: original, resume, resume-of-resume. Assert the third is refused when the cap is two. A cap that counts `resumed_from` passes a single-level test and fails this one, which is why this test exists. (**Maaz Bin Asif**)
- [ ] Assert the markers land on the resumed run's row and that a resumed run is exactly one row. (**Maaz Bin Asif**)
- [ ] Assert a refusal writes **no row at all** and never touches the fake `AI` binding. A refusal that quietly bills is the worst outcome this ticket can produce, and for Atlas it is also the most expensive one. (**Maaz Bin Asif**)

### Review gates

- [ ] Read the ADR and confirm it decides the auto-retry question, the unfetchable-pattern question, the unfetchable-garment-reference question and the `max_retries` question, rather than deferring any of them. A deferred question in an ADR reads as an answered one six months later. (**Maaz Ahmad**)
- [ ] Trigger a real resume and confirm the second image differs from the first. If they are identical, `skipCache` from atlas-07 is not in effect and resume is spending money to return a cached image. (**Maaz Ahmad**)
- [ ] Hit the cap for real and confirm the refusal message names the actual count and the actual limit. (**Maaz Ahmad**)
- [ ] Confirm each refusal path costs nothing, by checking the gateway log gains no row after each one. (**Maaz Ahmad**)
- [ ] Read `GET /runs` for a resumed brief and confirm the whole history is reconstructable from the markers alone. (**Maaz Ahmad**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003 per successful resume.** Two successful resumes plus hitting the cap is roughly a cent and a half. Every refusal path is free by design, so test all six of those first and exhaustively, and only then spend on the success path.

1. Test all seven refusals with curl before making a single successful resume. Each returns 409 with its own message, and the gateway log stays unchanged.
2. A real successful resume returns 200 with a new `p_invoc_id` and a new, visibly different image.
3. `curl -s 'http://localhost:8787/runs?p_invoc_id=<resumed id>' | jq`. The single row carries `root`, `resumed_from` and `attempt` in `model_metadata`.
4. Set `max_resume_attempts` to 1 with `npm run kv:put --workspace=apps/agent-atlas`, hit the cap, confirm the message. **Put it back:** `npm run config:pull:atlas`.
5. `npm test --workspace=apps/agent-atlas` passes.

## Two things that will waste your afternoon

**A cap that counts `resumed_from` instead of `root` looks correct and is unbounded.** Each resume becomes the parent of the next, each count restarts at one, and a brief can be retried forever. It passes any single-level test. The chain test above is the only thing that catches it, so write the test before the code.

**Copying Iris's resume wholesale brings a text row with it.** Iris writes a resumed text row carrying the markers, because it has a planner whose absence needs recording. Atlas does not, and a second row would break the one-row-per-invocation property that atlas-09's chunk arithmetic, atlas-10's history table and `ADR-ATLAS-0001` all rest on. The row-count assertion in the tests is what catches this.
