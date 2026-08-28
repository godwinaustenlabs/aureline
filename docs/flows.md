# What actually happens

Every path through the engine, step by step, naming the file and function at each point. If you want to know where to put a breakpoint, this is the file.

Examples are from `apps/agent-helios`. Costs are real figures from live runs.

## 1. A request arrives and finds its Durable Object

This happens before any of the flows below, on every request.

1. **`src/index.ts`, `fetch`.** The Worker looks at the pathname. `/` returns a string. `/images/*` is handled here directly. `/generate` and `/resume` go on to step 2. Anything else falls through to `routeAgentRequest`, and then to a 404.
2. **`scopeKey(request)`.** Clones the request body, reads `session_id`, and returns it trimmed. A non-POST, a missing field, an unparseable body or a blank string all give the literal string `"default"`. Cloning matters: the body has to be readable again downstream.
3. **`getAgentByName(env.HeliosAgent, key)`.** The SDK hashes that name into a Durable Object id. Deterministic, so the same string always resolves to the same object with the same storage, globally and forever. It is exact and case sensitive: `"alpha"` and `"Alpha"` are two different objects.
4. **The object wakes.** If it was evicted for being idle, its code starts fresh, and `onStart()` in `src/agent.ts` runs Drizzle's migrator against `ctx.storage`. The code restarting does **not** mean the data restarted: `ctx.storage` is on disk and comes back exactly as it was.
5. **`agent.fetch(request)`** hands the request to `onRequest`, still inside the object.

Free. Nothing here calls a model.

## 2. `POST /generate`, the happy path

Total cost about **$0.0029**.

1. **`agent.ts`, `onRequest`.** Not a POST is a 405. The body is parsed and checked against `HeliosRequestSchema`. A failure is a 400 with the first Zod issue, and no invocation exists.
2. **`pipeline.ts`, `runPipeline`.** From here nothing throws. Every path returns a settled `HeliosResult`.
3. **`resolveConfig(env)`.** One batched KV read for all five keys, cached at the edge for 60 seconds, falling back to `wrangler.jsonc` vars on anything going wrong. Read **once** per invocation, so every stage sees one snapshot. Reading per service would let two reads straddle a dashboard edit and write a row that is half old model and half new. Logs one `config: ...` line.
4. **`crypto.randomUUID()`** mints `pipeline_id`. This is the invocation's identity, not the object's.
5. **`startTextRun`** writes the text row as `running`. Inside the try block, so DO storage being unavailable comes back as a settled failed result rather than an opaque 500.
6. **`planner.ts`, `planConcept`.** Builds the system and user prompts from `prompts/planner.prompt.ts`, then calls `callPlannerModel` in `tools.ts`, which calls `getTextualModelOutput` in shared-utils. That converts `HeliosParamsSchema` to a JSON schema, sends a Chat Completions request with `response_format: json_schema` through AI Gateway, unwraps the reply, and validates. **On a schema mismatch or a thrown call it retries, up to `max_retries` total attempts.** *Billed, about $0.001 per attempt.*
7. **`readGatewayCost(env)`, immediately.** `env.AI.aiGatewayLogId` holds only the **most recent** routed call on the binding, so this has to be read here. Read it after the image stage and you get the image's cost written onto the text row.
8. **Validate.** `HeliosParamsSchema.parse(planned.data)`. A second check, on purpose: what the model returned has to satisfy the contract before anything downstream trusts it.
9. **`completeTextRun`** settles the text row: status `completed`, the params, `{ model, usage }` metadata, and the dollar cost. The provider's neuron figure is not lost, it rides inside `usage`.
10. **`runImageStage`.** Broken out below because `/resume` calls it too.
11. **`exportAndPrune`.** Copies every settled row in this object to D1, then prunes to `retention_limit`, and only prunes if the export worked. Never throws.
12. **Respond 200** with the params, `image_url` of `{origin}/images/patterns/{pipeline_id}.jpg`, and `cost_usd`.

### Inside `runImageStage`

1. **`startImageRun`** opens the image row as `running`, carrying a copy of the params and `{ model, steps }` metadata. `steps` is what will actually be **sent**, not what config holds, because `resolveSteps` clamps to Flux Schnell's cap of 8.
2. **`imageGenerator.ts`, `generateImage`.** `buildImagePrompt` in `prompts/image.prompt.ts` turns the eight params into one flowing sentence. Clause order matters because Flux weights early clauses more heavily. Flux has no negative prompt, so exclusions become a `Do not include:` clause. A prompt over 2048 characters throws **before** the billed call.
3. **`env.AI.run`** through the gateway with `skipCache: true`. The gateway would otherwise cache image replies for an hour, and with no seed to vary the key two identical briefs would get the same picture. *Billed, about $0.0019.*
4. **`costUsd` is assigned the moment the model returns**, before anything else can fail. Everything after this point has already been paid for.
5. **`savePatternImage`** writes the bytes to R2 under `patterns/{pipeline_id}.jpg`.
6. **`completeImageRun`** settles the row with the key and the cost.

`runImageStage` **builds no `HeliosResult`**. It returns `{ ok, costUsd, ... }` and lets each caller shape its own response, so result building stays whole in one place per caller rather than split across two functions.

## 3. `POST /generate` where the planner fails

Cost: whatever the attempts burned, typically **about $0.001 to $0.002**, and it is not recorded.

The failure lands in the catch in `runPipeline`. `failRunningRuns` marks the text row `failed`, `exportAndPrune` runs anyway, and the response is a **200** with `status: "failed"`, `params: null`, and `error: "planner: ..."`.

The result is a lone `failed` text row and **no image row**, which is the one legal single-row invocation. There is nothing to resume: without params there is nothing to skip the planner with, and `/resume` will refuse.

**A known gap.** When every planner attempt fails, step 7 above is never reached, so `cost_usd` is null even though the attempts billed. Documented rather than fixed, and noted in [helios-runs-conventions.md](helios-runs-conventions.md).

## 4. `POST /generate` where the image fails

Cost: **about $0.001**, sometimes more.

`runImageStage` returns `ok: false`, `runPipeline` re-throws the cause into its own catch, `failRunningRuns` marks the image row `failed`, and the response is a 200 with `status: "failed"`, `error: "image: ..."`, and **`params` retained**.

The rows now read `completed` text, `failed` image. **This is the resumable state**, and preserving it properly is the reason the failure handling work exists at all. The params are on disk, so the expensive half can be retried without paying for the cheap half again.

`cost_usd` on the image row depends on where it broke. If the model was never reached (a bad model name, an overlong prompt) it is null, because nothing was charged. If the model returned and the R2 save or the row update is what failed, the cost is recorded, because the money left the account regardless.

## 5. When the image row cannot even be opened

Worth its own section because the code looks strange until you know what it prevents.

If `startImageRun` itself throws, usually because DO storage is unavailable, then there is no image row for `failRunningRuns` to mark. The invocation would settle as a **lone `completed` text row**: a failure that looks exactly like a success, and one that `pruneCompletedRuns` will happily delete like any other completed run. The audit trail would quietly say everything was fine.

So `runImageStage` tracks whether the row opened, and if it did not, `insertFailedImageRun` writes one that is already `failed`. That keeps the two-rows rule true on every path and keeps the run out of the pruner's reach.

The rescue write is itself wrapped in a try and swallowed, because the usual reason opening the row failed is that storage is down, in which case this write fails too. The original cause is still the failure worth reporting.

## 6. `POST /resume`

Runs **only** the image half, reusing the params already on disk. The planner is never called. About **$0.0019** when it runs, and **free** when it refuses.

The whole point is that the image stage does not retry itself. A failed Flux call usually fails again for the same reason and each attempt is the expensive half, so a person decides. See [ADR-0009](adr/0009-retry-policy-is-per-stage-not-per-pipeline.md).

### The six refusals

`resumeRun` in `services/resume.ts` checks these in order. Each one returns a **409** having written nothing and billed nothing, and each says something genuinely different to whoever is holding a failed run.

| # | Refusal | What it protects |
|---|---|---|
| 1 | No run with that id in this session | You are on the wrong Durable Object, or the id is wrong |
| 2 | The planner never succeeded | There are no params to reuse. Send a new `/generate` |
| 3 | This run already has an image | **Stops you paying for the same picture twice** |
| 4 | The image is still `running` | A concurrent invocation is mid-flight. Wait for it |
| 5 | The stored params are no longer valid | Written under an older schema. Refuse loudly rather than make a nonsense image |
| 6 | This brief has hit the resume cap | The spend ceiling, below |

Refusal 5 is why `planner_params` is re-validated through `HeliosParamsSchema` instead of being trusted. It comes back from a JSON column as `unknown`.

### The three markers

A resume is a **new invocation**. New `pipeline_id`, its own two rows, and the original left exactly as it was, because that failure record is the point. It could not overwrite the original anyway: those rows are already in D1 by now, and `onConflictDoNothing` means whichever version landed first is the one D1 keeps.

Three fields go into `model_metadata` on **both** rows:

- **`resumed_from`** points at the immediate parent, so a resume of a resume reads as one more step rather than a fork.
- **`attempt`** is depth from the original. An original carries none of these, which is what makes it an original, so the first retry is `attempt: 2`.
- **`root`** is the original the whole chain descends from, inherited unchanged however deep or wide it goes.

They go on both rows because the image row is the one carrying `cost_usd`, so it is the one every cost query reads. Marking only the text row would leave those queries unable to tell a retry from an original.

### Why the cap counts `root` and not `attempt`

This is the part worth reading twice.

Retries form a **tree, not a line**. You can resume the same failed run more than once. Do it ten times and you get ten siblings that all read `attempt: 2`, because they are all one step from the same parent. Depth is not a count, so a cap on `attempt` would never fire and the tenth retry would sail through.

`root` fixes it. Every attempt at one concept shares the same root regardless of the shape of the tree, so `countResumeAttempts(db, root)` counts what was actually spent on this brief. That is compared against `max_resume_attempts` before anything is written.

Originals carry no root, so the count is resumes only. A limit of 3 means an original plus three retries.

**One known limit.** The count is over what the Durable Object still holds, not over all time. It is accurate where it matters: failed runs are never pruned, so failed attempts persist, and a successful resume ends the chain anyway because refusal 3 already blocks a run that has an image.

### Then it runs

`insertResumedTextRun` writes a text row that is **already `completed`**, with the copied params, `planner_skipped: true`, and **`cost_usd` null**, because nothing was re-planned and a phantom planner cost would corrupt every cost report built on the table. The `model` is copied from the parent, because naming the currently configured planner would credit a model that was never called for this row.

Then the same `runImageStage` as `/generate`, with the markers passed through as metadata extras, then `exportAndPrune`, then a 200.

A failed resume is itself resumable, so it keeps its params too. The error prefix is always `image:`, because that is the only stage a resume has.

## 7. Config resolution

Runs once per invocation, at the top of both `runPipeline` and `resumeRun`.

1. **One batched `env.CONFIG.get(KEYS, { cacheTtl: 60 })`** for all five keys. 60 seconds is already the propagation floor for KV writes, so a shorter TTL buys nothing and costs edge reads.
2. **Per key**, missing or null falls back to the var. Present values are prepared (the model keys accept a bare id as well as a JSON object) and validated. **An invalid value is treated exactly like a missing one**: warn, fall back, carry on.
3. **A KV outage falls everything back to vars.** Config is policy, not a dependency the pipeline cannot run without.
4. **Logs one line** naming every value and its source, `(kv)` or `(var)`.

`resolveConfig` **never throws**, and it sits outside the try block for that reason. It is also deliberately **not** cached in module scope: module scope inside a Durable Object survives across invocations for the life of the instance, so a cached value would freeze and dashboard edits would appear to do nothing. `cacheTtl` is the cache.

Free.

## 8. `GET /images/*`

Handled entirely in `index.ts`, never reaching a Durable Object. Everything after `/images/` is the R2 key, `readPatternImage` fetches it, and the body streams back with the stored content type or `application/octet-stream`. A missing object is a 404.

Free.

## 9. Export and prune

Runs at the end of every invocation, success or failure, in `exportAndPrune`.

1. **`getSettledRows`** reads every row in this object that is not `running`.
2. **`exportRuns`** inserts them into D1 in chunks of 9, with `onConflictDoNothing`. Repeats are harmless because `id` was minted in the Durable Object and travels with the row.
3. **`pruneCompletedRuns`** deletes all but the newest `retention_limit` fully completed invocations, grouped by `pipeline_id`. Failed runs and `running` rows are never touched.

Step 3 only happens if steps 1 and 2 succeeded. Any failure logs and returns, because export is an audit concern and should not cost the caller their result. Free.

## Cost and writes at a glance

| Flow | Writes to | Cost |
|---|---|---|
| Cold start, routing | nothing | free |
| `/generate` success | DO, D1, R2 | ~$0.0029 |
| `/generate` planner failed | DO, D1 | ~$0.001, unrecorded |
| `/generate` image failed | DO, D1 | ~$0.001 |
| `/resume` success | DO, D1, R2 | ~$0.0019 |
| `/resume` refused (409) | nothing | free |
| 400, 404, 405 | nothing | free |
| `GET /` and `GET /images/*` | nothing | free |
| The test suite | nothing | free |

## Where to go next

- What the rows mean once written: [database.md](database.md)
- Which file holds which function: [directory-structure.md](directory-structure.md)
- Running these flows yourself: [running-locally.md](running-locally.md)
