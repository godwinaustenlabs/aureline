# 08 — Failure handling

**What to build:** Two halves.

**Phase 1, prove the failure behaviour.** A crash mid-pipeline leaves a record you can go and look at: the right rows marked `failed`, whatever succeeded before the crash kept, money already spent still recorded, and nothing quietly retrying the whole run.

**Phase 2, make one of those failures recoverable.** A `POST /resume` route that takes a run whose planner succeeded and whose image failed, and runs just the image half again from the params already on disk. It saves the planner call, about a third of a fresh request, and returns the same params the caller already saw.

**Blocked by:** nothing. 03 and 07 are both merged (`e1f6938`).

**Status:** phase 1 open. Phase 2's code and unit tests are done on `feature/08-failure-handling-MaazBinAsif`; what is left there is the real forced-failure and resume run, which needs Ali's review either way.

**Team:** Ali Amir (phase 1), Maaz Bin Asif (phase 2)

## Read this first

**Phase 1 is mostly verification, not new code.** This ticket was drafted before 03 and 07 landed, and those delivered most of its behaviour as a side effect. Do not read the unticked boxes as that much work.

- *Built and tested:* failed rows are excluded from pruning, both failure shapes covered in `do.repository.test.ts:108` and `:149`, and ticket 07 verified end to end that a failed run reaches D1 and survives a prune.
- *Built, never tested:* everything else in phase 1. `runPipeline`'s catch calls `failRunningRuns`. Partial state survives because the text row settles before the image row opens. `imageCost` sits outside the try so a billed image is still recorded when a later step breaks.
- *Missing entirely:* there is no `pipeline.test.ts`. Nothing covers the orchestrator, which is the file this ticket is about.

**Phase 2 is genuinely new:** a route and a new service file.

## The thing most people get wrong here

The obvious test is "the planner throws, so the run is failed". That passes on almost any implementation.

The one that catches real bugs is the image failure: the planner already succeeded, its params are saved, and only the image call throws. A naive cleanup marks the whole invocation failed and loses the params. The correct outcome is a `completed` text row holding real params next to a `failed` image row, and a result whose `params` is **not** null.

Two different tests. A suite covering only the first is green while the second is broken. Ticket 07 made the same point about pruning.

## Decisions for phase 1

1. **No pipeline-level retry.** A failed invocation is never re-run automatically, not off a Workflows binding, Queues binding or DO alarm. It is recorded and returned. Another go is another request, which is a new `p_invoc_id`.

2. **Retry policy is per stage, and this is the spine of the ticket.** The text stage retries automatically. The image stage never does. Its retry is manual, and that is what `POST /resume` is.

   The reason is the failure mode, not the stage. Structured output fails recoverably: the model returns prose or nearly-right JSON, and asking again usually works, at about $0.001. Flux has no equivalent. A failed image call failed for a reason a second identical request will hit too, and each attempt is the expensive call.

   **`max_retries` in KV governs the planner only.** `generateImage` calls `env.AI.run` exactly once and never reads `config.maxRetries`, despite it sitting on `HeliosConfig`. Adding a retry loop there is a decision to raise in the group, not a fix to slip in.

3. **The retry inside `getTextualModelOutput` stays, and it is not decision 1.** `config.maxRetries` (default 2) comes down via `planner.ts:35`. The loop is `for (attempt = 1; attempt <= maxRetries)`, so **2 means 2 total attempts, not 1 plus 2**. It catches both a schema mismatch and a thrown `ai.run`. Do not remove it and do not wrap a second layer around it.

4. **A failed run returns HTTP 200.** `HeliosResult` is a settled-outcome envelope and the client reads `status`. `agent.ts` returns non-200 only for transport errors (405 non-POST, 400 bad body), which never became invocations and have no `p_invoc_id`. Written down so nobody "fixes" it at review.

5. **Partial state is kept, never deleted.** Planner succeeded and image failed means the text row keeps `completed` and its params, and the result carries `params` non-null.

6. **Cost spent before the failure is recorded.** `imageCost` is held outside the try for this reason. The money left the account either way.

7. **Only this invocation's `running` rows are failed.** `failRunningRuns` filters on both `pInvocId` and `status`. One DO serves one session (ADR-0005), so a concurrent invocation's row must be left alone.

8. **Cleanup failing is not the failure worth reporting.** The catch wraps `failRunningRuns` in its own try, because when storage is what broke the cleanup write breaks too, and a throw inside a catch escapes the function. It logs and swallows; the original `cause` is what the caller sees.

9. **Failed rows go to D1 and are never pruned.** Ticket 07, decision 3. Not re-implemented here.

10. **The suites cost nothing.** Every test in `pipeline.test.ts` and `resume.test.ts` fakes the `AI` binding.

## Agreed shapes, do not invent your own

**The fake env.** Copy the pattern from `imageGenerator.test.ts:36`, do not write a second one. `pipeline.ts` needs more than that one, because it touches storage, R2 and D1 as well as `AI`:

```ts
function fakeEnv(overrides: {
	planner?: unknown | Error;   // what AI.run returns for the text model, or throws
	image?: unknown | Error;     // same, for the image model
} = {}) { ... }
```

Dispatch inside the single `run` mock on model name, since both stages share the binding. `@cf/openai/gpt-oss-120b` is the planner, `@cf/black-forest-labs/flux-1-schnell` the image model, both from `HeliosConfig`, so the test controls them.

**The database.** `createTestDb()` has been lifted out of `do.repository.test.ts` into `src/db/testDb.ts` and both suites import it from there. Do not stand up a third way of making a test database.

**Assert on rows, not just the returned result.** Read `helios_runs` back and check `status`, `plannerParams` and `costUsd`. The result and the stored rows are two different things and a bug can get one right and the other wrong.

## Phase 2: the resume route

### Which failures can be resumed

| Failure point | What survives | Resumable |
|---|---|---|
| Planner throws | nothing useful | No. A resume is just a fresh request. |
| Text row save throws | nothing, the answer was only in memory | No. Would need new persistence. |
| **Image call throws** | **text row `completed`, valid params on disk** | **Yes. This is the route.** |
| R2 save throws | nothing, the bytes were only in memory | No. Resuming means regenerating. |
| Image row update throws after R2 saved | the R2 object, at a deterministic key | Technically yes, not now. Decision 19. |
| D1 export throws | everything, all rows still in the DO | No route needed. Decision 20. |

### Decisions for phase 2

11. **One resume point only: the image half.** This route *is* the image stage's retry, per decision 2, manual because each call spends the expensive model. It never re-runs the planner. If the planner is what failed, that is a fresh `POST /generate`, and the route says so with a 409.

12. **Resume takes `p_invoc_id` required and `session_id` optional**, exactly as `/generate` does. `scopeKey` in `index.ts` picks the DO by session id (ADR-0005), so the pair is what finds the run, but `session_id` is optional on `HeliosRequestSchema` and `scopeKey` already falls back to a DO named `default`. Requiring it on resume would make every run generated without one unreachable. One routing rule, not two.

13. **A resume mints a new `p_invoc_id`, never reusing the old one.** Reusing overwrites the failure record phase 1 exists to preserve. And it does not work anyway: the failed rows are already in D1 via the catch's `exportAndPrune`, and `exportRuns` uses `onConflictDoNothing`, so whichever version landed first is what D1 keeps forever.

14. **A resumed run writes both rows, not just the image row.** ADR-0001 and `schema.ts` state the invariant: one invocation, two rows, one text and one image. A resume opening only an image row breaks it and anything reading D1 gets half a run.

    So it writes a text row too: `status: completed`, the copied params, **`cost_usd: null`** because nothing was re-planned and a phantom planner cost would corrupt every cost report we build later, plus the metadata from decision 15.

    This also makes a resume resumable in turn, which matters because the retry is manual and people try more than once. Without the text row, attempt two fails the decision 18 guard and the operator has to know to reach back to the original id.

15. **The runs link through `modelMetadata`, and the marker goes on both rows.** Text row `{ model, resumed_from, attempt, planner_skipped: true }`, image row `{ model, steps, resumed_from, attempt }`.

    **Both rows.** The image row carries `cost_usd` and `image_r2_key`, so it is what every cost report reads. Mark only the text row and a query grouped on image rows cannot tell a retry from an original, which is the whole question the field answers.

    **`attempt` is an integer and not optional**, otherwise "was this a retry" means walking the chain backwards. Original: neither field. First retry: `attempt: 2`, `resumed_from` = the original. Second: `attempt: 3`, `resumed_from` = the **immediate parent**, not the root.

    **How it reaches the image row.** `runImageStage` builds that row's metadata itself from `imageModelMetadata(config)`, so resume had no way in. It now takes a `metadataExtras` parameter defaulted to `{}`. `runPipeline` passes nothing and writes byte for byte what it wrote before.

16. **It stays in `model_metadata` rather than becoming a column.** It is queryable, and we already depend on this column exactly this way: the planner neuron figures behind our cost estimates came out of it.

    ```sql
    select p_invoc_id,
           json_extract(model_metadata, '$.attempt')      as attempt,
           json_extract(model_metadata, '$.resumed_from') as resumed_from,
           status, cost_usd
    from helios_runs where modality = 'image' order by created_at;
    ```

    Counting, so nobody invents their own: **attempts billed** = every image row. **Patterns delivered** = those `completed`. **Distinct briefs** = those with `resumed_from` null. A chain of three is one brief, three charges, one pattern.

    **Upgrade path** if this ever gets queried hot: real `resumed_from TEXT` and `attempt INTEGER` columns, indexable and visible in `SELECT *`. It costs a migration on both schemas and there are no consumers yet, which is the only reason we are not doing it now. Raise it in the group, do not add it quietly.

17. **Params are re-parsed coming out of the database.** They return as `unknown`. Run `HeliosParamsSchema.parse`. A row from an older schema version must fail loudly, not make a nonsense image.

18. **Resume is guarded and refuses rather than guessing.** Proceed only when the run has a `completed` text row and an image row that is `failed` or absent. Everything else is a 409 with its own reason. A second image on a run that has one is a second charge and a second R2 object, so this guard is about money.

    **A `running` image row refuses too.** The guard as first written was "no `completed` image row", which a row still in flight passes, and resuming a concurrent invocation bills twice. Four refusals: run not found, planner never succeeded, image already completed, image still running. Stored params that no longer parse (17) refuse the same way, since nothing has been written or billed at that point either.

19. **R2-saved-but-row-update-failed is out of scope.** Note for whoever picks it up: the key is deterministic, `patterns/{p_invoc_id}.jpg`, so a future recovery can probe R2 and patch the row without regenerating. Narrow window, and it adds a branch to an otherwise simple path.

20. **A failed D1 export needs no resume.** `exportAndPrune` exports every settled row in the DO, so the next request through it sweeps up earlier failures. Ticket 07, decision 12.

### Agreed shapes for phase 2

**`services/pipeline.ts` already has the extraction** (`8dc5dbf`). `runImageStage` holds the image row opening, the model call, the R2 save and the row update. It never throws and builds no `HeliosResult`: both callers track their own `stage` and `params`, so result shaping stays whole in one place per caller.

```ts
type ImageStageOutcome =
	| { ok: true;  imageR2Key: string; costUsd: number | null }
	| { ok: false; cause: unknown;     costUsd: number | null };
```

**The cost is on both branches deliberately.** The model bills before the R2 save and the row update, so an outcome reporting cost only on success would record a spent image as free. `runPipeline` assigns it before rethrowing, which keeps its existing catch and its cost reporting exactly as they were.

**Everything else for phase 2 is a new file, `services/resume.ts`:**

```ts
export type ResumeOutcome =
	| { ok: false; reason: string }        // 409, nothing written, nothing billed
	| { ok: true;  result: HeliosResult };  // 200, settled either way

export async function resumeRun(
	db: HeliosDb, p_invoc_id: string, env: Env, origin: string,
): Promise<ResumeOutcome>
```

**Not a bare `HeliosResult`,** which has no room for a status code while decision 18 wants a 409 per reason. The split is: everything before the first write is a refusal, everything after it is a settled `HeliosResult`, so nothing that fails a precondition ever writes a junk run. Same union pattern as `ImageStageOutcome`, and no exceptions used for control flow.

It reads the run with `getRunRows`, applies the decision 18 guard, re-parses params (17), mints a new id (13), writes the carried-over text row (14 and 15), then hands off to `runImageStage`. **The text row is written from `resume.ts`, not inside `runImageStage`** — `runPipeline` opens its own before the planner runs and must not get a second one. It goes in through one new repository function, `insertResumedTextRun`, inserted already `completed` rather than opened and then settled, since there is no `running` phase without a planner call.

**The route.** `POST /resume`, body `{ p_invoc_id, session_id? }`, validated by a new `HeliosResumeRequestSchema` in `@aureline/shared-types`. `index.ts` routes it through the same `scopeKey` branch as `/generate`. `agent.ts` maps `ok: false` to 409 and `ok: true` to 200, so the only shape leaving the Worker is still a `HeliosResult`.

## Who does what

**Can you work independently? Yes.** The one thing that coupled you is done and committed. `pipeline.ts` was the only shared file, because phase 2 could not call the image half until it was a function.

| | Ali Amir | Maaz Bin Asif |
|---|---|---|
| New files | `services/pipeline.test.ts` | `services/resume.ts`, `services/resume.test.ts`, `db/testDb.ts` |
| Edited files | none | `shared-types` schema, `index.ts`, `agent.ts`, `do.repository.ts`, `pipeline.ts` |

**Two edits Ali will notice, both landed and both additive.** `runImageStage` has a seventh parameter, `metadataExtras`, defaulted to `{}`, so `runPipeline`'s call site and the metadata it writes are unchanged. `createTestDb` moved to `src/db/testDb.ts` and `do.repository.test.ts` now imports it, so `pipeline.test.ts` imports it from the same place.

Four things that are not blockers:

**Ali, if a test turns up a real bug in `pipeline.ts`**, that is the one case you land back in Maaz's file. Say so before you fix it, not after.

**The extraction is not fully proven, and Ali's suite is what proves it.** The real run that checked it was a success case, so it covered the model call, R2, the export and the cost, and never exercised a failure. The behaviour most at risk from restructuring is cost surviving a failure after the image billed. **Write that box early.** Until then it holds by inspection only.

**You review each other's phase.** Ali reviews the extraction and phase 2, Maaz reviews phase 1. Nobody ticks a gate on their own work. Tickets 03 and 07 both had gates ticked by their own implementer and both got unticked at review.

**The error-message judgement calls are settled**, so nothing blocks Ali's assertions. One of them changed a message: a thrown model call now reads `model call failed after N attempt(s): ...` instead of `schema validation failed ...`. See the judgement-call boxes.

## Work

### Already done, the shared piece

- [x] Extract `runImageStage` from `runPipeline`, returning `ImageStageOutcome`. `runPipeline`'s signature untouched, its own commit so nothing else is coupled — **Maaz Bin Asif**, reviewed by **Ali Amir**. Done in `8dc5dbf`: `tsc` clean, 34 + 33 tests green, one real run (`a159d657`) completed at `cost_usd` 0.0019008 with both rows in D1 and the image served back.

  **One behaviour change went with it.** `startImageRun` used to run while `stage` was still `"validate"`, so a failure opening the image row was reported as `validate: ...`. It now sits inside `runImageStage`, after `stage = "image"`, so it reports as `image: ...`. The new label is the correct one and nothing depended on the old string, but it is observable in the stored `error` and was not in the plan. **Ali, this is the thing to look at when reviewing.** Pulling `startImageRun` back into `runPipeline` restores the old label at the cost of one duplicated line in `resume.ts`.

### Phase 1, failure behaviour

- [ ] `src/services/pipeline.test.ts` exists, using the fake `AI` binding and `createTestDb`. No live model call in it — **Ali Amir** (owns the file)
- [ ] **Image billed, then a later step throws** (R2 save or row update): `cost_usd` non-null on both the failed result and the row. Decision 6, real money, and the one behaviour the extraction could have broken. **Write this first** — **Ali Amir**
- [ ] Planner throws: one row, `modality: text`, `status: failed`, `completedAt` set, no image row ever opened. Result is `failed`, `params: null`, `image_url: null`, `error` starting `planner:` — **Ali Amir**
- [ ] Planner returns a shape failing `HeliosParamsSchema`: fails at the **validate** stage, `error` starts `validate:`. **Note:** `tools.ts` already passes `HeliosParamsSchema` into `getTextualModelOutput`, which validates and retries there, so `pipeline.ts`'s re-parse cannot fail through the real path. It is deliberate layering, `planConcept` returns `unknown` so the pipeline trusts nothing. Fake the planner return directly and do not hunt for a production path, there is not one — **Ali Amir**
- [ ] **Image throws, the one that matters.** Text row stays `completed` with real params, image row `failed`, returned `params` not null. Decision 5 and the trap at the top — **Ali Amir**
- [ ] DO storage unavailable: `runPipeline` still returns a settled `failed` result rather than throwing. Decision 8. Make the cleanup write fail too and confirm nothing escapes — **Ali Amir**
- [ ] A second invocation's `running` row in the same DO is untouched when this one fails. Decision 7 — **Ali Amir**
- [ ] **The retry boundary, both sides.** Planner: throw from `AI.run` with `maxRetries: 2` and assert exactly two calls, then 3 and assert three, proving the KV value reaches the call rather than a hardcoded number. Image: fail it and assert `AI.run` was called **exactly once**. Decision 2, and that second assertion is what stops someone adding a retry loop to the expensive call by accident — **Ali Amir**

### Phase 2, the resume route

Code and unit tests are done, unticked boxes are the ones needing a real run.

- [x] `HeliosResumeRequestSchema` in `@aureline/shared-types`. `p_invoc_id` required, `session_id` optional. Decision 12 — **Maaz Bin Asif**
- [x] `services/resume.ts` with `resumeRun` returning `ResumeOutcome` per the shape above — **Maaz Bin Asif**
- [x] `insertResumedTextRun` in `do.repository.ts`, one insert of an already-settled row — **Maaz Bin Asif**
- [x] The decision 18 guard with a distinct 409 reason per case: run not found, planner never succeeded, image already completed, image still running, stored params no longer valid. **Not one generic error.** They mean different things, and the third is what stands between us and a double charge — **Maaz Bin Asif**
- [x] `POST /resume` routed in `index.ts` through the same `scopeKey` branch as `/generate`, validated in `agent.ts` the same way, `ok: false` mapped to 409 — **Maaz Bin Asif**
- [x] No migration generated. `model_metadata` is a JSON column, decision 16 — **Maaz Bin Asif**
- [x] `services/resume.test.ts`, fake bindings, 12 cases. Suite is 46 agent-helios plus 34 shared-utils, `tsc` clean — **Maaz Bin Asif**
- [x] The planner is never called on a resume. Asserts the `AI.run` mock saw only the image model. That is the entire point of the route and it is one assertion — **Maaz Bin Asif**
- [x] A resumed run has **two** rows, its text row `completed` with `cost_usd` null and `planner_skipped: true`. Decision 14 — **Maaz Bin Asif**
- [x] `resumed_from` and `attempt` on **both** rows of a resumed run and **neither** row of an original. Decision 15. A test checking only the text row leaves the real gap open — **Maaz Bin Asif**
- [x] A failed resume can itself be resumed. Chains two, `attempt` goes 2 then 3, each `resumed_from` points at its immediate parent not the root, all three runs stay inspectable — **Maaz Bin Asif**
- [x] Cost survives a failure on the resume path too: the image billed, the R2 save threw, and `cost_usd` is non-null on both the result and the row — **Maaz Bin Asif**
- [x] Run decision 16's `json_extract` query against local D1 and confirm it separates attempts from originals — **Maaz Bin Asif**

**Real run, done, roughly $0.003.** Broke `image_model` in local KV, one `POST /generate` on session `ticket08-resume-check`:

- `16755eba` came back `failed`, `error: "image: 5007: No such model @cf/does/not-exist or task"`, **params non-null**, `cost_usd` null. Decision 5's exact shape.
- Restored `image_model`, `POST /resume` on it: new id `9f0da2cd`, `completed`, params identical, image served back at HTTP 200 `image/jpeg`, 854,938 bytes, `cost_usd` 0.0019008.
- Read back through `readRun`, not a hand-typed query. Original: text `completed` holding the params, image `failed` recording `@cf/does/not-exist`, no marker on either row. Resumed: text `completed` with `cost_usd` null, `planner_skipped: true` and the marker; image `completed` with the real cost, the R2 key and the marker. Two rows each.
- Decision 16's query across every image row in local D1: nine originals with `attempt` and `resumed_from` null, one row with `attempt: 2` pointing at `16755eba`. It separates them cleanly.
- Refusals against the live route: same resume again **409**, "already has an image, and resuming would generate and charge for a second one", no second image billed. Unknown id 409. Right id under a different `session_id` 409, which is decision 12's routing working. Missing `p_invoc_id` 400.

**Found while reading D1, not fixed here, not phase 2's to fix.** The text row's `cost_usd` column holds **neurons, not dollars**: `16755eba`'s text row reads `88.80419921875`. `runPipeline` passes `extractNeuronCost(...)` straight into `completeTextRun`'s `costUsd` parameter (`pipeline.ts:170`). Any report that sums `cost_usd` across modalities is off by four orders of magnitude on every text row. Decision 16's counting only reads image rows so it is unaffected, which is why this survived. Raise it in the group.

### Judgement calls, both Maaz, both settled

- [x] **The planner error message misattributed transport failures.** `getTextualModelOutput` threw `schema validation failed after N attempt(s)` from a catch that also swallowed a thrown `ai.run`, so a bad model name or a network error was recorded as a schema problem, and `JSON.stringify` renders an `Error` as `{}`, so it carried no detail at all. **Fixed rather than documented**, because an inspectable record is the point of this ticket, and because the forced-failure step below produces exactly this case. The loop now tracks which kind of failure the last attempt was and throws `model call failed after N attempt(s): <message>` for a thrown call. Covered by a new test in `getTextualModelOutput.test.ts`. **Ali, this changes what a planner-failure row says**, so assert on `/model call failed/` for a thrown call and `/schema validation failed/` for drift — **Maaz Bin Asif**
- [x] **How much of the message reaches the row. Accepted as is, no cap.** The verbose branch is now only schema drift, which is the one case where you need to see what the model actually returned, and it is already bounded: the Zod issues plus a 200 character response excerpt. The transport branch, which is the common one and was the unbounded-looking one, is now a single line. `planner_params` on the same row is a larger blob than any of this — **Maaz Bin Asif**

### Review gates

- [ ] `npx tsc --noEmit` clean and the full suite green from the repo root — **Ali Amir**
- [x] One real forced failure end to end, failed rows reaching D1 with the right statuses, read back with `readRun` not a hand-typed query. Same gate as ticket 07 — **Maaz Bin Asif** (reviews phase 1). Done on `16755eba`, evidence above. This demonstrates the behaviour; it does not review Ali's suite, which is still to come.
- [ ] One real resume end to end per the steps below, including the second-attempt 409 — **Ali Amir** (reviews phase 2). The run has been done and the evidence is recorded above; this box is Ali confirming it, not repeating it. **Do not re-run the resume to check** — `16755eba`'s image row is still `failed`, so resuming it again is allowed by design and would bill another image.
- [ ] No box ticked on a green unit test alone where a real run was asked for, and nobody ticks a gate on their own phase. Tickets 03 and 07 both had gates ticked without being demonstrated — **both**

## Verification without burning budget

Every `POST /generate` is a real planner call plus a real image call. **Measured, not estimated:** the planner is about 89 neurons, roughly $0.001, and the image is $0.0019008 from the gateway log, so a full generate is about $0.0029 and a resume is about $0.0019. **Do not generate failures by generating runs. Point config at something that cannot work.**

**Planner failure, free:**

```
npx wrangler kv key put --binding CONFIG --local text_model "@cf/does/not-exist"
```

A bare string is fine, `prepareModelValue` wraps anything not starting with `{` into `{ model: ... }`. **Use the bare string, not JSON.** Malformed JSON returns null and silently falls back to the `PLANNER_MODEL` var, so a typo gives you a successful billed run instead of the failure you wanted.

`ai.run` rejects an unknown model, so it fails before anything bills. Decision 3 means two attempts, so expect two in the log. If it returns a result object instead of throwing, record that here, it changes what the pipeline sees.

**Image failure, one planner call, about $0.001.** Leave `text_model` correct and break `image_model` the same way. The planner runs and bills, the image call fails before Flux, and you get decision 5's exact shape: a `completed` text row with real params next to a `failed` image row.

**Then check D1 through code.** `readRun` on the failed `p_invoc_id`. `wrangler d1 execute --local` is fine for a glance but the box is ticked on the read path.

**Phase 2 reuses that failure**, which is exactly the state resume exists for:

1. Put `image_model` back to Flux, leave `text_model` correct.
2. `POST /resume` with that `session_id` and `p_invoc_id`.
3. Costs **one image call and no planner call**, about $0.0019. Confirm in the log the planner never ran.
4. Confirm the original failed rows are untouched and the new run carries `resumed_from` and `attempt: 2` on **both** rows.
5. Send the same resume again and confirm 409 rather than a second image. If it generates, you have found the bug decision 18 exists to prevent, and it is a billing bug.

**Put config back:** `npm run config:pull`. Local KV starts empty and falls back to the committed vars, so a half-restored state looks fine right up until it does not.

**Budget: 1 planner call for phase 1 plus 1 image call for phase 2**, about $0.003, and only if you reuse phase 1's failure as phase 2's input. That is what phase 2 actually spent.

## Two things that will waste your afternoon

**The dev server holds the local D1 file.** Ticket 07 lost time to this. Stop `wrangler dev` before running migrations against `--local`, then restart.

**A green suite is not the ticket.** Both suites fake the `AI` binding and the database, so they prove the orchestrator's logic and nothing about how Workers AI actually fails. That is what the forced-failure and resume runs are for, and why the last four boxes are gates rather than work items.
