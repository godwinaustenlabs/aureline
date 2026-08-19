# iris-05: Sample-data pipeline, end to end

**What to build:** the whole Iris pipeline, working end to end, with both model calls faked. Real routes, real validation, real database writes, real R2 writes, real response shapes. Fake planner output, fake image bytes, zero money spent.

**Objective:** in sprint 1 the single best decision was shipping the full pipeline on day one with fake model responses, because it unblocked four other people immediately. This ticket is that move for Iris. It also unblocks the Atlas squad, because once Iris returns a real-shaped `IrisResult`, Atlas can build its fixtures against actual output rather than against a description of it. And it means iris-08 and iris-09 each swap out one fake for one real call instead of building a pipeline and a model integration at the same time.

**Final result:** `POST /generate` with a concept and a motif reference returns a complete `IrisResult` with a servable `image_url`, two rows land in `iris_runs`, `GET /runs` reads them back, and nothing has been billed. `POST /resume` exists as a route and answers, even though its real behaviour lands in iris-10.

**Blocked by:** iris-01, iris-02, iris-03.

**Status:** ready-for-human.

**Owner:** Arham Zahid. **Reviewer:** Maaz Bin Asif.

**Duration:** 2 days. **Scheduled:** Wed Aug 26 to Thu Aug 27.

## Read this first

- `apps/agent-helios/src/services/pipeline.ts` (258 lines). The whole orchestration pattern, including the two things that are easy to get wrong: `runImageStage` is extracted as its own exported function so `/resume` can enter the pipeline there, and `runPipeline` never throws.
- `apps/agent-helios/src/agent.ts` (81 lines), for how the DO acts as its own controller and where validation happens.
- `apps/agent-helios/src/repository/r2.repository.ts` (38 lines). Two functions, both directions, and nothing else in the app touches R2.
- `apps/agent-helios/src/services/pipeline.test.ts` (331 lines) for how the pipeline is tested with a fake `env`.

## Decisions

1. **`runPipeline` never throws.** Every path, including a stage blowing up and DO storage itself being unavailable, returns an `IrisResult`. The HTTP layer then only ever deals with settled outcomes and never has to produce a 500. This is not a nicety; it is what makes decision 3 possible.
2. **The stages run in fixed order: planner, validate, image.** Validation is its own stage, separate from the planner, so a schema failure is attributable to validation rather than to the model call. `planner.ts` deliberately does not validate its own output.
3. **A failed run returns HTTP 200 with a settled status in the body.** Not a 4xx, not a 5xx. The failure is described in `error` inside a normal `IrisResult`. This matches Helios exactly (ticket 08, decision 4), which means the playground and any future dashboard need no per-engine special handling.
4. **`runImageStage` is exported separately from `runPipeline`, from day one.** iris-10's `/resume` re-enters the pipeline at exactly that point. Extracting it now means there is one copy of the image path; extracting it later means there were briefly two.
5. **Config is resolved once per invocation, before the try block.** Every stage sees the same snapshot. Resolving per-service instead would let two reads straddle a KV edit and produce one invocation whose text row says one model and whose image row says another. It goes outside the try because `resolveConfig` never throws.
6. **`p_invoc_id` is minted per invocation with `crypto.randomUUID()`, not derived from the Durable Object.** One DO accumulates many invocations (ADR-0005). Deriving it from the DO would make every run in a session share an id.
7. **The fakes live behind the same function signatures the real calls will have.** `planConcept` returns `unknown` and `colorizeMotif` returns bytes, exactly as the real ones will. iris-08 and iris-09 then replace a function body, not a call site. Do not fake by branching inside the pipeline on a config flag, because that branch would have to be removed later and would be load-bearing until it was.
8. **The fake image is a real image file, not random bytes.** It has to survive being written to R2, served back through `GET /images/*`, and displayed in a browser. Random bytes pass every test and fail the one thing the fixture is for.
9. **Routes are `POST /generate`, `POST /resume`, `GET /runs`, `GET /images/*`, and `GET /`.** `/generate` rather than `/colorize` on purpose: the existing frontend switches engines by changing its base URL, so keeping the route names identical across engines means it needs no per-engine code.
10. **`GET /runs` must never be able to reach a model.** It is the route a page is allowed to call on load and on every refresh. Read-only and free, permanently.

## Agreed shapes, do not invent your own

```
apps/agent-iris/src/
├── agent.ts                    IrisAgent DO, its own controller
├── index.ts                    routing only (already exists from iris-02)
├── config.ts                   already exists from iris-02
├── services/
│   ├── pipeline.ts             runPipeline, runImageStage, exportAndPrune
│   ├── planner.ts              planConcept, faked in this ticket
│   └── colorizer.ts            colorizeMotif, faked in this ticket
├── repository/
│   ├── do.repository.ts        already exists from iris-03
│   └── r2.repository.ts        saveColoredImage, readColoredImage
└── fixtures/
    ├── sample-params.ts        a valid IrisParams the fake planner returns
    └── sample-colored.jpg      a real small JPEG the fake image call returns
```

```ts
// The two fakes, with the signatures the real versions will keep.

/** Returns unknown deliberately: the real one calls a model and cannot
 *  guarantee the shape. The pipeline's validate stage is what makes it trusted. */
export async function planConcept(concept: string, env: Env, config: IrisConfig, p_invoc_id: string): Promise<unknown>;

/** Returns raw bytes only. It does not know R2 exists. */
export async function colorizeMotif(
  motifRef: string, params: IrisParams, config: IrisConfig, env: Env, p_invoc_id: string
): Promise<{ image: Uint8Array; contentType: string; width: number; height: number; cost_usd: number | null }>;
```

The R2 key format. Iris and Atlas share one bucket, `images-bucket` (iris-02 decision 5), so the key itself carries the engine folder rather than the bucket:

```
iris/{p_invoc_id}.jpg
```

This differs from Helios's `patterns/{p_invoc_id}.jpg`, which names what the file is because Helios still has its own bucket. Iris's and Atlas's prefixes name the engine instead, because the bucket is shared and the engine is now the thing that needs distinguishing.

## Work

### The pipeline

- [ ] Write `services/pipeline.ts` with `runPipeline`, `runImageStage` and `exportAndPrune`. `exportAndPrune` may be a no-op body with a comment pointing at iris-11, but the call site must be in place, at both the success and the failure exit. (**Arham Zahid**)
- [ ] `runPipeline` never throws. Wrap the whole body, and wrap the cleanup inside the catch in its own try as well, because cleanup is itself a DO write and fails when storage is what broke. A throw from inside a catch escapes the function. (**Arham Zahid**)
- [ ] Track the image cost in a variable declared **outside** the try. The real image call bills before the R2 save and the row update run, so a failure in either must still report what was spent. Getting this wrong records a spent image as having cost nothing, and it is invisible until it happens in production. (**Arham Zahid**)
- [ ] Track the current stage in a variable and prefix it onto `error` on failure (`"planner: ..."`, `"image: ..."`). This is how failures stay attributable without a separate column, which is why decision 5 of iris-03 says there is no `error` column. (**Arham Zahid**)
- [ ] `runImageStage` always leaves an image row behind, even when opening the row is itself what failed, via `insertFailedImageRun`. Otherwise the invocation settles as a lone completed text row that looks like a success and gets pruned like one. (**Arham Zahid**)
- [ ] `runImageStage` accepts a `metadataExtras` argument merged over the image row's metadata. `runPipeline` passes nothing; iris-10's resume passes its `resumed_from` and `attempt` markers, which have to land on this row because it is the one carrying `cost_usd` and `image_r2_key` and therefore the one every cost query reads. (**Arham Zahid**)
- [ ] `runImageStage` returns an outcome object rather than throwing, so the caller decides what a failed image means for its own result. (**Arham Zahid**)

### The fakes

- [ ] Write `services/planner.ts` with `planConcept` returning the fixture params. Signature exactly as above, returning `unknown`. Put a comment at the top saying which ticket replaces the body. (**Arham Zahid**)
- [ ] Write `services/colorizer.ts` with `colorizeMotif` returning the fixture image bytes, its dimensions, and `cost_usd: null`. Same treatment. (**Arham Zahid**)
- [ ] Add `fixtures/sample-colored.jpg`: a real, small, actually-colored JPEG. Keep it under about 50KB. It must render in a browser, because that is the only thing distinguishing this from random bytes (decision 8). (**Arham Zahid**)
- [ ] Add `fixtures/sample-params.ts` with a valid `IrisParams` that exercises the optional fields: one with all three colors, and one with only `primary_color`. (**Arham Zahid**)
- [ ] Do **not** put a config flag in the pipeline that switches between fake and real. iris-08 and iris-09 replace function bodies (decision 7). (**Arham Zahid**)

### Routes and the agent

- [ ] `agent.ts`: `onRequest` handles `GET /runs` **before** the POST check, because it is the one route with no body and 405-ing it would make the history unreachable. (**Arham Zahid**)
- [ ] `GET /runs` returns `{ runs: [...] }`, an envelope and not a bare array, matching Helios. It honours an optional `p_invoc_id` query param to narrow to one invocation. Rows go out exactly as stored, not reshaped: whatever reads this is debugging, and the stored shape is the thing worth seeing. (**Arham Zahid**)
- [ ] `POST /generate` validates with `IrisRequestSchema.safeParse` and returns 400 with `firstIssueMessage` on failure. A malformed request never became an invocation, so there is no `p_invoc_id` to report: this is a transport error, not a run outcome. (**Arham Zahid**)
- [ ] `POST /resume` validates with `IrisResumeRequestSchema` and returns a clearly-marked not-implemented response pointing at iris-10. The route exists and validates; its behaviour does not. (**Arham Zahid**)
- [ ] Write `repository/r2.repository.ts` with `saveColoredImage` and `readColoredImage`, key format `iris/{p_invoc_id}.jpg`. All R2 access, both directions, and nothing else in the app touches R2. (**Arham Zahid**)
- [ ] Put a comment at the top of `r2.repository.ts` explaining that the binding is called `PATTERNS` but holds Iris's **coloured output**, not patterns. The name is deliberate — it is identical across all three engines so this file reads the same everywhere, and the bucket is shared with Atlas, with separation done by key prefix (the comment above `r2_buckets` in `wrangler.jsonc` has the full reasoning). Without the comment, `env.PATTERNS` in a file that only ever writes coloured images reads like a copy-paste mistake, and the next person will "fix" it. (**Arham Zahid**)
- [ ] `GET /images/*` in `index.ts` reads through `readColoredImage` and returns 404 when the key is absent. It sets `Content-Type` from the object's stored metadata. (**Arham Zahid**)
- [ ] `image_url` in the result is built as `${origin}/images/${key}`, a servable URL and not raw bytes, matching Helios. (**Arham Zahid**)
- [ ] `width` and `height` are populated on the result, from the fake for now. Atlas needs them and a null there means Atlas has to fetch and decode the image to find out what it is placing. (**Arham Zahid**)
- [ ] **Persist `width` and `height` into the image row's `model_metadata`**, not just onto the response. There is no column for them and there deliberately never will be (iris-03 decision 9), so `model_metadata` is the only durable home they have. Put them on the response *by reading them back from what you stored*, so a bug here is visible in step 3's verification rather than hiding until Atlas reads a pruned run. (**Arham Zahid**)
- [ ] **`completeImageRun` needs a `modelMetadata` argument added to it, merged over the row's existing metadata.** As iris-03 shipped it the signature is `(db, pInvocId, imageR2Key, costUsd)` — it settles the image row but cannot write anything to `model_metadata`, and `startImageRun` runs *before* the image call, when the dimensions are not known yet. Without this change there is no moment at which the real returned dimensions can be recorded. Extend the repository function, do not work around it by writing the requested dimensions up front: what the model was asked for and what it returned are not guaranteed to match, and iris-09 is where that difference starts mattering. (**Arham Zahid**)

### Tests

- [ ] Write `services/pipeline.test.ts` against `createTestDb` from iris-03 and a fake `env`. Cover: a full success writing two rows; a planner failure leaving one failed text row and one failed image row; an image failure keeping the planner's params on the result rather than discarding them; and storage being unavailable still returning a settled `IrisResult` rather than throwing. (**Arham Zahid**)
- [ ] Assert that a failed run returns status 200 at the HTTP level, not just that the body says `failed`. Decision 3 is a contract with the frontend and needs a test that would notice it changing. (**Arham Zahid**)
- [ ] The fake `env` in tests must include a fake `AI` binding that **throws if called**. Nothing in this ticket should reach a model, and a test that would silently start billing when iris-08 lands is worse than no test. (**Arham Zahid**)

### Review gates

- [ ] Confirm `runPipeline` cannot throw. Read every `await` in it and ask what happens if that one rejects. Then confirm the cleanup inside the catch is itself wrapped. (**Maaz Bin Asif**)
- [ ] Confirm the image-cost variable is declared outside the try, and write down what would break if it were not. If you cannot state the failure, the reasoning has not landed and it will get moved later by someone tidying up. (**Maaz Bin Asif**)
- [ ] Confirm `runImageStage`'s signature is genuinely re-enterable by iris-10, by writing the call you would make from a resume path. If it needs an argument it does not have, say so now. (**Maaz Bin Asif**)
- [ ] Confirm the fake `AI` binding throws, and that no test passes because a model was quietly not called. (**Maaz Bin Asif**)
- [ ] Open `image_url` in a browser and confirm a colored image renders. Not a curl that returns 200: actually look at it. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** Both model calls are faked and the fake `AI` binding throws if touched. If you see a charge from this ticket, something is wired wrong and that is itself the bug.

1. `npm run dev --workspace=apps/agent-iris`, then:
   ```
   curl -s -X POST http://localhost:8787/generate \
     -H 'Content-Type: application/json' \
     -d '{"concept":"art deco paisley in deep jewel tones","motif_ref":"patterns/fake.jpg","source_p_invoc_id":"helios-test-1"}' | jq
   ```
   Expect a complete `IrisResult` with `status: "completed"`, a non-null `image_url`, non-null `width` and `height`, and `cost_usd: null`.
2. Open the returned `image_url` in a browser. A colored image renders.
3. `curl -s 'http://localhost:8787/runs' | jq '.runs | length'` returns 2. Confirm both rows share one `p_invoc_id`, that one is `text` and one is `image`, and that both carry `source_p_invoc_id: "helios-test-1"` and the same `motif_ref`.
4. `curl -s -X POST http://localhost:8787/generate -d '{}'` returns 400 with a field-named message.
5. Force a failure: make `planConcept` throw temporarily. Confirm the response is **HTTP 200** with `status: "failed"`, that `error` is prefixed `planner:`, and that `GET /runs` shows two failed rows. Then put it back.
6. `npm test` from inside `apps/agent-iris` passes.

## Two things that will waste your afternoon

**Returning raw image bytes from `/generate` instead of a URL feels simpler and is a trap.** It base64s through every layer, bloats the response, and means nothing can look at the output afterwards. Helios settled this and Iris follows it. The same goes for putting the image in the `IrisResult` "just for the playground": the playground fetches the URL.

**A fixture that is not really an image passes every test you will write.** `new Uint8Array([1,2,3])` writes to R2 fine, serves fine, and returns 200 fine. Then iris-09 lands and the first real image looks wrong, and you spend an afternoon deciding whether the model or the plumbing is at fault, when the plumbing was never actually proven. Verification step 2 is the whole point.
