# iris-09: The real image call, painting the palette onto the motif

**What to build:** replace iris-05's fake `colorizeMotif` with a real image-to-image call that takes Helios's black-and-white motif plus the palette from iris-08 and returns a colored version. Includes fetching the motif and recording the real cost. It no longer includes a resize; see decision 3.

**Objective:** this is the ticket that makes Iris actually do its job. It is also the only expensive part of the engine, the only part with a hard input constraint we do not control, and the only part that cannot be retried automatically. All three of those are why it is last in the model sequence.

**Final result:** `POST /generate` with a real concept and a real Helios motif returns a colored version of that motif, stored in R2 and served over a URL, with the cost read wired in and recorded on the image row. That read returns `null` today — see decision 10, which is the one thing to read before you conclude the cost path is broken.

**Blocked by:** iris-05 (the pipeline), iris-07 (the multipart helper), iris-08 (real params to color with).

**Status:** ready. iris-07 has landed. Note decision 10 before starting: the cost half of this ticket cannot be verified today.

**Owner:** Ali Amir. **Reviewer:** Maaz Bin Asif.

**Duration:** 2 days. **Scheduled:** Tue Sep 1 to Wed Sep 2.

## Read this first

- `apps/agent-helios/src/services/imageGenerator.ts` (104 lines). The reference for this file's discipline: it returns raw bytes only, it does not know R2 exists, it clamps a model parameter to the model's real cap, it skips the gateway cache, and it rejects an over-long prompt **before** billing.
- `apps/agent-helios/src/services/pipeline.ts:112-162`, `runImageStage`. This is the function whose body you are filling in, and its comments explain why an image row is always left behind.
- `.scratch/iris-sprint-2/issues/06-flux-2-klein-probe.md`, "What we found". The confirmed request shape, the confirmed size limit, and the confirmed oversized-input behaviour all come from there.
- `packages/shared-utils/src/getImageToImageOutput.ts`. iris-07's helper, which this ticket is the only caller of. Read its two guards in particular: they run **before** `ai.run` because `ai.run` bills. The dimension guard fires only on dimensions the caller *declares*, which is why decision 3 can skip it by omitting them.
- `docs/ai-gateway-multipart-findings.md` — **untracked, local only, not in git.** If you do not have it, ask Maaz Bin Asif for a copy before you start. It is what decision 10 rests on, and without it the missing gateway cost in this ticket looks like a bug you introduced.
- ADR-0009 for why this call never auto-retries. ADR-0006 says every model call routes through the gateway; decision 10 is where this ticket cannot comply.

## Decisions

1. **This call never retries automatically** (ADR-0009). It is expensive and one-shot, and a failure is very likely to fail the same way again. A person triggers a retry through `POST /resume`, which iris-10 builds. If you feel the urge to add a retry here, that urge is what ADR-0009 was written to answer.
2. **Skip the gateway cache for this call** — *dormant today, see decision 10.* The reasoning stands and the flag should be passed: the cache key covers the model inputs, so the same concept and the same motif would return the same image rather than a new attempt, and a resume that returns the cached first attempt is not a resume. Helios's `generateImage` sets `skipCache` for exactly this reason. What has changed is that with no gateway id, `buildAiRunOptions` returns `undefined` and `skipCache` never reaches `ai.run` — and there is no gateway cache in front of a direct Workers AI call for it to skip. So this is currently a no-op that costs nothing and is correct the day the gateway works. Pass it; do not build a test that asserts the cache was skipped, because there is nothing to observe.
3. **The motif is sent at its original size. There is no resize step.** This reverses the ticket's original decision, and the reasoning is worth reading before anyone puts one back.

    iris-06 found the model does not need it: a 640x640 input was accepted silently and produced a valid 1024x1024 output, so the documented "under 512x512" is a best practice rather than a hard failure. And a resize is not cheap to add here. Workers have no `sharp`. `fetch(url, { cf: { image } })` only applies on a proxied Cloudflare zone with Image Resizing enabled, which this Worker does not run on, and under `wrangler dev` it is a low-fidelity mock that would pass every local check while shipping an unresized motif. The Images binding (`env.IMAGES`) is the correct answer and is already typed in `worker-configuration.d.ts`, but it needs Images enabled on the account, which is a human's action. A WASM decoder is the remaining option and is real work for a constraint the model does not actually enforce.

    So: `InputImage.width` and `.height` are **omitted**, which is iris-07's documented way to skip its guard ("a caller that does not know its dimensions omits them and the call proceeds"). `resolveInputSize` is not written. Unused code that hides an unmade decision is worse than no code, and a function clamping to a bound nothing enforces is exactly that. When the Images binding lands, this decision is the one to revisit.
4. **Fetch the motif through the repository layer, not with a bare `fetch`.** `motif_ref` may be an R2 key or a URL. Whichever it is, reading it goes through a named function in `repository/`, because `repository/` is the only code allowed to touch storage and because the two cases need different handling.

    **The two engines do not share a bucket, and the binding name hides it.** Iris's `PATTERNS` is `images-bucket` (shared with Atlas); Helios's identically-named `PATTERNS` is `helios-bucket`. A key Helios wrote therefore does *not* resolve through Iris's binding, and the failure looks like a deleted object rather than a wrong bucket. The URL form has no such problem and is what Helios actually emits (`${origin}/images/patterns/{pipeline_id}.jpg`), so it is the form to prefer. `patterns/motif.jpg` was copied into `images-bucket` by hand so the key branch is exercisable locally; that copy is a testing convenience, not a pipeline.
5. **`colorizeMotif` returns bytes and dimensions, and does not know R2 exists.** The pipeline saves. Same separation as Helios, and it is what lets the service be tested without a bucket.
6. **Read the cost immediately after the call**, with the same `readGatewayCost(env, "image")` iris-08 ported. Its three read attempts exist specifically for this stage: for an image model the gateway fills in `cost` after the response has already come back, so a read on the next line finds the row present and the cost absent. That happened to a real Helios production run. **Today this read will return `null` every time** (decision 10) — write it anyway, in the right place, so that the day the gateway carries this call the cost appears with no code change. `readGatewayCost` already tolerates a null and never fails a run for it, which is the property this depends on.
7. **Record the cost even when a later step fails.** The call bills before the R2 save and the row update. `runImageStage` assigns `costUsd` the moment the model returns, so the catch reports what was actually spent rather than null.
8. **The prompt comes from `buildColorPrompt`, unchanged.** No prompt text in this file. If the output looks wrong because of wording, that is iris-04's file to change, and its version id changes with it.
9. **`width` and `height` on the result are the colored image's real dimensions**, not the motif's and not a hardcoded pair. Atlas reads them to know what it is placing.

    Nothing reports them, so they are read out of the returned bytes by `services/imageDimensions.ts`. The model returns `{ image: "<base64>" }` and no size; the input's size is not the output's (iris-06 sent 640x640 and got 1024x1024 back); and `env.IMAGES.info()` would do this natively but there is no Images binding. That file is JPEG-only on purpose and is the thing to delete the day the binding lands.
10. **The gateway is off for this call, so the image row's `cost_usd` is null.** Not a bug and not something to work around in code. Multipart image-to-image through the `iris` gateway has never once succeeded: every attempt returned `8001: Invalid input`, the gateway's own request log showed the multipart body as an empty object, and the gateway rejects the `ReadableStream` the helper sends outright. The one call that ever worked — Ali's iris-06 probe — predates the `iris` gateway existing and went direct to Workers AI, which is the whole explanation for the discrepancy. iris-07 therefore ships the gateway wiring complete and **inert**: `buildAiRunOptions` returns `undefined` when no id is passed, so turning it on later is one line at this call site and zero lines in the helper.

    What this ticket does about it: **pass no gateway id**, write the cost read and the metadata as if it were on, and accept a null cost. What this ticket does **not** do: decide whether that is acceptable past this sprint. ADR-0006 says every model call routes through the gateway and this one cannot, so either Cloudflare fixes the multipart path or ADR-0006 needs an amendment. That is a group decision — raise it, do not settle it in this PR. Full evidence and the five variables that were ruled out are in `docs/ai-gateway-multipart-findings.md`.

## Agreed shapes, do not invent your own

```ts
// apps/agent-iris/src/services/colorizer.ts
// Signature unchanged from iris-05's fake. Returns raw bytes. Knows nothing
// about R2.
export async function colorizeMotif(
  motifRef: string,
  params: IrisParams,
  config: IrisConfig,
  env: Env,
  pipeline_id: string
): Promise<{
  image: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  cost_usd: number | null;
}>;

// No `resolveInputSize`. See decision 3: the motif is sent at its original
// size and `InputImage` omits width/height entirely.
```

What lands in the image row's `model_metadata`:

```jsonc
{
  "model": "@cf/black-forest-labs/flux-2-klein-9b",
  "prompt_version": "iris-color-v1",
  "input_dimensions": { "width": 480, "height": 480 },
  "original_dimensions": { "width": 1024, "height": 1024 },
  "output_dimensions": { "width": 1024, "height": 1024 }
}
```

All three dimension pairs are recorded deliberately, and they answer different questions.

`input_dimensions` and `original_dimensions` are for debugging: when an output looks wrong, the first question is always whether the input was mangled on the way in, and this is the only place that answer survives.

`output_dimensions` is **not** debugging — it is the durable home of the `width` and `height` that `IrisResultSchema` promises Atlas, and `iris_runs` has no column for them (iris-03 decision 9). Omit it and the dimensions live only in the live HTTP response: correct on the day, and gone the moment the run is exported to D1 and pruned out of the DO. Atlas is then back to fetching and decoding the image to find out what it is placing, which is the exact cost those fields were added to avoid.

## Work

### Getting the motif in

- [x] Add a read function to `repository/r2.repository.ts` for fetching the motif. Handle both cases `motif_ref` can be: a URL, fetched over HTTP, and an R2 key. State in a comment which one Helios actually produces today and which is the fallback. Landed as `readMotif`, and the comment also carries the two-buckets trap from decision 4. (**Maaz Bin Asif**)
- [x] Fail clearly when the motif cannot be fetched, with a message naming the ref. A run that failed because a motif was missing must not look like a model failure. Four failure paths, each naming the ref: a non-2xx, a thrown fetch, a bucket miss, and an object that exists but holds zero bytes. The last one matters most, because empty bytes would otherwise reach the model as a valid-looking part and bill. (**Maaz Bin Asif**)
- [ ] Do this fetch **before** the model call and let a failure here happen before anything bills. Asserted in `colorizer.test.ts`, not just arranged. (**Maaz Bin Asif**)

### Reading the output's dimensions

The resize step is gone (decision 3). What replaced it is the opposite problem: getting the *output* size, which nothing reports.

- [x] Write `readJpegDimensions` in `src/services/imageDimensions.ts`: a pure scan of the JPEG segment headers to the first start-of-frame marker. No dependency, no binding, no network. (**Maaz Bin Asif**)
- [x] Throw, naming the reason, on a non-JPEG, a truncated stream, an absent frame header or a zero dimension. Never return a guess. A row reading 0x0 says the image is that size and is believed; a failed run says something went wrong, which is the useful one. (**Maaz Bin Asif**)
- [x] Test it against the real `fixtures/sample-colored.jpg` (128x128) as well as built headers. Two traps the fixture cannot catch on its own, because it is square: height precedes width in the frame header, and 0xC4/0xC8/0xCC sit inside 0xC0-0xCF without being frame markers. Both have a dedicated test and both were confirmed by mutation. (**Maaz Bin Asif**)

### The call

- [ ] Write `colorizeMotif`'s real body, calling `getImageToImageOutput` from iris-07. Do not build the multipart form here: that is the helper's job and duplicating it means two places to fix when the model changes. (**Ali Amir**)
- [ ] The prompt comes from `buildColorPrompt(params)` (decision 8). (**Ali Amir**)
- [ ] The model comes from `config.imageModel.model` (ADR-0008), never a literal. (**Ali Amir**)
- [ ] **Pass no gateway id** (decision 10), and put a comment at the call site saying why, pointing at `docs/ai-gateway-multipart-findings.md`. Without that comment the next reader sees an un-gatewayed call in a repo whose ADR-0006 says there is no such thing, and assumes it was an oversight. (**Ali Amir**)
- [ ] Set `skipCache` and carry `pipeline_id` in the gateway options anyway (decisions 2 and 10). Both are inert while there is no id — `buildAiRunOptions` returns `undefined` — and both are correct the day there is one. Do not assert on either in a test; there is nothing observable to assert. (**Ali Amir**)
- [ ] Call `readGatewayCost(env, "image")` immediately after the call returns. Expect `null` back today (decision 10). (**Ali Amir**)
- [ ] Read the returned image's real dimensions and return them (decision 9). If the model reports them, use that; otherwise read them from the bytes. Do not assume they match the input. (**Ali Amir**)
- [ ] Do **not** add a retry (decision 1). (**Ali Amir**)
- [ ] Do **not** save to R2 inside this service (decision 5). `runImageStage` calls `saveColoredImage`. (**Ali Amir**)

### The pipeline side

- [ ] Confirm `runImageStage` assigns the cost the moment the model returns, before the R2 save, so a save failure still records real spend (decision 7). This was already built in iris-05; verify it survived. (**Ali Amir**)
- [ ] Populate `model_metadata` with the shape above, all three dimension pairs included. (**Ali Amir**)
- [ ] Build the result's `width` and `height` by reading `output_dimensions` back out of the metadata you stored, rather than from the in-memory value the model call returned. The two should be identical, and if they ever are not, that is a bug you want failing in verification step 2 rather than surfacing months later as an Atlas placement that is quietly off. (**Ali Amir**)
- [ ] Update `pipeline.test.ts`'s fake `AI` binding: it now returns a plausible reply for both calls. Keep the assertion that no real network call happens. (**Ali Amir**)
- [ ] Add a test where the image call throws and assert: the run settles `failed`, the planner's params are still on the result rather than discarded, an image row exists and is `failed`, and `cost_usd` is null because nothing billed. (**Ali Amir**)
- [ ] Add a test where the image call succeeds but the R2 save throws, and assert `cost_usd` is **non-null** on the failed row. This is the exact scenario decision 7 exists for, and it is the one nobody writes a test for until money has already been lost. (**Ali Amir**)

### Review gates

- [ ] Look at at least five real outputs across different palettes and different motifs. Does the motif keep its shape, or does the model redraw it? iris-06 answered this once for one image; five is enough to know whether that answer holds. (**Maaz Bin Asif**)
- [ ] Confirm `input_dimensions` and `original_dimensions` are equal on a real row, and that `output_dimensions` is neither. With no resize the first two are the same pair by definition (decision 3); recording both anyway is what keeps the metadata shape stable for the day a resize lands. (**Maaz Bin Asif**)
- [ ] ~~Confirm the gateway log's cost matches `cost_usd` on the image row, for a real run.~~ **Blocked by decision 10** — this call does not route through the gateway, so there is no log row to compare against and `cost_usd` is null by construction. Reinstate this gate the day the gateway carries a multipart body. (**Maaz Bin Asif**)
- [ ] ~~Confirm `skipCache` is set, by running the same concept and motif twice and checking that two gateway log rows appear with two costs.~~ **Blocked by decision 10** — no gateway means no gateway cache, so there is nothing to skip and nothing to observe. Instead: confirm by reading the code that `skipCache` is passed, so it takes effect the day the id is. (**Maaz Bin Asif**)
- [ ] Confirm decision 3's rejected alternatives are named at the call site, not only in this ticket. If they are not, the next person adds a resize without knowing why there is none. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003 per call, so roughly 3 cents for the ten real runs the gates above need.** Keep it to that. Specifically:

- Debug the prompt with iris-04's harness, which costs nothing.
- Debug the dimension reading with unit tests on `readJpegDimensions`, which costs nothing.
- Debug the multipart shape against iris-07's fake, which costs nothing.
- Spend a real call only when all three of those are already right.

1. A real end-to-end run with a real Helios motif returns a colored image. Open the `image_url` and look at it.
2. `curl -s 'http://localhost:8787/runs' | jq '.runs[] | select(.modality=="image")'`. Confirm `image_r2_key` is set and `model_metadata` carries all three dimension pairs, `output_dimensions` included. **`cost_usd` will be `null`** — that is decision 10, not a failure, and the run must still be `completed` around it. Confirming that a null cost does not fail the run is the real check here.
3. ~~Run the same request twice and confirm two distinct gateway log rows with two costs.~~ **Blocked by decision 10**, no gateway log to read. Two real runs of the same input still return two different images, because there is no cache in front of a direct Workers AI call at all.
4. Send an oversized motif, at least 1024x1024, and confirm the call succeeds and the output is usable. This is decision 3 under test: the model is expected to downscale internally, iris-06 saw it do so once, and one confirmation at a realistic size is what turns that into something we rely on. If it fails here, decision 3 is wrong and the resize comes back.
5. Send a `motif_ref` that does not exist. Confirm the run fails **before** billing: `cost_usd` is null and, more to the point, no image row reaches `completed`. (Without a gateway log there is no external record to check the absence of a call against, so lean on the fact that the fetch happens before `ai.run`.)
6. `npm test --workspace=apps/agent-iris` passes.

## Two things that will waste your afternoon

**`PATTERNS` does not mean the same bucket in Iris as it does in Helios, and nothing in the code says so.** Iris's binding is `images-bucket`; Helios's, spelled identically, is `helios-bucket`. Hand Iris an R2 key that Helios wrote and you get a plain miss, so you go looking for a deleted object that was never there. `readMotif`'s error says this out loud for exactly that reason. Pass the URL Helios returned and the problem does not exist.

**The output size is not the input size, and assuming it is puts a wrong number on a permanent row.** iris-06 sent 640x640 and got 1024x1024 back. `model_metadata` is the only durable home those dimensions have (iris-03 decision 9), so a guess here is not a display bug, it is an audit row that lies to Atlas after the run is pruned. `readJpegDimensions` reads them from the returned bytes for this reason; do not shortcut it with the input's size or a constant.
