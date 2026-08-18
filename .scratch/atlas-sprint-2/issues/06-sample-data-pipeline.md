# atlas-06: Sample-data pipeline, end to end

**What to build:** the whole Atlas pipeline, working end to end, with the image call faked. Real routes, real validation, real database writes, real R2 writes, real response shapes. Fake image bytes, zero money spent.

**Objective:** in sprint 1 the single best decision was shipping the full pipeline on day one with fake model responses, because it unblocked four people immediately. This is that move for Atlas. It also means atlas-07 swaps out one fake for one real call instead of building a pipeline and a model integration at the same time, and it is what makes shared-02's eventual Iris-to-Atlas wiring a change in data rather than a change in code, because the fixture it builds against is a real `IrisResult`.

**Final result:** `POST /generate` with a pattern reference and a garment returns a complete `AtlasResult` with a servable `image_url`, one row lands in `atlas_runs`, `GET /runs` reads it back, and nothing has been billed. `POST /resume` exists as a route and answers, even though its real behaviour lands in atlas-08.

**Blocked by:** atlas-01, atlas-02, atlas-04, atlas-05.

**Status:** ready-for-human.

**Owner:** Maaz Ahmad. **Reviewer:** Ali Amir.

**Duration:** 2 days. **Scheduled:** Tue Aug 25 to Wed Aug 26.

## Read this first

- `.scratch/iris-sprint-2/issues/05-sample-data-pipeline.md`. Same job for the other engine, and every decision in it holds here except the ones this file changes. Read it first.
- `apps/agent-helios/src/services/pipeline.ts` (258 lines). The whole orchestration pattern, including the two things easiest to get wrong: `runImageStage` is exported separately so `/resume` can enter the pipeline there, and `runPipeline` never throws.
- `apps/agent-helios/src/agent.ts` (81 lines), for how the DO acts as its own controller and where validation happens.
- `apps/agent-helios/src/repository/r2.repository.ts` (38 lines). Two functions, both directions, and nothing else in the app touches R2.
- `apps/agent-helios/src/services/pipeline.test.ts` (331 lines) for how the pipeline is tested with a fake `env`.

## Decisions

1. **`runPipeline` never throws.** Every path, including a stage blowing up and DO storage being unavailable, returns an `AtlasResult`. The HTTP layer then only ever deals with settled outcomes and never has to produce a 500.
2. **The stages are validate, then image. There is no planner stage.** Validation still gets to be its own step, because `validRegionsFor` from atlas-05 can reject a request before anything bills, and an impossible request should never reach a paid call.
3. **A failed run returns HTTP 200 with a settled status in the body.** Not a 4xx, not a 5xx. The failure is described in `error` inside a normal `AtlasResult`. This matches Helios and Iris exactly, which is what lets the playground handle all three engines with no per-engine special case.
4. **`runImageStage` is exported separately from `runPipeline`, from day one.** atlas-08's `/resume` re-enters the pipeline at exactly that point. Extracting it now means there is one copy of the image path; extracting it later means there were briefly two. This matters more for Atlas than for Iris, because for Atlas the image stage is essentially the whole pipeline and the temptation to inline it is stronger.
5. **Config is resolved once per invocation, before the try block.** Every stage sees the same snapshot (ADR-0008). It goes outside the try because `resolveConfig` never throws.
6. **`p_invoc_id` is minted per invocation with `crypto.randomUUID()`**, not derived from the Durable Object. One DO accumulates many invocations (ADR-0005).
7. **The fake lives behind the same signature the real call will have.** `placePattern` returns bytes and dimensions exactly as the real one will, so atlas-07 replaces a function body, not a call site. Do not fake by branching inside the pipeline on a config flag: that branch would be load-bearing until it was removed.
8. **The fake output image is a real image file, not random bytes.** It has to survive being written to R2, served back through `GET /images/*`, and displayed in a browser. Random bytes pass every test and fail the one thing the fixture is for.
9. **The fixture input is a real `IrisResult`, validated against `IrisResultSchema` at test time.** Not a hand-written object that resembles one. This is the box that makes shared-02 cheap: if the fixture validates today, swapping it for Iris's live output later is a data change. If it does not, that is a real contract bug found for free.
10. **Routes are `POST /generate`, `POST /resume`, `GET /runs`, `GET /images/*`, and `GET /`**, the same names as Helios and Iris, so the playground needs no per-engine routing code.
11. **`GET /runs` must never be able to reach a model.** It is the route a page calls on load and on every refresh. Read-only and free, permanently.

## Agreed shapes, do not invent your own

```
apps/agent-atlas/src/
├── agent.ts                    AtlasAgent DO, its own controller
├── index.ts                    routing only (exists from atlas-02)
├── config.ts                   exists from atlas-02
├── services/
│   ├── pipeline.ts             runPipeline, runImageStage, exportAndPrune
│   └── placer.ts               placePattern, faked in this ticket
├── prompts/                    exists from atlas-05
├── repository/
│   ├── do.repository.ts        exists from atlas-04
│   └── r2.repository.ts        saveGarmentImage, readGarmentImage
└── fixtures/
    ├── sample-iris-result.ts        a real IrisResult, validated against the schema
    ├── sample-garment-reference.jpg a real small JPEG standing in for a caller-uploaded garment_ref
    └── sample-garment-output.jpg    a real small JPEG the fake image call returns
```

`sample-garment-reference.jpg` and `sample-garment-output.jpg` are deliberately two different files. Reusing one image for both the fake input and the fake output would hide a bug where the pipeline never actually reads `garment_ref` at all, because the test would pass either way.

```ts
// The fake, with the signature the real version keeps.

/** Returns raw bytes only. It does not know R2 exists. */
export async function placePattern(
  patternRef: string,
  garmentRef: string,
  placement: AtlasPlacement,
  config: AtlasConfig,
  env: Env,
  p_invoc_id: string
): Promise<{ image: Uint8Array; contentType: string; width: number; height: number; cost_usd: number | null }>;
```

The R2 key format. Atlas and Iris share one bucket, `images-bucket` (atlas-02 decision 5), so the key itself carries the engine folder rather than the bucket:

```
atlas/{p_invoc_id}.jpg
```

This differs from Helios's `patterns/{p_invoc_id}.jpg`, which names what the file is because Helios still has its own bucket. Atlas's and Iris's prefixes name the engine instead, because the bucket is shared and the engine is now the thing that needs distinguishing.

## Work

### The pipeline

- [ ] Write `services/pipeline.ts` with `runPipeline`, `runImageStage` and `exportAndPrune`. `exportAndPrune` may have a no-op body with a comment pointing at atlas-09, but its call sites must be in place at both the success and the failure exit. (**Maaz Ahmad**)
- [ ] `runPipeline` never throws. Wrap the whole body, and wrap the cleanup inside the catch in its own try as well, because cleanup is itself a DO write and fails when storage is what broke. A throw from inside a catch escapes the function. (**Maaz Ahmad**)
- [ ] Track the image cost in a variable declared **outside** the try. The real call bills before the R2 save and the row update, so a failure in either must still report what was spent. Getting this wrong records a spent call as having cost nothing, and it is invisible until it happens in production. (**Maaz Ahmad**)
- [ ] Track the current stage and prefix it onto `error` on failure (`"validate: ..."`, `"image: ..."`). This is how failures stay attributable without a separate column, which is why atlas-04 has no `error` column. (**Maaz Ahmad**)
- [ ] Call `validRegionsFor` from atlas-05 before anything bills, and refuse a request whose regions do not exist on the chosen garment. An impossible request must not reach a paid call. (**Maaz Ahmad**)
- [ ] Build the `AtlasPlacement` from the request plus `PLACEMENT_PROMPT_VERSION`, and write it into the row's `garment_regions` column. That column is the record of what this run actually did. (**Maaz Ahmad**)
- [ ] Write `request.garment_ref` onto the row's `garment_ref` column (atlas-04) at the same time as `pattern_ref`. Both are `notNull`; a run cannot open a row without either. (**Maaz Ahmad**)
- [ ] `runImageStage` always leaves a row behind, even when opening the row is itself what failed, via `insertFailedRun`. Atlas has one row per invocation, so without this a failed run leaves no trace at all. (**Maaz Ahmad**)
- [ ] `runImageStage` accepts a `metadataExtras` argument merged over the row's metadata. `runPipeline` passes nothing; atlas-08's resume passes its `root`, `resumed_from` and `attempt` markers, which have to land on this row because it is the only row there is. (**Maaz Ahmad**)
- [ ] `runImageStage` returns an outcome object rather than throwing, so the caller decides what a failed image means for its own result. (**Maaz Ahmad**)

### The fakes

- [ ] Write `services/placer.ts` with `placePattern` returning the fixture output image bytes, its dimensions, and `cost_usd: null`. Signature exactly as above, taking both `patternRef` and `garmentRef` even though the fake ignores both. Put a comment at the top naming atlas-07 as the ticket that replaces the body. (**Maaz Ahmad**)
- [ ] Add `fixtures/sample-garment-output.jpg`: a real, small JPEG of a garment carrying a pattern, standing in for what a real placement call would return. Under about 50KB. It must render in a browser, because that is the only thing distinguishing this from random bytes (decision 8). (**Maaz Ahmad**)
- [ ] Add `fixtures/sample-garment-reference.jpg`: a separate real, small JPEG of a plain garment, standing in for a caller-uploaded `garment_ref`. It must be a different file from the output fixture, so a test that never actually reads `garment_ref` still fails. (**Maaz Ahmad**)
- [ ] Add `fixtures/sample-iris-result.ts` holding a complete `IrisResult`, and a test that runs `IrisResultSchema.parse` over it (decision 9). If it fails, fix the fixture, not the schema, unless the schema is genuinely wrong. (**Maaz Ahmad**)
- [ ] Do **not** put a config flag in the pipeline that switches between fake and real (decision 7). (**Maaz Ahmad**)

### Routes and the agent

- [ ] `agent.ts`: `onRequest` handles `GET /runs` **before** the POST check, because it is the one route with no body and 405-ing it would make the history unreachable. (**Maaz Ahmad**)
- [ ] `GET /runs` returns `{ runs: [...] }`, an envelope and not a bare array, matching Helios and Iris. It honours an optional `p_invoc_id` query param. Rows go out exactly as stored, not reshaped: whatever reads this is debugging, and the stored shape is the thing worth seeing. (**Maaz Ahmad**)
- [ ] `POST /generate` validates with `AtlasRequestSchema.safeParse` and returns 400 with `firstIssueMessage` on failure. A malformed request never became an invocation, so there is no `p_invoc_id` to report: this is a transport error, not a run outcome. (**Maaz Ahmad**)
- [ ] `POST /resume` validates with `AtlasResumeRequestSchema` and returns a clearly-marked not-implemented response pointing at atlas-08. The route exists and validates; its behaviour does not. (**Maaz Ahmad**)
- [ ] Write `repository/r2.repository.ts` with `saveGarmentImage` and `readGarmentImage`, key format `atlas/{p_invoc_id}.jpg`. All R2 access, both directions, and nothing else in the app touches R2. (**Maaz Ahmad**)
- [ ] `GET /images/*` in `index.ts` reads through `readGarmentImage` and returns 404 when the key is absent, setting `Content-Type` from the object's stored metadata. (**Maaz Ahmad**)
- [ ] `image_url` on the result is built as `${origin}/images/${key}`, a servable URL and not raw bytes, matching both other engines. (**Maaz Ahmad**)
- [ ] `width` and `height` are populated on the result, from the fake for now. (**Maaz Ahmad**)

### Tests

- [ ] Write `services/pipeline.test.ts` against `createTestDb` from atlas-04 and a fake `env`. Cover: a full success writing exactly one row; an image failure leaving one `failed` row with the placement still recorded; an impossible region combination refused before the image stage runs; and storage being unavailable still returning a settled `AtlasResult` rather than throwing. (**Maaz Ahmad**)
- [ ] Assert a failed run returns HTTP 200 at the HTTP level, not just that the body says `failed`. Decision 3 is a contract with the frontend and needs a test that would notice it changing. (**Maaz Ahmad**)
- [ ] The fake `env` must include a fake `AI` binding that **throws if called**. Nothing in this ticket should reach a model, and a test that would silently start billing when atlas-07 lands is worse than no test. (**Maaz Ahmad**)
- [ ] Assert exactly one row per invocation. A test that counts rows is what would catch someone reintroducing a second row later out of symmetry with Iris. (**Maaz Ahmad**)

### Review gates

- [ ] Confirm `runPipeline` cannot throw. Read every `await` in it and ask what happens if that one rejects, then confirm the cleanup inside the catch is itself wrapped. (**Ali Amir**)
- [ ] Confirm the image-cost variable is declared outside the try, and write down what would break if it were not. If you cannot state the failure, the reasoning has not landed and it will get moved by someone tidying up. (**Ali Amir**)
- [ ] Confirm `runImageStage`'s signature is genuinely re-enterable by atlas-08, by writing out the call you would make from a resume path. If it needs an argument it does not have, say so now. (**Ali Amir**)
- [ ] Confirm `sample-iris-result.ts` is validated by a real `IrisResultSchema.parse` in a test, not merely typed as `IrisResult` (decision 9). A type annotation is checked at compile time against a schema that may have moved. (**Ali Amir**)
- [ ] Open `image_url` in a browser and confirm a garment image renders. Not a curl returning 200: actually look at it. (**Ali Amir**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** The image call is faked and the fake `AI` binding throws if touched. If you see a charge from this ticket, something is wired wrong and that is itself the bug.

1. `npm run dev --workspace=apps/agent-atlas`, then:
   ```
   curl -s -X POST http://localhost:8787/generate \
     -H 'Content-Type: application/json' \
     -d '{"pattern_ref":"colored/fake.jpg","garment_ref":"uploads/fake-shirt.jpg","source_p_invoc_id":"iris-test-1","garment_type":"tshirt","regions":["back","hem"]}' | jq
   ```
   Expect a complete `AtlasResult` with `status: "completed"`, a non-null `image_url`, non-null `width` and `height`, `cost_usd: null`, and a `placement` carrying `prompt_version`.
2. Open the returned `image_url` in a browser. A garment image renders.
3. `curl -s 'http://localhost:8787/runs' | jq '.runs | length'` returns 1. Confirm the row carries `source_p_invoc_id: "iris-test-1"`, the `pattern_ref`, the `garment_ref`, and a `garment_regions` object with both regions in it.
4. `curl -s -X POST http://localhost:8787/generate -d '{}'` returns 400 with a field-named message.
5. Ask for a sleeve on a scarf. Confirm it is refused before the image stage, and that no row is left in a `running` state.
6. Force a failure: make `placePattern` throw temporarily. Confirm HTTP 200 with `status: "failed"`, `error` prefixed `image:`, and one failed row in `GET /runs`. Then put it back.
7. `npm test` from inside `apps/agent-atlas` passes.

## Two things that will waste your afternoon

**Inlining the image stage into `runPipeline` because Atlas only has one stage is the mistake this ticket is most likely to ship.** It reads better, it is fewer lines, and it makes atlas-08 impossible without a refactor that touches the only code path in the engine. Decision 4 exists because for Atlas the temptation is genuinely stronger than it was for Iris.

**A fixture that is not really an image passes every test you will write.** `new Uint8Array([1,2,3])` writes to R2 fine, serves fine, and returns 200 fine. Then atlas-07 lands and the first real output looks wrong, and you spend an afternoon deciding whether the model or the plumbing is at fault, when the plumbing was never proven. Verification step 2 is the whole point.
