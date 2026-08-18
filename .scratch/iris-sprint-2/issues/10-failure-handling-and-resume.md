# iris-10: Failure handling and the resume route

**What to build:** the decision about which of Iris's failures retry themselves and which need a person, written down as an ADR; and `POST /resume`, which re-runs the image half of an existing invocation using the params already on disk instead of calling the planner again.

**Objective:** Iris spends real money on a call that cannot be retried automatically. Without a resume route, a failed image call means the whole run is thrown away and the next attempt pays for the planner again. With one, the expensive half can be re-attempted on a human's decision, with a hard cap on how much any single brief can cost. In Helios's sprint this work was very nearly left until too late and then turned into the most detailed ADR in the set, which is the argument for doing it deliberately rather than discovering it.

**Final result:** `POST /resume` takes a `p_invoc_id`, refuses clearly when resuming makes no sense, and otherwise generates a fresh image from the stored params under a spend cap. A run's full history, including its retries, is readable from `iris_runs` alone.

**Blocked by:** iris-05 for the decision work, which can start immediately. iris-08 and iris-09 must both be merged before the route can be finished and verified.

**Status:** ready-for-human, for the decision half.

**Owner:** Maaz Bin Asif. **Reviewer:** Ali Amir.

**Duration:** 2 days. **Scheduled:** Thu Sep 3 to Fri Sep 4.

## Read this first

- ADR-0009 in full. It is the retry policy for Helios and most of it applies unchanged, but "most" is the point of this ticket: the parts that do not apply have to be named.
- `apps/agent-helios/src/services/resume.ts` (198 lines). Six refusals, a spend cap counted over the root brief, a resumed text row, and then a re-entry into the image stage. It is its own file because it is a second entry point into the pipeline rather than a step within it.
- `.scratch/helios-sprint-1/issues/08-failure-handling.md`, particularly decisions 4, 5, 6 and 15. Those four are the contract Iris is keeping.
- `docs/helios-runs-conventions.md`, for what the resume markers mean on a row.
- `docs/Project Wide/Considerations for Sprint 2.md`. Two open notes in there belong to this ticket and are listed in the work below.

## Decisions

1. **Retry policy is decided per stage, based on how that specific call fails** (ADR-0009). The text stage retries automatically because a slightly-wrong JSON reply is cheap and very likely to succeed on a second attempt. The image stage never retries automatically because it is expensive, one-shot, and likely to fail the same way twice. This is not copied from Helios without thinking; it is the same conclusion reached from the same facts, and Iris's two stages happen to have the same economics.
2. **A failed run returns HTTP 200 with a settled status in the body** (ticket 08, decision 4). Already built in iris-05. Restated here because this ticket is where it would be tempting to make a resume refusal a 500.
3. **A refusal is a 409, not a failed result.** A refusal never became an invocation: no rows written, no model called, nothing billed. Returning a `failed` result would claim a run happened. A run that did happen and failed is still a 200.
4. **The resumed run gets a new `p_invoc_id`.** The original is never reused. Each attempt is its own invocation with its own two rows and its own cost.
5. **Three markers on the resumed rows: `root`, `resumed_from`, `attempt`.** `root` is the original brief's `p_invoc_id`, which is what the spend cap counts over. `resumed_from` is the immediate parent, so a chain of resumes is walkable. `attempt` is the ordinal. They go in `model_metadata`, on **both** rows of the resumed run.
6. **`root` is what the cap counts, not `resumed_from`.** Counting the immediate parent would let a chain of resumes each start a fresh count and spend without limit. `countResumeAttempts` from iris-03 takes a root for this reason.
7. **The cap is `config.maxResumeAttempts`**, resolved from KV, counting resumes only. Three means the original plus three retries. Every retry spends the image model, so this value is the ceiling on what one concept can cost.
8. **Resume re-enters at `runImageStage`, never at `runPipeline`.** The planner is not called again: its params are already on disk and paying for them twice is the thing resume exists to avoid. This is why iris-05 exported `runImageStage` separately.
9. **Re-validate the stored params before using them.** `planner_params` is a JSON column typed `unknown`. It was valid when written, but the schema may have changed since. Parse it with `IrisParamsSchema` and refuse with a clear message if it no longer fits, rather than sending something malformed to a billed call.
10. **Resume must not be able to produce a second image for a run that already has one.** That is a paid call producing a duplicate nobody asked for. Refuse it.
11. **Answer the two open sprint-2 considerations here, in the ADR, rather than leaving them open.** They are: whether to build more complete retry logic for a model returning an unusual or empty response, and whether to use the AI Gateway's own built-in retry instead of our own. Both are retry-policy questions and this is the retry-policy ticket. A decision to not do something is still a decision and still gets written down.

## Agreed shapes, do not invent your own

```ts
// apps/agent-iris/src/services/resume.ts
export type ResumeOutcome =
  | { ok: false; reason: string }
  | { ok: true; result: IrisResult };

export async function resumeRun(
  db: IrisDb, p_invoc_id: string, env: Env, origin: string
): Promise<ResumeOutcome>;
```

The refusals, adapted from Helios's six. Each has to be a distinct message, because the message is the only thing the caller gets.

| Situation | Refusal message, roughly |
|---|---|
| No such run in this session | `no run {id} in this session` |
| The planner never succeeded, so there are no params | `the planner never succeeded for this run, so there are no params to reuse. Send a new POST /generate` |
| The run already has an image | `this run already has an image, and resuming would generate and charge for a second one` |
| The image row is still `running` | `this run's image is still being generated. Wait for it to settle before resuming` |
| The stored params no longer validate | `the stored params are no longer valid: {field}: {message}` |
| The cap is reached | `this brief has already been resumed N times, the limit is M. Send a new POST /generate if it is still worth pursuing` |
| The motif is no longer fetchable | new for Iris, see the work below |

Markers in `model_metadata`, on both rows of a resumed run:

```jsonc
{ "root": "<original p_invoc_id>", "resumed_from": "<immediate parent>", "attempt": 2 }
```

## Work

### The decision, first, before any code

- [ ] Write the ADR at `docs/adr/iris/0001-...`, cited as `ADR-IRIS-0001`, following shared-04's per-engine directory scheme and the format of the existing ten in `docs/adr/`. If `docs/adr/iris/` does not exist yet, shared-04 has not landed and this box waits on it. It must state, per stage, what retries and what does not, and why, for Iris specifically. Where the answer matches ADR-0009, say so and say why the reasoning transfers, rather than only citing it. (**Maaz Bin Asif**)
- [ ] In the same ADR, answer the more-complete-retry-logic question from `Considerations for Sprint 2.md`. What happens when a model returns a well-formed but empty or nonsense response? Does that count as a schema failure worth retrying, or a real failure? Decide it. (**Maaz Bin Asif**)
- [ ] In the same ADR, answer the AI-Gateway-built-in-retry question. If the answer is no, say what our own retry does that the gateway's does not, because otherwise this question returns every sprint. (**Maaz Bin Asif**)
- [ ] Name one Iris-specific failure Helios does not have: the motif reference is unfetchable. Decide whether that is recoverable (retry the fetch) or not (refuse), and record it. This is the failure most likely to actually happen in practice, because it depends on another engine's storage. (**Maaz Bin Asif**)

### The route

- [ ] Write `src/services/resume.ts`, its own file because it is a second entry point into the pipeline rather than a step within it. (**Maaz Bin Asif**)
- [ ] Implement every refusal in the table above, each with its own message. A single generic "cannot resume" is useless to a caller and worse than no route. (**Maaz Bin Asif**)
- [ ] Count the cap over `root` using `countResumeAttempts` (decisions 6 and 7). (**Maaz Bin Asif**)
- [ ] Re-validate the stored params with `IrisParamsSchema.parse` and refuse with `firstIssueMessage` on failure (decision 9). (**Maaz Bin Asif**)
- [ ] Write the resumed text row with `insertResumedTextRun`, carrying the three markers, and **no planner call**. Its `cost_usd` is null because nothing was spent on it. (**Maaz Bin Asif**)
- [ ] Call `runImageStage` with the markers as `metadataExtras`, so they land on the image row too. That row is the one carrying `cost_usd` and `image_r2_key`, and therefore the one every cost query reads (ticket 08, decision 15). Markers only on the text row would make the retries invisible to any cost report. (**Maaz Bin Asif**)
- [ ] Wire `POST /resume` in `agent.ts`: validate with `IrisResumeRequestSchema`, 400 on a malformed body, 409 on a refusal, 200 with the result otherwise. Replace iris-05's not-implemented stub. (**Maaz Bin Asif**)
- [ ] Confirm `/resume` routes to the DO by the same `scopeKey` rule `/generate` does. A run can only be resumed from the DO that holds it, so both must land in the same place. iris-02 already did this; verify it. (**Maaz Bin Asif**)
- [ ] Confirm `exportAndPrune` runs on a resumed run's exit paths too, not just `runPipeline`'s. A resumed run's rows are as real as any other's. (**Maaz Bin Asif**)

### Tests

- [ ] Write `services/resume.test.ts` with one test per refusal in the table. Seven refusals, seven tests, each asserting the specific message. (**Maaz Bin Asif**)
- [ ] Test the cap counting over `root` across a **chain**: original, resume, resume-of-resume. Assert the third is refused when the cap is two. A cap that counts `resumed_from` passes a single-level test and fails this one, which is exactly why this test exists. (**Maaz Bin Asif**)
- [ ] Assert the markers land on **both** rows of a resumed run. (**Maaz Bin Asif**)
- [ ] Assert a refusal writes **no rows at all** and never touches the fake `AI` binding. A refusal that quietly bills is the worst outcome this ticket can produce. (**Maaz Bin Asif**)
- [ ] Assert a resume does not call the planner, by using a fake that throws if the text path is reached. (**Maaz Bin Asif**)

### Review gates

- [ ] Read the ADR and confirm it decides all four questions (per-stage policy, empty-response retries, gateway built-in retry, unfetchable motif) rather than deferring any of them. A deferred question in an ADR reads as an answered one six months later. (**Ali Amir**)
- [ ] Trigger a real resume end to end and confirm the second image differs from the first. If they are identical, `skipCache` from iris-09 is not in effect and resume is spending money to return a cached image. (**Ali Amir**)
- [ ] Hit the cap for real: resume the same brief until it refuses. Confirm the refusal message names the actual count and the actual limit. (**Ali Amir**)
- [ ] Confirm each refusal path costs nothing, by checking the gateway log has no new row after each one. (**Ali Amir**)
- [ ] Read `GET /runs` for a resumed brief and confirm you can reconstruct the whole history, which attempt came from which, from the markers alone. (**Ali Amir**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003 per successful resume.** Two or three successful resumes plus hitting the cap is roughly 1 to 2 cents. Every refusal path is free by design, so test all seven of those first and exhaustively, and only then spend on the success path.

1. Test all seven refusals with curl before making a single successful resume. Each returns 409 with its own message, and the gateway log stays unchanged.
2. A real successful resume returns 200 with a new `p_invoc_id` and a new, visibly different image.
3. `curl -s 'http://localhost:8787/runs?p_invoc_id=<resumed id>' | jq`. Both rows carry `root`, `resumed_from` and `attempt` in `model_metadata`.
4. Set `max_resume_attempts` to 1 with `npm run kv:put --workspace=apps/agent-iris`, hit the cap, confirm the message. **Put it back:** `npm run config:pull:iris`.
5. `npm test --workspace=apps/agent-iris` passes.

## Two things that will waste your afternoon

**A cap that counts `resumed_from` instead of `root` looks correct and is unbounded.** Each resume becomes the parent of the next, each count restarts at one, and a brief can be retried forever. It passes any single-level test. The chain test in the work list above is the only thing that catches it, so write that test before the code, not after.

**Putting the resume markers only on the text row makes retries invisible to every cost query.** The image row is the one with `cost_usd` and `image_r2_key` on it, so that is the row anything asking "what did this brief cost" reads. Markers on the text row alone means a brief resumed four times reports as four unrelated runs. This is why `runImageStage` takes `metadataExtras` at all, and Helios has a decision written specifically about it.
