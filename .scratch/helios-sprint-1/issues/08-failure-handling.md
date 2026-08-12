# 08 — Failure handling

**What to build:** Two halves.

**Phase 1, prove the failure behaviour.** When something blows up mid-pipeline, the run leaves behind a record you can go and look at. The right rows are marked `failed`, whatever succeeded before the crash is kept rather than thrown away, money already spent is still recorded, and nothing quietly retries the whole run behind your back.

**Phase 2, make one of those failures recoverable.** A `POST /resume` route that takes a run whose planner succeeded and whose image failed, and runs just the image half again using the params already on disk. Half the cost of a fresh request, and the same params the caller already saw.

**Blocked by:** nothing. 03 and 07 are both merged (`e1f6938`).

**Status:** ready to assign. The shared extraction is already done and verified, so both phases can start in parallel with no coupling left between them.

**Team:** Ali Amir (phase 1), Maaz Bin Asif (phase 2)

## Read this first

**Phase 1 is mostly verification, not new code.** This ticket was drafted before 03 and 07 landed, and those two delivered most of its behaviour as a side effect. Do not read the unticked boxes as that much work.

*Already built and already tested:* failed rows are excluded from pruning. `pruneCompletedRuns` never touches them, and both failure shapes are covered in `do.repository.test.ts` (planner-failure shape at line 108, image-failure shape at line 149). Ticket 07 also verified end to end that a failed run reaches D1 and survives a prune.

*Already built, never tested:* everything else in phase 1. `runPipeline`'s catch calls `failRunningRuns`, which flips this invocation's `running` rows to `failed`. Partial state survives because the text row settles to `completed` before the image row opens. `imageCost` is held outside the try so a billed image is still recorded when a later step breaks.

*Missing entirely:* there is no `pipeline.test.ts`. The three suites in the app cover config, the DO repository and the image generator. Nothing covers the orchestrator, which is the file this whole ticket is about.

**Phase 2 is genuinely new.** A route, a small extraction, and a new service file.

## The thing most people get wrong here

The obvious failure test is "the planner throws, so the run is failed". That one passes on almost any implementation.

The one that catches real bugs is the image failure: the planner already succeeded, its params are already saved, and only the image call throws. A naive cleanup marks the whole invocation failed and loses the params. The correct outcome is a `completed` text row holding real params next to a `failed` image row, and a result whose `params` field is **not** null.

These are two different tests. A suite that only covers the first is green while the second is broken. Ticket 07 made the same point about pruning and it was right there too.

## Decisions for phase 1

1. **No pipeline-level retry.** A failed invocation is never re-run automatically, not off a Workflows binding, not off a Queues binding, not off a DO alarm. It is recorded and returned. If a caller wants another go they send another request, which is a new `p_invoc_id`.

2. **Retry policy is per stage, and this is the spine of the whole ticket.** The text stage retries automatically. The image stage never does. Its retry is manual, and that is what `POST /resume` in phase 2 is.

   The reason is the failure mode, not the stage. Structured output fails in a recoverable way: the model returns prose or nearly-right JSON, and asking again usually works. It costs about $0.001, so a bounded automatic retry pays for itself. Flux has no equivalent. A failed image call failed for a reason a second identical request will hit too, and each attempt is the expensive call. So a person decides, per failure, whether to spend again.

   **`max_retries` in KV governs the planner only.** `generateImage` calls `env.AI.run` exactly once and never reads `config.maxRetries`, even though it sits on `HeliosConfig`. That is deliberate as of this ticket. Adding a retry loop to the image stage is a decision to raise in the group, not a fix to slip in.

3. **The retry inside `getTextualModelOutput` stays, and it is not the same thing as decision 1.** `config.maxRetries` (default 2) is passed down by `planner.ts:35`. The loop is `for (attempt = 1; attempt <= maxRetries)`, so **2 means 2 total attempts, not 1 plus 2**. It catches both a schema mismatch and a thrown `ai.run`, and retries either. It exists because structured output from a model is unreliable. Do not remove it and do not wrap a second retry layer around it. Decision 1 is about the pipeline. This is about one call inside one stage.

4. **A failed run returns HTTP 200.** `HeliosResult` is a settled-outcome envelope and the client reads `status`. `agent.ts` returns non-200 only for transport errors: 405 for a non-POST, 400 for a body that fails `HeliosRequestSchema`. Those never became a pipeline invocation and have no `p_invoc_id`, which is why they are shaped differently. Leave it as is. It is written down so nobody "fixes" it at review.

5. **Partial state is kept, never deleted.** If the planner succeeded and the image failed, the text row keeps `status: completed` and its params, and the failed result carries `params` non-null. A failure makes the record more interesting, not less.

6. **Cost spent before the failure is recorded.** `imageCost` is held outside the try in `runPipeline` for exactly this reason. The money left the account whether or not the run finished, so it is stored on the row and returned in `cost_usd`.

7. **Only this invocation's `running` rows are failed.** `failRunningRuns` filters on both `pInvocId` and `status = running`. One DO serves one session (ADR-0005), so a concurrent invocation may have a row mid-flight and must be left alone.

8. **Cleanup failing is not the failure worth reporting.** The catch wraps `failRunningRuns` in its own try, because when DO storage is what broke, the cleanup write breaks too, and a throw from inside a catch escapes the function. It logs and swallows. The original `cause` is what the caller sees.

9. **Failed rows go to D1 and are never pruned.** Delivered by ticket 07, decision 3 there. This ticket does not re-implement it.

10. **The suites cost nothing.** Every test in `pipeline.test.ts` and `resume.test.ts` fakes the `AI` binding. No live model calls anywhere in either.

## Agreed shapes, do not invent your own

**The fake env.** Copy the pattern from `services/imageGenerator.test.ts:36`, do not write a second one. It builds a `vi.fn()` for `run`, a `gateway` returning `{ getLog }`, and casts the whole thing `as unknown as Env`.

`pipeline.ts` needs more than that one does, because it touches storage, R2 and D1 as well as `AI`:

```ts
function fakeEnv(overrides: {
	planner?: unknown | Error;   // what AI.run returns for the text model, or throws
	image?: unknown | Error;     // same, for the image model
} = {}) { ... }
```

Dispatch inside the single `run` mock on the model name, since both stages call `env.AI.run` through the same binding. `@cf/openai/gpt-oss-120b` is the planner, `@cf/black-forest-labs/flux-1-schnell` is the image model, and both come from `HeliosConfig`, so the test controls them.

**The database.** Reuse `createTestDb()` from `repository/do.repository.test.ts`. It is a real in-memory SQLite behind the same Drizzle schema via `node:sqlite` and `sqlite-proxy`. Export it from a small shared helper, or import it directly, but do not stand up a third way of making a test database.

**Assert on rows, not just on the returned result.** Every test reads `helios_runs` back afterwards and checks `status`, `plannerParams` and `costUsd`. The returned `HeliosResult` and the stored rows are two different things, and a bug can easily get one right and the other wrong.

## Phase 2: the resume route

### Which failures can actually be resumed

Walked every step against what is on disk at that moment. Only one is worth a route.

| Failure point | What survives | Resumable |
|---|---|---|
| Planner throws | nothing useful | No. A resume is just a fresh request. |
| DO save of the text row throws | nothing, the model answer was only in memory | No. Would need new persistence. |
| **Image call throws** | **text row `completed`, valid params in `plannerParams`** | **Yes. This is the route.** |
| R2 save throws | nothing, the image bytes were only in memory | No. Resuming means regenerating, which is the expensive call. |
| Image row update throws after R2 saved | the R2 object, at a deterministic key | Technically yes, not now. See decision 19. |
| D1 export throws | everything, the rows are all still in the DO | No route needed, it self-heals. See decision 20. |

### Decisions for phase 2

11. **One resume point only: the image half.** This route *is* the image stage's retry, per decision 2. It is manual on purpose: each call spends the expensive model, so a person authorises each attempt. It re-runs the image stage using params already stored and never re-runs the planner. If the planner is what failed, that is a fresh `POST /generate`, and the route says so with a 409 rather than quietly doing it.

12. **Resume takes `session_id` and `p_invoc_id`, both required.** `scopeKey` in `index.ts` picks the Durable Object by session id (ADR-0005). A `p_invoc_id` on its own cannot find the DO holding that run. The route needs both to route at all.

13. **A resume mints a new `p_invoc_id`. It never reuses the old one.** Two reasons, and the second is fatal to the alternative. Reusing overwrites the failure record, which is what phase 1 exists to preserve. And it does not work anyway: the failed rows are already in D1, because `exportAndPrune` runs in the catch, and `exportRuns` uses `onConflictDoNothing` on the row id, so whichever version landed first is what D1 keeps forever. A resumed row under the same id would be silently thrown away at export.

14. **A resumed run writes both rows, not just the image row.** `schema.ts` and ADR-0001 state the invariant: one invocation, two rows sharing a `p_invoc_id`, one text and one image. A resume that opens only an image row breaks it, and anything reading D1 expecting a text sibling gets half a run.

    So the resume writes a text row too: `status: completed`, the copied params, **`cost_usd: null`** because nothing was re-planned and a phantom planner cost would corrupt every cost report we build later, and the metadata from decision 15.

    This also makes a resume resumable in turn, which matters because the retry is manual and a person will try more than once. Without the text row, attempt two fails the decision 18 guard and the operator has to know to reach back to the original id. With it, you always resume the run you just watched fail.

15. **The runs are linked through `modelMetadata`, and the marker goes on both rows.**

    Text row: `{ model, resumed_from, attempt, planner_skipped: true }`. Image row: `{ model, steps, resumed_from, attempt }`, on top of what `imageModelMetadata` already builds.

    **Both rows, not just the text row.** The image row carries `cost_usd` and `image_r2_key`, so it is the row every cost report will actually read. Mark only the text row and a query grouped on image rows cannot tell a retry from an original, which is the whole question this field exists to answer.

    **`attempt` is an integer and it is not optional.** `resumed_from` alone means answering "was this a retry" requires walking the chain backwards. With `attempt` it is one field:

    - Original run: no `resumed_from`, no `attempt`.
    - First manual retry: `attempt: 2`, `resumed_from` = the original.
    - Second: `attempt: 3`, `resumed_from` = the first retry, so the **immediate parent**, not the root.

    Chain walking is then only needed for full lineage, which is rare.

16. **This stays in `model_metadata` rather than becoming a column, and that is a choice with an upgrade path.**

    It is queryable. `json_extract` works in D1, and we already depend on this column exactly this way: the planner neuron figures behind our cost estimates were pulled from it.

    ```sql
    select p_invoc_id,
           json_extract(model_metadata, '$.attempt')      as attempt,
           json_extract(model_metadata, '$.resumed_from') as resumed_from,
           status, cost_usd
    from helios_runs
    where modality = 'image'
    order by created_at;
    ```

    Counting definitions, so nobody invents their own later:

    - **Image attempts billed:** every `modality='image'` row.
    - **Patterns delivered:** those with `status='completed'`.
    - **Distinct briefs:** rows where `resumed_from` is null. A chain of three attempts is one brief, three charges, one pattern.

    **The upgrade path, if this ever gets queried hot:** real `resumed_from TEXT` and `attempt INTEGER` columns. Indexable, visible in `SELECT *`, no JSON functions. It costs a migration on both the DO and the D1 schema, and there are no consumers of this data yet, which is the only reason we are not doing it now. Raise it in the group when something starts reading this often, do not add it quietly.

17. **Params are re-parsed on the way out of the database.** They come back from a JSON column as `unknown`. Run `HeliosParamsSchema.parse` on them before use. A row written by an older schema version must fail loudly here, not produce a nonsense image.

18. **Resume is guarded, and refuses rather than guessing.** Only proceed when the run has a `completed` text row and no `completed` image row. Everything else is a 409 with a reason: unknown run, planner never succeeded, already has an image. A second image on a run that already has one is a second charge and a second R2 object, so this guard is about money, not tidiness.

19. **The R2-saved-but-row-update-failed case is out of scope, and this is the note for whoever picks it up.** The key is deterministic, `patterns/{p_invoc_id}.jpg`, so a future recovery can probe R2 and patch the row without regenerating anything. Narrow window, rare in practice, and it adds a "does the object exist" branch to a path that is otherwise simple. Not now.

20. **A failed D1 export needs no resume.** `exportAndPrune` exports every settled row in the DO, not just the current invocation, so the next request through that DO sweeps up anything that failed to export earlier. That was ticket 07's decision 12. Do not build a route for this.

### Agreed shapes for phase 2

**`services/pipeline.ts` gains one extraction and keeps its public signature.** Pull the image half into a function the resume path can call on its own:

```ts
/** Carries the cost on both branches. The image call bills before the R2 save
 *  and the row update run, so a caller must learn what was spent even when the
 *  stage failed, or decision 6 breaks. */
type ImageStageOutcome =
	| { ok: true;  imageR2Key: string; costUsd: number | null }
	| { ok: false; cause: unknown;     costUsd: number | null };

/** Everything from the image row opening to the image row settling. Shared by
 *  `runPipeline` and the resume route, which is the only reason it is separate.
 *  Builds no `HeliosResult` — that stays with the callers. */
async function runImageStage(
	db: HeliosDb, env: Env, config: HeliosConfig,
	p_invoc_id: string, concept: string, params: HeliosParams,
): Promise<ImageStageOutcome>
```

**It returns an outcome, not a `HeliosResult`, and that is deliberate.** `runPipeline` builds its result in exactly two places, the success return and the catch, and both read `params`, `imageCost` and `stage` that it tracked the whole way through. Returning a finished result from the image stage would mean two functions that both know how to build one. Result-building stays with the caller.

**The cost is on both branches for a reason.** `imageCost` sits outside the try in `runPipeline` today because the image call bills before the R2 save and the row update, so a failure in either must not record a spent image as free. If the stage simply threw, that number would be lost.

`runPipeline` then keeps its existing try and catch untouched:

```ts
stage = "image";
const outcome = await runImageStage(db, env, config, p_invoc_id, req.concept, params);

imageCost = outcome.costUsd;          // recorded before anything can throw
if (!outcome.ok) throw outcome.cause; // falls into the catch that already exists
```

`resumeRun` calls the same function and builds its own result from the same outcome.

**Note for the reviewer: this is not a pure move.** The lines relocate, but `runPipeline` gains three lines it did not have, and an image failure now reaches the catch by an explicit `throw` rather than by propagating. Observable behaviour is identical, the structure shifts slightly. Review it as a small restructure, not as a rename.

**`runPipeline`'s own signature and observable behaviour do not change.** That is a hard constraint, not a preference: phase 1's tests are written against it and they are the safety net for this refactor. If the extraction changes what `runPipeline` does, the refactor is wrong.

**Everything else for phase 2 lives in a new file, `services/resume.ts`**, so the shared surface between you stays at one function extraction.

```ts
export async function resumeRun(
	db: HeliosDb, p_invoc_id: string, env: Env, origin: string,
): Promise<HeliosResult>
```

It reads the run with `getRunRows`, applies the decision 18 guard, re-parses the params per decision 17, mints a new id per decision 13, writes the carried-over text row per decisions 14 and 15, then hands off to `runImageStage`.

The text row is written from `resume.ts`, not from inside `runImageStage`. `runPipeline` opens its own text row before the planner runs and must not get a second one. Keeping the extraction to the image half only is what stops the two paths interfering.

**The route.** `POST /resume`, body `{ session_id, p_invoc_id }`, validated by a new `HeliosResumeRequestSchema` in `@aureline/shared-types` next to the existing `HeliosRequestSchema`. Routing mirrors `/generate` in `index.ts`, including the `scopeKey` lookup. It returns a `HeliosResult`, the same envelope as `/generate`, so nothing downstream learns a second shape.

## Who does what

Ali Amir takes phase 1, the test suite. Maaz Bin Asif takes phase 2, the resume route, plus the two judgement calls.

**Straight answer on whether you can work independently: mostly, but not completely, and it is one file.**

Ali's work is a new file, `src/services/pipeline.test.ts`. Maaz's is mostly new files: `services/resume.ts`, `services/resume.test.ts`, a schema in `shared-types`, routing in `index.ts` and `agent.ts`. None of those touch each other.

**The one overlap is `services/pipeline.ts`.** Maaz needs the `runImageStage` extraction there. Ali needs the file stable while he writes tests against it, and will need to edit it if a test turns up a real bug.

**So do the extraction first, on its own, before either of you starts properly.** Pure move of existing lines, no behaviour change, maybe twenty minutes. Commit and push it, then you are clear of each other for the rest of the ticket. Same move as ticket 07's "do `getD1Db` first, everything imports it".

Three more things:

**Ali's tests are not a gate on Maaz, but they are the safety net.** Phase 2 refactors the file phase 1 tests. You do not have to wait for green, but if the suite is red when the refactor lands, nobody can tell whether the refactor broke it. Land the extraction before the tests exist, or after they are green. Not in the middle.

**You review each other's phase.** Ali reviews the extraction and phase 2. Maaz reviews phase 1. Nobody ticks a review gate on their own work. Tickets 03 and 07 both had gates ticked by the person who wrote the code and both got unticked at review, which is the entire reason this sentence is here.

**Ali, do the planner-throws case first.** It is the smallest end of the fake env and it forces the `AI.run` dispatch and the `createTestDb` wiring. Everything after is a variation on that setup.

**Maaz, settle the error-message judgement call early**, because it changes what strings Ali's tests assert on. It is the only place one of you can block the other.

## Work

### Do this first, together

- [x] Extract `runImageStage` out of `runPipeline` in `services/pipeline.ts`, returning `ImageStageOutcome` per the shape above. `runPipeline`'s signature untouched. Commit and push on its own before either phase starts — **Maaz Bin Asif**, reviewed by **Ali Amir**. Done. `tsc` clean, 34 + 33 tests green, and one real run end to end (`a159d657`): completed, `cost_usd` 0.0019008, both rows in D1, image served back as 1,032,769 bytes of jpeg. **One behaviour change went with it, see below.**

**The one behaviour change in that commit, and it needs a reviewer's eye.** `startImageRun` used to run while `stage` was still `"validate"`, because `stage = "image"` was set on the next line down. So a failure opening the image row was reported as `validate: ...`. It now lives inside `runImageStage`, which is called after `stage = "image"`, so the same failure reports as `image: ...`.

The new label is the correct one. Opening the image row is not a validation step, and the old label would send someone debugging in the wrong direction. Nothing depended on the old string, and no test existed for it. But it is observable, it is in the `error` field stored on the row, and it was not in the plan, so it is written here rather than left to be discovered.

**Ali, this is the specific thing to look at when you review the extraction.** If you would rather keep the old attribution, pulling `startImageRun` back out into `runPipeline` restores it and costs one duplicated line in `resume.ts` later.

### Phase 1, failure behaviour

- [ ] `src/services/pipeline.test.ts` exists, using the fake `AI` binding and `createTestDb`. No live model call anywhere in it — **Ali Amir** (owns the file)
- [ ] Planner throws: exactly one row for the invocation, `modality: text`, `status: failed`, `completedAt` set. No image row was ever opened. Result is `status: "failed"`, `params: null`, `image_url: null`, and `error` starting `planner:` — **Ali Amir**
- [ ] Planner returns a shape that fails `HeliosParamsSchema`: the run fails at the **validate** stage, not the planner stage, and `error` starts `validate:`. **Note before you write it:** `tools.ts` already passes `HeliosParamsSchema` into `getTextualModelOutput`, which validates and retries there, so `pipeline.ts:109`'s re-parse cannot fail through the real path. It is deliberate layering, `planConcept` returns `unknown` on purpose so the pipeline trusts nothing. Test it by faking the planner return directly, and do not go hunting for a production path that reaches it, there is not one — **Ali Amir**
- [ ] **Image throws, and this is the one that matters.** Text row stays `completed` with its real params, image row is `failed`, and the returned `params` is not null. Decision 5, and the trap named at the top — **Ali Amir**
- [ ] Image succeeded and a later step throws (R2 save or the row update): `cost_usd` on both the failed result and the row is non-null. Decision 6, and it is real money, so it gets its own test — **Ali Amir**
- [ ] DO storage itself unavailable: `runPipeline` still returns a settled `HeliosResult` with `status: "failed"` rather than throwing. Decision 8. Make the cleanup write fail too and confirm nothing escapes — **Ali Amir**
- [ ] A second invocation's `running` row in the same DO is untouched when this one fails. Decision 7 — **Ali Amir**
- [ ] **The retry boundary, both sides of it.** Planner: make `AI.run` throw with `maxRetries: 2` on the fake config and assert it was called exactly twice before the run failed, then set 3 and assert three. That proves the KV value reaches the call rather than a hardcoded number. Image: make the image call fail and assert `AI.run` was called **exactly once**. Decision 2, and this second assertion is what stops someone adding a retry loop to the expensive call by accident — **Ali Amir**

### Phase 2, the resume route

- [ ] `HeliosResumeRequestSchema` in `@aureline/shared-types`, next to `HeliosRequestSchema`. Both fields required, decision 12 — **Maaz Bin Asif**
- [ ] `services/resume.ts` with `resumeRun`, per the shape above. Reads with `getRunRows`, re-parses params (decision 17), mints a new `p_invoc_id` (decision 13), writes both rows with `resumed_from` and `attempt` (decisions 14 and 15), hands off to `runImageStage` — **Maaz Bin Asif**
- [ ] The decision 18 guard, with a distinct 409 reason for each case: run not found, planner never succeeded, image already completed. **Not one generic error.** The three mean different things to whoever is reading it, and the third is what stands between us and a double charge — **Maaz Bin Asif**
- [ ] `POST /resume` routed in `index.ts` using the same `scopeKey` lookup as `/generate`, validated in `agent.ts` the same way, returning a `HeliosResult` — **Maaz Bin Asif**
- [ ] No schema migration is generated for this. If you find yourself running `db:generate`, stop and re-read decision 16, the link goes in the existing JSON column — **Maaz Bin Asif**
- [ ] `services/resume.test.ts`, fake bindings, same patterns as phase 1. A resume of an image-failed run produces a new `p_invoc_id`, reuses the stored params exactly rather than re-planning, leaves the original failed rows untouched, and all three 409 cases refuse — **Maaz Bin Asif**
- [ ] Confirm the planner is never called on a resume. Assert the `AI.run` mock saw only the image model. That is the entire point of the route and it is one assertion — **Maaz Bin Asif**
- [ ] A resumed run has **two** rows, and its text row is `completed` with `cost_usd` null and `planner_skipped: true`. Decision 14 — **Maaz Bin Asif**
- [ ] `resumed_from` and `attempt` are on **both** rows of a resumed run, and on **neither** row of an original run. Decision 15. The image row is the one cost reports read, so a test that only checks the text row leaves the real gap open — **Maaz Bin Asif**
- [ ] A resume that fails can itself be resumed. Chain two: original fails on the image, resume once and fail again, resume that and succeed. Assert `attempt` goes 2 then 3, that each `resumed_from` points at its immediate parent rather than the root, and that all three runs are present and inspectable. This is the manual retry working more than once, which is what a person will actually do — **Maaz Bin Asif**
- [ ] Run the `json_extract` query from decision 16 against local D1 after the chain above and confirm it separates attempts from originals. The field is only useful if the query we intend to run against it actually works — **Maaz Bin Asif**

### Judgement calls, both Maaz, both before Ali writes assertions

- [ ] **The planner error message misattributes transport failures.** `getTextualModelOutput` throws `schema validation failed after N attempt(s)` from a catch that also swallows a thrown `ai.run`. So a network error or a bad model name is recorded in `helios_runs.error` as a schema problem. That makes the record misleading, and an inspectable record is the point of this ticket. Either distinguish the two in the helper or accept it and write down why. Decide, do not leave it — **Maaz Bin Asif** (owns `getTextualModelOutput.ts` for this ticket)
- [ ] **How much of the message reaches the row.** `error` is `${stage}: ${describeError(cause)}` and the helper's message carries a JSON dump of the last error plus a 200 character response excerpt. Confirm that is what we want stored per failed row, or cap it — **Maaz Bin Asif**

### Review gates

- [ ] `npx tsc --noEmit` clean and the full suite green from the repo root — **Ali Amir**
- [ ] One real forced failure end to end, confirming the failed rows reach D1 with the right statuses. Read it back with `readRun`, not a hand-typed query, same gate as ticket 07 — **Maaz Bin Asif** (reviews phase 1)
- [ ] One real resume end to end, per the verification steps below, including the second-attempt 409 — **Ali Amir** (reviews phase 2)
- [ ] No box is ticked on a green unit test alone where a real run was asked for, and nobody ticks a gate on their own phase. Tickets 03 and 07 both had gates ticked without being demonstrated and both got unticked at review — **both**

## Verification without burning budget

Every `POST /generate` is a real planner call plus a real image call, roughly $0.0019. Forcing failures the obvious way, by breaking things and retrying until something sticks, is how this ticket ends up costing more than the two that built the feature.

**Do not generate failures by generating runs. Point config at something that cannot work.**

**Planner failure, free.** Set the local text model to a name that does not exist:

```
npx wrangler kv key put --binding CONFIG --local text_model "@cf/does/not-exist"
```

A bare string is fine, `prepareModelValue` wraps anything not starting with `{` into `{ model: ... }`. **Use the bare string, not JSON.** Malformed JSON there returns null and silently falls back to the `PLANNER_MODEL` var, so a typo gives you a perfectly successful billed run instead of the failure you were trying to force.

`ai.run` rejects an unknown model, so the call fails before anything is billed. Decision 3 means it tries twice before giving up, so expect two attempts in the log. If it comes back as a result object instead of throwing, that is itself worth recording here, it changes what the pipeline sees.

**Image failure, one planner call only, about $0.001.** Leave `text_model` correct and break `image_model` the same way. The planner runs and bills normally, the image call fails before Flux is invoked, and you get the exact shape from decision 5: a `completed` text row with real params next to a `failed` image row. This is the cheapest way to produce the case the whole ticket is about.

**Then check D1 through code.** `readRun` on the failed `p_invoc_id`, per the gate above. `wrangler d1 execute --local` is fine for a glance but the box is ticked on the read path.

**Phase 2 verification reuses the failure you just made.** That broken `image_model` run leaves exactly the state resume exists for. So:

1. Put `image_model` back to Flux, leave `text_model` correct.
2. `POST /resume` with the `session_id` you used and the `p_invoc_id` of that failed run.
3. That costs **one image call and no planner call**, about $0.0009. Confirm in the log that the planner never ran.
4. Confirm in the DO that the original failed rows are still there untouched, and that the new run carries `resumed_from` and `attempt: 2` on **both** of its rows.
5. Send the same resume request again and confirm it comes back 409 rather than generating a second image. If it generates, you have found the bug decision 18 exists to prevent, and it is a billing bug.

**Put config back when you are done:**

```
npm run config:pull
```

That copies the remote values down and undoes both edits. Local KV starts empty and falls back to the committed vars in `wrangler.jsonc`, so a half-restored state looks fine right up until it does not.

**Budget: 1 real planner call for phase 1, plus 1 image call for phase 2.** Roughly $0.002 for the whole ticket, and only if you reuse phase 1's failure as phase 2's input rather than making a fresh one. If you find yourself spending more than that, stop and re-read this section.

## Two things that will waste your afternoon

**The dev server holds the local D1 file.** Ticket 07 lost time to this. Stop `wrangler dev` before running migrations against `--local`, then restart it.

**A green test suite is not the ticket.** Both suites use a fake `AI` binding and a fake database, so they prove the orchestrator's logic and nothing about how Workers AI actually fails. That is what the forced-failure and resume runs above are for, and it is why the last four boxes are review gates rather than work items.
