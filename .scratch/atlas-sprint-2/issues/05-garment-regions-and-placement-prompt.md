# atlas-05: Garment vocabulary and the placement prompt

**What to build:** the words Atlas uses to describe a garment to the image model. A glossary giving every garment type and every region a real description, and `buildPlacementPrompt`, which turns an `AtlasPlacement` into the prompt string, deterministically.

**Objective:** Atlas has no text model. Nothing interprets the caller's request into richer language, so whatever this file writes is exactly what the image model sees. That makes the prompt the entire creative surface of the engine, and it makes an incomplete vocabulary a silent failure: a garment type with no description reaches the model as a bare enum value like `kurta`, and the output is whatever the model happens to associate with that word. This ticket is where that gap is closed, and where the wording is decided once rather than being tuned inside an expensive ticket. The call also sends a real photo of the garment alongside the pattern (`garment_ref`, added after this ticket was first written), so the prompt now has a second job: telling the model, in words, which of the two input images is which.

**Final result:** `buildPlacementPrompt(placement)` returns a complete, readable instruction naming the garment, the regions, the coverage style and the pattern scale, with no gaps and no model-facing enum values. Adding a garment type without describing it is a compile error rather than a bad image.

**Blocked by:** atlas-01, for the enums this glossary is keyed on. The final wording also needs atlas-03's findings, so the structure lands first and the wording box waits; do not let that hold up the rest of the file.

**Status:** ready-for-human, for the structure.

**Owner:** M. Subhan. **Reviewer:** Maaz Ahmad.

**Duration:** 1 day. **Scheduled:** Mon Aug 24 to Mon Aug 24.

## Read this first

- `.scratch/iris-sprint-2/issues/04-color-vocabulary-and-planner-prompt.md`. Same shape of job for the other engine, including the compile-error-on-a-missing-entry trick this ticket copies. Read it before starting.
- `apps/agent-helios/src/prompts/image.prompt.ts` and `buildImagePrompt`. That function is the model this one follows: a deterministic translator with no design judgement in it.
- `.scratch/atlas-sprint-2/issues/03-garment-placement-probe.md`, "What we found". Whether the plain-words prompt worked, whether swapping the two input images broke the output, and what changed the output, all come from there.
- `packages/shared-types/src/v1/atlas.ts` from atlas-01, for the enums.

## Decisions

1. **`buildPlacementPrompt` is a deterministic translator, not a place for judgement.** Same input, same string, every time. No randomness, no branching on anything outside the `AtlasPlacement` it is given, no reading config or env. This is what makes a bad output attributable: if two runs with the same placement produce different images, that is the model, not us.
2. **The glossary is typed as a complete `Record`, so a missing entry does not compile.** `Record<GarmentType, GarmentGloss>` and `Record<GarmentRegion, RegionGloss>`. Adding a value to the enum in atlas-01 without describing it here becomes a TypeScript error rather than a bare enum value reaching the model. This is the same trick iris-04 uses for colors and it is the whole reason the glossary is a typed object rather than a lookup with a fallback.
3. **No fallback, no default description, no `?? name`.** A fallback is what turns decision 2 back off. If something is missing, the build should stop.
4. **The prompt names the garment explicitly and in full, and also names which input image is which.** The real garment photo anchors shape and texture, but the model still needs the words: which of the two images is the pattern to apply and which is the garment to apply it to, and what garment that second image shows. A prompt that says "apply this pattern to the back and hem" without saying which image is the garment risks the model treating both images as equally negotiable.
5. **The prompt is versioned, and the version travels onto the row.** `PLACEMENT_PROMPT_VERSION`, currently `atlas-placement-v1`, written into `AtlasPlacement.prompt_version` and therefore into `garment_regions` on every row. When outputs change quality, the first question is what the prompt was, and this is the only place that answer survives.
6. **Regions are listed in a fixed order regardless of the order they arrive in.** `["hem", "back"]` and `["back", "hem"]` must produce the same string. Otherwise two identical requests produce two different prompts, two different gateway cache keys, and an apparent model inconsistency that is actually ours.
7. **Prompt wording is tuned against atlas-03's findings and atlas-07's harness, not by spending calls in this ticket.** The structure, the glossary and the tests are free. If a real call is needed to settle wording, it comes out of atlas-07's budget and is noted as such.
8. **This file holds prompt text and nothing else.** No model call, no config read, no R2. It lives in `prompts/` per `docs/directory-structure.md`, and atlas-07 imports it.

## Agreed shapes, do not invent your own

```ts
// apps/agent-atlas/src/prompts/garment.glossary.ts

interface GarmentGloss {
  /** How the garment is described to the model. A full noun phrase, not the
   *  enum value. The model never sees the word "tshirt". */
  description: string;
  /** Which regions actually exist on this garment. Asking for a sleeve on a
   *  scarf is a request the model cannot satisfy, and it degrades the whole
   *  output rather than being ignored. */
  validRegions: GarmentRegion[];
}

/** Complete by construction: a garment type with no entry is a compile error
 *  (decision 2). Do not add a fallback. */
export const GARMENT_GLOSSARY: Record<GarmentType, GarmentGloss> = { ... };

interface RegionGloss {
  /** How this area is described to the model, in plain words. */
  description: string;
  /** Sort position, so region order in the prompt is stable (decision 6). */
  order: number;
}

export const REGION_GLOSSARY: Record<GarmentRegion, RegionGloss> = { ... };
```

```ts
// apps/agent-atlas/src/prompts/placement.prompt.ts

export const PLACEMENT_PROMPT_VERSION = "atlas-placement-v1";

/** Deterministic. Same placement in, same string out, always. */
export function buildPlacementPrompt(placement: AtlasPlacement): string;

/** Which of the requested regions this garment actually has. atlas-06 calls
 *  this before running, so an impossible request is refused rather than
 *  half-satisfied by a billed call. */
export function validRegionsFor(
  garment: GarmentType,
  requested: GarmentRegion[]
): { valid: GarmentRegion[]; rejected: GarmentRegion[] };
```

## Work

### The glossary

- [ ] Write `prompts/garment.glossary.ts` with both records, typed as complete `Record`s (decision 2). (**M. Subhan**)
- [ ] Give all five garment types a full description. Not "tshirt" but something a model can render, naming the cut and the shape. These five phrases are the entire garment vocabulary of the engine. (**M. Subhan**)
- [ ] Give all five regions a description in plain words, plus a stable `order` (decision 6). (**M. Subhan**)
- [ ] Fill in `validRegions` for each garment honestly. A scarf has no sleeve and no neck; a hoodie has all five. Getting this wrong means a request that cannot be satisfied still bills. (**M. Subhan**)
- [ ] Do **not** add a fallback, a default, or a `??` anywhere in the lookups (decision 3). (**M. Subhan**)

### The builder

- [ ] Write `prompts/placement.prompt.ts` with `buildPlacementPrompt` and `validRegionsFor`. (**M. Subhan**)
- [ ] The prompt names the garment in full before it names anything else (decision 4). (**M. Subhan**)
- [ ] Sort regions by `order` before writing them into the string, never by the order they arrived in (decision 6). (**M. Subhan**)
- [ ] Translate `coverage` and `pattern_scale` into words, not enum values. `"trim"` becomes something like "as a narrow border", not the word `trim`. (**M. Subhan**)
- [ ] Say explicitly, in the prompt, that the first supplied image is the pattern to apply and not the thing to redraw, and that the second supplied image is the actual garment to render it onto, not a hint to redraw a similar-looking one. atlas-03 is the ticket that tells you whether this is needed and in what words; if its findings say the model confuses the two images or redraws the pattern, this line is the first thing to fix. (**M. Subhan**)
- [ ] Export `PLACEMENT_PROMPT_VERSION` and make sure atlas-06 writes it into `AtlasPlacement.prompt_version`. Bump it whenever the wording changes, in the same commit as the wording. (**M. Subhan**)
- [ ] Do **not** read config, env, or anything else from inside this file (decision 8). (**M. Subhan**)
- [ ] Do **not** make a model call from this ticket (decision 7). (**M. Subhan**)

### Tests

- [ ] Write `prompts/placement.prompt.test.ts`. Cover: the same placement producing a byte-identical string twice; two region arrays in different orders producing the same string; every garment type producing a string that contains its description; and every coverage and scale value producing distinguishable output. (**M. Subhan**)
- [ ] Test `validRegionsFor` rejects a sleeve on a scarf and keeps everything valid on a hoodie. (**M. Subhan**)
- [ ] **Prove the compile-error property.** Delete one entry from `GARMENT_GLOSSARY`, run `npx tsc --noEmit`, confirm it fails, then put it back. Note in the pull request that you did this. A type that is supposed to catch something and has never been seen catching it is a type nobody trusts. (**M. Subhan**)

### Review gates

- [ ] Read the five garment descriptions as prompt text, out of context, and ask whether each one describes something specific enough to render. "A shirt" is not; "a plain crew-neck short-sleeved t-shirt, laid flat, front-facing" is. (**Maaz Ahmad**)
- [ ] Confirm no enum value can reach the model as a bare word. Grep the built prompt for `tshirt`, `allover` and `hem` on a real call and confirm they do not appear. (**Maaz Ahmad**)
- [ ] Confirm the glossary has no fallback path (decision 3). (**Maaz Ahmad**)
- [ ] Confirm the region-order test exists and would actually fail if the sort were removed. Delete the sort, watch it go red, put it back. (**Maaz Ahmad**)
- [ ] Confirm `prompt_version` is exported and reaches the row, rather than only existing in this file. (**Maaz Ahmad**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** Everything here is a pure function over strings. If wording genuinely needs a real call to settle, take it from atlas-07's budget and say so.

1. `npm test --workspace=apps/agent-atlas` passes, including the determinism and ordering tests.
2. Print the built prompt for all five garment types to the console and read them. They should read like instructions to a person, not like serialized JSON.
3. Delete a glossary entry, confirm `npx tsc --noEmit` fails, put it back.
4. Build the prompt for `{ regions: ["hem","back"] }` and `{ regions: ["back","hem"] }` and confirm the two strings are identical.

## Two things that will waste your afternoon

**A `Record<GarmentType, T>` written as `Partial<Record<...>>` or with an index signature silently turns off the only guarantee in this ticket.** It compiles, the tests pass, and a missing entry becomes `undefined` at runtime, which reaches the model as the word "undefined" in the prompt. Verification step 3 is what proves the type is doing its job, so do it once and say you did.

**Tuning prompt wording by making real calls is slow and expensive, and it is not how this file gets good.** Atlas has one billable call and no cheap iteration loop, so a wording change costs $0.003 to evaluate and the result is not deterministic anyway. Settle the structure and the vocabulary here for free, and change wording only in response to a specific finding from atlas-03 or a specific bad output from atlas-07.
