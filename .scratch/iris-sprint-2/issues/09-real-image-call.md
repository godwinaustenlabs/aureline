# iris-09: The real image call, painting the palette onto the motif

**What to build:** replace iris-05's fake `colorizeMotif` with a real image-to-image call that takes Helios's black-and-white motif plus the palette from iris-08 and returns a colored version. Includes fetching the motif, resizing it to fit the model's input limit, and recording the real cost.

**Objective:** this is the ticket that makes Iris actually do its job. It is also the only expensive part of the engine, the only part with a hard input constraint we do not control, and the only part that cannot be retried automatically. All three of those are why it is last in the model sequence and why the resize step is called out as real plumbing rather than an edge case.

**Final result:** `POST /generate` with a real concept and a real Helios motif returns a colored version of that motif, stored in R2 and served over a URL, with the real dollar cost recorded on the image row.

**Blocked by:** iris-05 (the pipeline), iris-07 (the multipart helper), iris-08 (real params to color with).

**Status:** blocked, waiting on iris-07.

**Owner:** Ali Amir. **Reviewer:** Maaz Bin Asif.

**Duration:** 2 days. **Scheduled:** Tue Sep 1 to Wed Sep 2.

## Read this first

- `apps/agent-helios/src/services/imageGenerator.ts` (104 lines). The reference for this file's discipline: it returns raw bytes only, it does not know R2 exists, it clamps a model parameter to the model's real cap, it skips the gateway cache, and it rejects an over-long prompt **before** billing.
- `apps/agent-helios/src/services/pipeline.ts:112-162`, `runImageStage`. This is the function whose body you are filling in, and its comments explain why an image row is always left behind.
- `.scratch/iris-sprint-2/issues/06-flux-2-klein-probe.md`, "What we found". The confirmed request shape, the confirmed size limit, and the confirmed oversized-input behaviour all come from there.
- ADR-0009 for why this call never auto-retries.

## Decisions

1. **This call never retries automatically** (ADR-0009). It is expensive and one-shot, and a failure is very likely to fail the same way again. A person triggers a retry through `POST /resume`, which iris-10 builds. If you feel the urge to add a retry here, that urge is what ADR-0009 was written to answer.
2. **Skip the gateway cache for this call.** `getImageModelOutput` defaults to a one-hour cache because the cache key covers the model inputs, which means the same concept and the same motif would return the same image rather than a new attempt. For a resume to mean anything, the call has to actually run. Helios's `generateImage` sets `skipCache` for exactly this reason.
3. **Resize the motif before sending it, and reject rather than guess if resizing is impossible.** The model has a hard input dimension limit and Helios's motifs are very likely larger. The resize is a real step with real behaviour to decide, not something to discover at the call site.
4. **Fetch the motif through the repository layer, not with a bare `fetch`.** `motif_ref` may be an R2 key belonging to Helios's bucket or a URL. Whichever it is, reading it goes through a named function in `repository/`, because `repository/` is the only code allowed to touch storage and because the two cases need different handling.
5. **`colorizeMotif` returns bytes and dimensions, and does not know R2 exists.** The pipeline saves. Same separation as Helios, and it is what lets the service be tested without a bucket.
6. **Read the cost immediately after the call**, with the same `readGatewayCost(env, "image")` iris-08 ported. Its three read attempts exist specifically for this stage: for an image model the gateway fills in `cost` after the response has already come back, so a read on the next line finds the row present and the cost absent. That happened to a real Helios production run.
7. **Record the cost even when a later step fails.** The call bills before the R2 save and the row update. `runImageStage` assigns `costUsd` the moment the model returns, so the catch reports what was actually spent rather than null.
8. **The prompt comes from `buildColorPrompt`, unchanged.** No prompt text in this file. If the output looks wrong because of wording, that is iris-04's file to change, and its version id changes with it.
9. **`width` and `height` on the result are the colored image's real dimensions**, not the motif's and not a hardcoded pair. Atlas reads them to know what it is placing.

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
  p_invoc_id: string
): Promise<{
  image: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  cost_usd: number | null;
}>;

/** Clamps to the model's real input limit, the way resolveSteps clamps to
 *  Flux Schnell's cap of 8. Returns the target dimensions, preserving aspect. */
export function resolveInputSize(width: number, height: number): { width: number; height: number };
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

- [ ] Add a read function to `repository/r2.repository.ts` for fetching the motif. Handle both cases `motif_ref` can be: a URL, fetched over HTTP, and an R2 key. State in a comment which one Helios actually produces today and which is the fallback. (**Ali Amir**)
- [ ] Fail clearly when the motif cannot be fetched, with a message naming the ref. A run that failed because a motif was missing must not look like a model failure. (**Ali Amir**)
- [ ] Do this fetch **before** the model call and let a failure here happen before anything bills. (**Ali Amir**)

### The resize step

- [ ] Pick how the resize happens and write down why in a comment. The options are Cloudflare Images through a binding or a URL transform, `fetch` with `cf.image` resize options, or a pure-JS resize. Workers have no `sharp`, so anything assuming a Node image library will not run. Whatever you pick, name the rejected alternatives in the comment. (**Ali Amir**)
- [ ] Write `resolveInputSize`, clamping to iris-06's confirmed limit while preserving aspect ratio. Do not stretch the motif to a square: a distorted motif produces a distorted colored output and the distortion looks like a model problem. (**Ali Amir**)
- [ ] Skip the resize entirely when the motif is already within the limit. Re-encoding a small image costs quality for nothing. (**Ali Amir**)
- [ ] Test `resolveInputSize` as a pure function: a landscape motif, a portrait one, a square one, one already under the limit, and one exactly at it. Whether the bound is inclusive or exclusive comes from iris-06; match it. (**Ali Amir**)
- [ ] If the resize needs a config value (a target size, or which resize backend), add it to `config.ts`'s `FIELDS` with a `wrangler.jsonc` fallback. Do not hardcode it and do not read `env` directly outside `config.ts`. (**Ali Amir**)

### The call

- [ ] Write `colorizeMotif`'s real body, calling `getImageToImageOutput` from iris-07. Do not build the multipart form here: that is the helper's job and duplicating it means two places to fix when the model changes. (**Ali Amir**)
- [ ] The prompt comes from `buildColorPrompt(params)` (decision 8). (**Ali Amir**)
- [ ] The model comes from `config.imageModel.model` (ADR-0008), never a literal. (**Ali Amir**)
- [ ] Set `skipCache` on the gateway options (decision 2). Without it, a resume returns the cached first attempt and looks like the model ignored you. (**Ali Amir**)
- [ ] Carry `p_invoc_id` in the gateway metadata, same as the text call. (**Ali Amir**)
- [ ] Call `readGatewayCost(env, "image")` immediately after the call returns. (**Ali Amir**)
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
- [ ] Compare `input_dimensions` against `original_dimensions` on a real row and confirm the resize did what `resolveInputSize` says it should. (**Maaz Bin Asif**)
- [ ] Confirm the gateway log's cost matches `cost_usd` on the image row, for a real run. (**Maaz Bin Asif**)
- [ ] Confirm `skipCache` is set, by running the same concept and motif twice and checking that two gateway log rows appear with two costs. If the second is free, the cache is on and resume will not work. (**Maaz Bin Asif**)
- [ ] Confirm the comment in the resize step names the alternatives that were rejected. If it does not, the next person will pick differently and neither will know why. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003 per call, so roughly 3 cents for the ten real runs the gates above need.** Keep it to that. Specifically:

- Debug the prompt with iris-04's harness, which costs nothing.
- Debug the resize with unit tests on `resolveInputSize`, which costs nothing.
- Debug the multipart shape against iris-07's fake, which costs nothing.
- Spend a real call only when all three of those are already right.

1. A real end-to-end run with a real Helios motif returns a colored image. Open the `image_url` and look at it.
2. `curl -s 'http://localhost:8787/runs' | jq '.runs[] | select(.modality=="image")'`. Confirm `cost_usd` is a real number, `image_r2_key` is set, and `model_metadata` carries all three dimension pairs, `output_dimensions` included.
3. Run the same request twice and confirm two distinct gateway log rows with two costs (the `skipCache` check).
4. Send an oversized motif and confirm the resize handled it rather than the model rejecting it.
5. Send a `motif_ref` that does not exist. Confirm the run fails **before** billing: the gateway log gets no new row, and `cost_usd` is null.
6. `npm test --workspace=apps/agent-iris` passes.

## Two things that will waste your afternoon

**The gateway cache is on by default for image calls and it will convince you the model is broken.** You change the prompt, run the same concept, and get a byte-identical image back. Nothing is wrong with the model; the cache key covers the inputs and your inputs did not change enough. `skipCache` is not an optimisation to add later, it is required for this stage to be developable at all.

**A distorted input produces a distorted output, and it reads as a model failure.** If you resize by forcing the motif into a square, every colored result comes back subtly stretched and you will spend the afternoon on the prompt. `resolveInputSize` preserves aspect ratio for this reason, and recording both dimension pairs in `model_metadata` is what lets you rule this out in ten seconds instead of an hour.
