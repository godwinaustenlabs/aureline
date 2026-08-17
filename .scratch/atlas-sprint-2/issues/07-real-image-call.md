# atlas-07: The real image call, placing the pattern on the garment

**What to build:** replace atlas-06's fake `placePattern` with a real image-to-image call that takes Iris's colored pattern, a real photo of the garment (`garment_ref`), and the placement instruction, and returns that same garment carrying that pattern. Includes fetching both input images, resizing each to fit the model's input limit, and recording the real cost.

**Objective:** this is the ticket that makes Atlas actually do its job, and it is the whole of Atlas's spend. It is also the only part with a hard input constraint we do not control and the only part that cannot be retried automatically, which is why the probe, the prompt and the pipeline all land before it.

**Final result:** `POST /generate` with a real Iris pattern and a garment returns an image of that garment carrying that pattern, stored in R2 and served over a URL, with the real dollar cost on the row.

**Blocked by:** atlas-03 (does this work at all), atlas-06 (the pipeline), iris-07 (`getImageToImageOutput`).

**Status:** blocked, waiting on iris-07 and atlas-03.

**Owner:** M. Subhan. **Reviewer:** Ali Amir.

## Read this first

- `.scratch/atlas-sprint-2/issues/03-garment-placement-probe.md`, "What we found". The working prompt, the real cost, and whether the cost needs a retried read all come from there. If that section is empty, this ticket is not ready.
- `.scratch/iris-sprint-2/issues/09-real-image-call.md`. Iris's version of this ticket, which lands first. Its resize reasoning, its `skipCache` reasoning and its cost-timing reasoning all apply here unchanged, so read it rather than re-deriving them.
- `apps/agent-helios/src/services/imageGenerator.ts` (104 lines). The reference for this file's discipline: raw bytes only, no knowledge of R2, clamps a model parameter to the model's real cap, skips the gateway cache, and rejects an over-long prompt **before** billing.
- `packages/shared-utils/src/getImageToImageOutput.ts` from iris-07, and its tests.
- ADR-0009 and `ADR-ATLAS-0001` for why this call never auto-retries.

## Decisions

1. **This call never retries automatically** (ADR-0009). It is expensive, one-shot, and a failure is very likely to fail the same way again. A person triggers a retry through `POST /resume`, which atlas-08 builds. For Atlas this is stronger than for Iris: the image call is the entire engine, so an auto-retry here doubles the cost of literally every failure.
2. **Skip the gateway cache for this call.** The cache key covers the model inputs, so the same pattern and the same garment would return the same image rather than a new attempt, and a resume would return the first attempt while still billing. Helios's `generateImage` sets `skipCache` for exactly this reason.
3. **Use `getImageToImageOutput` from `packages/shared-utils` unchanged. Do not modify it and do not write a second one.** Iris built it, Atlas is its second consumer, and that is the design. If it cannot express something Atlas needs, that is a finding to raise in the group, not a patch: a shared package changing mid-sprint is the change most likely to conflict between squads, and iris-07's review gate already asked the Atlas manager to catch this in advance.
4. **Two input images: `input_image_0` the colored pattern, `input_image_1` the garment photo the caller supplied as `garment_ref`.** This reverses the plan's original call of "no garment image, the garment comes from the prompt alone", decided later once a real anchor image proved worth having. The garment is still named in words too, atlas-05's prompt still states type, regions, coverage and scale, but the model now has both a picture and an instruction rather than an instruction alone. The helper takes an array of up to four images; pass two, in this order. Order matters: atlas-05's prompt text refers to "the first image" and "the second image", so `input_image_0` must always be the pattern and `input_image_1` must always be the garment, never swapped.
5. **Resize both input images before sending, each preserving its own aspect ratio.** The model has a hard input dimension limit, and both Iris's pattern output and a caller-uploaded garment photo are very likely larger than it. Resize the two independently; do not assume they share a source size or an aspect ratio. Do not stretch either to a square: a distorted pattern or a distorted garment reads as a model problem when it is really the resize.
6. **Fetch both images through the repository layer, not with a bare `fetch`.** `pattern_ref` may be a URL or an R2 key. Since iris-02 and atlas-02, Iris and Atlas share one bucket (`images-bucket`), so an R2 key just needs the `iris/` prefix to be readable from Atlas's own `PATTERNS` binding, no cross-bucket access required. `garment_ref` is always a URL, since there is no upload endpoint in this sprint (atlas-01 decision 6). Either way, reading either one goes through a named function in `repository/`, because `repository/` is the only code allowed to touch storage, even for a URL that never touches R2.
7. **`placePattern` returns bytes and dimensions and does not know R2 exists.** The pipeline saves. Same separation as both other engines, and it is what lets the service be tested without a bucket.
8. **Read the cost immediately after the call**, with the same `readGatewayCost(env, "image")` Helios uses. Its retried reads exist specifically for this: an image model's gateway log row appears before its `cost` field is filled in, and a read on the next line finds the row present and the cost absent. That happened to a real Helios production run. atlas-03 records whether this model behaves the same way; match what it found.
9. **Record the cost even when a later step fails.** The call bills before the R2 save and the row update. `runImageStage` assigns the cost the moment the model returns, so the catch reports what was actually spent rather than null.
10. **The prompt comes from `buildPlacementPrompt`, unchanged.** No prompt text in this file. If the output looks wrong because of wording, that is atlas-05's file to change, and `PLACEMENT_PROMPT_VERSION` changes with it.
11. **`width` and `height` on the result are the output image's real dimensions**, not the pattern's and not a hardcoded pair.

## Agreed shapes, do not invent your own

```ts
// apps/agent-atlas/src/services/placer.ts
// Signature unchanged from atlas-06's fake. Returns raw bytes. Knows nothing
// about R2.
export async function placePattern(
  patternRef: string,
  garmentRef: string,
  placement: AtlasPlacement,
  config: AtlasConfig,
  env: Env,
  p_invoc_id: string
): Promise<{
  image: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  cost_usd: number | null;
}>;

/** Clamps to the model's real input limit, preserving aspect ratio. Same job as
 *  iris-09's resolveInputSize; if that one is exported from shared-utils by the
 *  time this lands, use it rather than writing a second copy. */
export function resolveInputSize(width: number, height: number): { width: number; height: number };
```

What lands in the row's `model_metadata`:

```jsonc
{
  "model": "@cf/black-forest-labs/flux-2-klein-9b",
  "prompt_version": "atlas-placement-v1",
  "pattern_input_dimensions": { "width": 480, "height": 480 },
  "pattern_original_dimensions": { "width": 1024, "height": 1024 },
  "garment_input_dimensions": { "width": 480, "height": 320 },
  "garment_original_dimensions": { "width": 2048, "height": 1365 }
}
```

All four dimension pairs are recorded deliberately, two per input image. When an output looks wrong, the first question is whether one of the inputs was mangled on the way in, and this is the only place that answer survives. The `pattern_*`/`garment_*` prefixes exist because there are now two images to account for, not one; do not collapse them back to a single `input_dimensions`/`original_dimensions` pair, that would only ever describe whichever image was resized last.

## Work

### Getting the images in

- [ ] Add a read function to `repository/r2.repository.ts` for fetching the pattern. Handle both cases `pattern_ref` can be: a URL fetched over HTTP, and an R2 key. State in a comment which one Iris actually produces today and which is the fallback. (**M. Subhan**)
- [ ] Add a second read function for fetching `garment_ref`. Unlike the pattern fetch, this one only ever handles a URL: `garment_ref` is validated with `.url()` in atlas-01 because there is no upload endpoint in this sprint, so nothing ever hands Atlas an R2 key for it. Do not write an R2 branch for it that can never run. (**M. Subhan**)
- [ ] Fail clearly when either image cannot be fetched, with a message naming the ref and saying which one it was. A run that failed because a pattern or a garment reference was missing must not look like a model failure, and an unfetchable pattern is the failure most likely to actually happen, because it depends on another engine's storage; an unfetchable garment reference is now just as real a possibility. (**M. Subhan**)
- [ ] Do both fetches **before** the model call, so a failure in either happens before anything bills. (**M. Subhan**)

### The resize

- [ ] Check whether iris-09 exported a reusable resize. If it did, use it. If it did not, write `resolveInputSize` here and say in a comment that the duplication is known and which ticket would consolidate it. Do not silently write a second copy. (**M. Subhan**)
- [ ] Clamp both images to the limit iris-06 confirmed, each preserving its own aspect ratio (decision 5). Call `resolveInputSize` once per image; do not assume one call's result applies to both. (**M. Subhan**)
- [ ] Skip the resize for whichever image is already within the limit. Re-encoding a small image costs quality for nothing, and there is no reason to assume the pattern and the garment photo are ever the same size. (**M. Subhan**)
- [ ] Test `resolveInputSize` as a pure function: landscape, portrait, square, already under the limit, and exactly at it. Whether the bound is inclusive or exclusive comes from iris-06; match it. (**M. Subhan**)
- [ ] Note that Workers have no `sharp`. Anything assuming a Node image library will not run. iris-09 already picked an approach; use the same one and say so rather than picking a second. (**M. Subhan**)

### The call

- [ ] Write `placePattern`'s real body, calling `getImageToImageOutput` with two input images in order, pattern first and garment second (decisions 3 and 4). Do not build the multipart form here: that is the helper's job. (**M. Subhan**)
- [ ] The prompt comes from `buildPlacementPrompt(placement)` (decision 10). No prompt text in this file. (**M. Subhan**)
- [ ] The model comes from `config.imageModel.model` (ADR-0008), never a literal. (**M. Subhan**)
- [ ] Set `skipCache` on the gateway options (decision 2). Without it, a resume returns the cached first attempt and looks like the model ignored you. (**M. Subhan**)
- [ ] Carry `p_invoc_id` in the gateway metadata so the log row is findable. (**M. Subhan**)
- [ ] Call `readGatewayCost(env, "image")` immediately after the call returns (decision 8). (**M. Subhan**)
- [ ] Read the output image's real dimensions and return them (decision 11). If the model reports them, use that; otherwise read them from the bytes. Do not assume they match the input. (**M. Subhan**)
- [ ] Do **not** add a retry (decision 1). (**M. Subhan**)
- [ ] Do **not** save to R2 inside this service (decision 7). `runImageStage` calls `saveGarmentImage`. (**M. Subhan**)
- [ ] Do **not** modify `getImageToImageOutput` or anything else in `packages/shared-utils`. `git diff --stat` on this ticket should show no file outside `apps/agent-atlas/`. (**M. Subhan**)

### The pipeline side

- [ ] Confirm `runImageStage` assigns the cost the moment the model returns, before the R2 save, so a save failure still records real spend (decision 9). atlas-06 built this; verify it survived. (**M. Subhan**)
- [ ] Populate `model_metadata` with the shape above, all four dimension pairs included. (**M. Subhan**)
- [ ] Update `pipeline.test.ts`'s fake `AI` binding so it returns a plausible reply. Keep the assertion that no real network call happens. (**M. Subhan**)
- [ ] Add a test where the image call throws and assert: the run settles `failed`, the placement is still recorded on the row rather than discarded, and `cost_usd` is null because nothing billed. (**M. Subhan**)
- [ ] Add a test where the image call succeeds but the R2 save throws, and assert `cost_usd` is **non-null** on the failed row. This is the exact scenario decision 9 exists for, and it is the one nobody writes a test for until money has already been lost. (**M. Subhan**)
- [ ] Add a test where fetching the pattern fails, and assert the fake `AI` binding was **never called**. A run that failed on a missing input must not have billed. (**M. Subhan**)
- [ ] Add the same test for `garment_ref`: fetching it fails, and the fake `AI` binding was never called. This is the newer of the two fetches and it is exactly as capable of failing as the pattern fetch is. (**M. Subhan**)

### Review gates

- [ ] Look at at least six real outputs across different garments and different coverage styles. Does the pattern stay recognisably the one we sent, and does the output stay recognisably **the actual garment photo we sent as `garment_ref`**, not just a garment of the right type? atlas-03 answered this for a couple of cases; this is where it gets answered for the vocabulary. (**Ali Amir**)
- [ ] Compare each `*_input_dimensions` against its matching `*_original_dimensions` on a real row and confirm the resize did what `resolveInputSize` says it should, for both the pattern and the garment reference. (**Ali Amir**)
- [ ] Confirm the gateway log's cost matches `cost_usd` on the row, for a real run. (**Ali Amir**)
- [ ] Confirm `skipCache` is set, by running the same request twice and checking two gateway log rows appear with two costs. If the second is free, the cache is on and resume will not work. (**Ali Amir**)
- [ ] Confirm nothing under `packages/` changed (decision 3). (**Ali Amir**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003 per call, so roughly two cents for the six real runs the gates need.** Keep it to that. Specifically:

- Debug the prompt against atlas-05's tests, which cost nothing.
- Debug the resize with unit tests on `resolveInputSize`, which cost nothing.
- Debug the multipart shape against iris-07's fake, which costs nothing.
- Spend a real call only when all three are already right.

1. A real end-to-end run with a real Iris pattern returns a garment image. Open the `image_url` and look at it.
2. `curl -s 'http://localhost:8787/runs' | jq '.runs[0]'`. Confirm `cost_usd` is a real number, `image_r2_key` is set, `garment_regions` carries the placement, `garment_ref` is the reference you sent, and `model_metadata` has all four dimension pairs.
3. Run the same request twice and confirm two distinct gateway log rows with two costs (the `skipCache` check).
4. Send an oversized pattern and an oversized garment photo together and confirm the resize handled both rather than the model rejecting either.
5. Send a `pattern_ref` that does not exist. Confirm the run fails **before** billing: no new gateway log row, and `cost_usd` null.
6. Send a valid `pattern_ref` but a `garment_ref` that does not exist. Confirm the same: fails before billing, no new gateway log row, `cost_usd` null.
7. `npm test --workspace=apps/agent-atlas` passes.

## Two things that will waste your afternoon

**The gateway cache is on by default for image calls and it will convince you the model is broken.** You change the prompt, run the same request, and get a byte-identical image back. Nothing is wrong with the model; the cache key covers the inputs and your inputs did not change enough. `skipCache` is not an optimisation to add later, it is required for this stage to be developable at all.

**Getting the image order backwards is invisible in the code and obvious in the output.** `getImageToImageOutput` takes an array; swapping `patternRef`'s bytes and `garmentRef`'s bytes when building it compiles, typechecks, and calls the model successfully. What comes back is the model doing its best to print a garment photo onto a pattern, or something equally wrong, and it looks like a model failure rather than an ordering bug. `input_image_0` is always the pattern, `input_image_1` is always the garment; atlas-03's image-order-swap finding is what proves this actually matters for this model, so read it before assuming it does not.
