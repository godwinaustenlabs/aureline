# iris-07: A shared-utils helper for image-to-image calls

**What to build:** one new export in `packages/shared-utils`, `getImageToImageOutput`, that calls a model with a prompt **and** an input image and returns the resulting image bytes. Plus its tests.

**Objective:** every model-calling helper in this repo assumes a plain JSON request body, because until now every model call has had one. `getTextualModelOutput` sends Chat Completions JSON and `getImageModelOutput` sends `{ prompt, ...input }`. Neither can send an image, and the model that can accept one wants multipart form data instead. Iris needs this, and Atlas needs the same thing for its own image call, so it is built once here rather than twice in two apps. It is also the one place in this sprint where the two squads' work genuinely overlaps, since everything else lives in its own `apps/` folder.

**Final result:** `getImageToImageOutput` exists, is exported from the package barrel, is covered by tests that need no network, and is the only thing either engine needs in order to send a model an existing image.

**Blocked by:** iris-06. Do not write this against an inferred request shape. The whole point of iris-06 is that the shape below is currently a guess.

**Status:** blocked, waiting on iris-06.

**Owner:** Arham Zahid. **Reviewer:** Maaz Bin Asif.

**Duration:** 2 days. **Scheduled:** Tue Aug 25 to Wed Aug 26.

## Read this first

- `packages/shared-utils/src/getImageModelOutput.ts` (69 lines). Read it fully. It is the closest sibling to what you are writing, and its base64 decode and its error message are both worth copying rather than reinventing.
- `packages/shared-utils/src/aiGateway.ts` (70 lines), specifically `buildAiRunOptions` and the reason it returns `undefined` when there is no gateway id.
- `packages/shared-utils/src/getTextualModelOutput.ts` (268 lines), for how the retry loop distinguishes a schema failure from a call failure. You will not need the schema half, but you will need the same distinction in the error you throw.
- `.scratch/iris-sprint-2/issues/06-flux-2-klein-probe.md`, the "What we found" section. That is the specification for this ticket. If it is not filled in, this ticket is not ready.
- `docs/sprint-2-3-conventions.md`, "Shared packages", for the rule that additions here are reviewed by whichever manager did not write them.

## Decisions

1. **A new export, not a change to either existing helper.** `getImageModelOutput` and `getTextualModelOutput` are both load-bearing for Helios, which is deployed and working. Adding a third function is additive and cannot break Helios; adding a branch inside `getImageModelOutput` can. `docs/sprint-2-3-conventions.md` states this rule for shared packages generally: add a new exported item rather than changing the shape of something Helios still depends on.
2. **The helper returns raw bytes and dimensions, and knows nothing about R2, Iris, or Atlas.** Same discipline as `getImageModelOutput`, and the same reason `imageGenerator.ts` in Helios does not know R2 exists. A helper that knows where the image goes cannot be reused by the other engine.
3. **The helper does not read the gateway cost.** Cost is read by the caller, immediately after the call, because `aiGatewayLogId` holds only the most recent routed call on the binding. A helper that read it internally would work, right up until a caller made two calls and the second one's read returned the first one's cost.
4. **The helper does not resize the input image.** It validates the size and throws if it is too large, but resizing is the caller's job. iris-09 owns the resize step. Two reasons: resizing needs an image library the shared package should not depend on, and a helper that silently downscales its input hides a real decision.
5. **Validate the input image size before calling, not after.** The call bills. A request that was always going to be rejected must not be able to spend money. `imageGenerator.ts` does the same thing for an over-long prompt: rejects it before billing.
6. **The retry behaviour is: none.** This is an expensive one-shot call. Retrying it doubles the spend on a failure that will very likely fail again the same way. ADR-0009 already settled that an image call never auto-retries; the helper must not quietly reintroduce it. `getTextualModelOutput`'s `maxRetries` is correct for a cheap structured-output call and wrong for this one.
7. **Support up to four input images, even though Iris needs one.** The model accepts four. Atlas may want more than one. Taking an array now costs nothing and avoids a second change to a shared package later, which is the change most likely to conflict between squads.
8. **Throw errors that name which thing failed.** "The model returned no image" and "the input image is too large" and "the call itself failed" are three different problems with three different fixes, and the caller records the message on an audit row where it is the only clue anyone will have later.

## Agreed shapes, do not invent your own

**Correct this against iris-06's findings before writing any code.** What follows is the shape we believe is right, not the shape we know is right.

```ts
// packages/shared-utils/src/getImageToImageOutput.ts

/** An image handed to the model as a reference. */
export interface InputImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface GetImageToImageOutputOptions {
  gateway?: GatewayConfig;
  /** Model-specific extras merged into the form. Kept open because `steps` is
   *  fixed on flux-2-klein but may not be on whatever replaces it. */
  extras?: Record<string, string>;
}

export interface ImageToImageOutput {
  image: Uint8Array;
  contentType: string;
}

/** Largest input dimension the model accepts. Anything at or above this is
 *  rejected before the call bills. Confirm the exact bound in iris-06. */
export const MAX_INPUT_IMAGE_DIMENSION = 512;

/** Up to four reference images, named input_image_0 through input_image_3. */
export const MAX_INPUT_IMAGES = 4;

export async function getImageToImageOutput(
  prompt: string,
  images: InputImage[],
  model: string,
  ai: ImageAiRunner,
  options?: GetImageToImageOutputOptions
): Promise<ImageToImageOutput>;
```

## Work

- [ ] **First: read iris-06's findings and correct the shapes above.** If a field name, the multipart wrapper, or the size bound differs, fix it here before writing code. Note in the PR description what you changed and why. (**Arham Zahid**)
- [ ] Write `packages/shared-utils/src/getImageToImageOutput.ts`. (**Arham Zahid**)
- [ ] Build the multipart form with the field names iris-06 confirmed, and pass it to `ai.run` in whatever wrapper iris-06 confirmed. Do not construct a JSON body. (**Arham Zahid**)
- [ ] Reuse `buildAiRunOptions` for the gateway options. Do not build the gateway object by hand: `buildAiRunOptions` drops undefined keys rather than sending them, and it is the one place that knows an empty id means "no gateway". (**Arham Zahid**)
- [ ] Reject more than `MAX_INPUT_IMAGES` images before calling, with a message naming the count. (**Arham Zahid**)
- [ ] Reject an oversized input image before calling, per decision 5. If reading the dimensions from the bytes is impractical inside a shared package with no image library, take `width` and `height` on `InputImage` and validate those instead, and say in a comment that the caller is trusted to report them honestly. Pick one and write down why. (**Arham Zahid**)
- [ ] Decode the base64 response to bytes, copying the `atob` plus `Uint8Array.from` approach in `getImageModelOutput.ts:65-66`. Do not introduce a Buffer, which is not available without `nodejs_compat` in every consumer. (**Arham Zahid**)
- [ ] Throw with a distinct message for each of: no image in the response, too many images, an oversized image, and the call itself rejecting. Include the model id, as `getImageModelOutput` does. (**Arham Zahid**)
- [ ] Do **not** add a retry loop (decision 6). If someone later wants one, that is an ADR-0009 amendment, not a helper change. (**Arham Zahid**)
- [ ] Do **not** read the gateway cost inside the helper (decision 3). (**Arham Zahid**)
- [ ] Export the function and its types from `packages/shared-utils/src/index.ts`, matching the existing export style. (**Arham Zahid**)
- [ ] Write `getImageToImageOutput.test.ts` with a fake `ai.run`. Cover: a successful call and its decoded bytes; a response with no `image` field; five input images rejected; an oversized image rejected **without `ai.run` being called at all** (assert the fake was not invoked, since this is the box that protects the budget); and no gateway id producing a call with no gateway options. Adapt `getImageModelOutput.test.ts` (119 lines) rather than starting from nothing. (**Arham Zahid**)
- [ ] Do **not** touch `getImageModelOutput.ts` or `getTextualModelOutput.ts`. `git diff --stat` should show one new file, one new test file, and one barrel edit. (**Arham Zahid**)

### Review gates

- [ ] Confirm the request shape here matches iris-06's findings field for field. This is the whole reason iris-06 exists, so read them side by side. (**Maaz Ahmad**)
- [ ] **Review this as the Atlas manager.** Atlas's image call will use this same helper. Is there anything Atlas will need that the signature cannot express, particularly around multiple input images? Say so now, because a second change to a shared package mid-sprint is the change most likely to conflict between the two squads. (**Maaz Ahmad**)
- [ ] Confirm the oversized-image test asserts `ai.run` was never called, not merely that an error was thrown. An error thrown after the call still bills. (**Maaz Ahmad**)
- [ ] Confirm Helios still passes: `npm test --workspace=apps/agent-helios` is clean, and neither existing helper was modified. (**Maaz Ahmad**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** Every test here uses a fake `ai.run`. iris-06 already spent the real call, and iris-09 spends the next one. There is no reason for this ticket to bill anything.

1. `npm test --workspace=packages/shared-utils` passes, including the new suite.
2. `npm test --workspace=apps/agent-helios` still passes. This is the check that decision 1 held: Helios depends on both existing helpers and must be unaffected.
3. `npx tsc --noEmit` from inside `packages/shared-utils`.
4. In a scratch file, import the new function from `@aureline/shared-utils` and confirm it resolves through the barrel rather than through a deep path. A consumer importing from `@aureline/shared-utils/src/...` is a sign the barrel export was missed.

## Two things that will waste your afternoon

**`ai.run`'s multipart form is not a `fetch` body, and the two are easy to conflate.** You are not making an HTTP request; you are handing a structure to a binding that makes the request for you. If iris-06's findings show a wrapper like `{ multipart: { body, contentType } }`, that is the shape, and hand-building a `Request` around it will not work. Follow the findings literally.

**A test with a fake `ai.run` that returns the wrong thing passes for the wrong reason.** If your fake returns `{ image: "..." }` because that is what `getImageModelOutput` returns, and iris-06 found this model returns something else, your tests all pass and the real call fails. Take the response shape from the findings, not from the sibling helper.
