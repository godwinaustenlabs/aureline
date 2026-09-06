# The reference image reaches both image models

**Supersedes the image-model half of [ADR-SHARED-0003](0003-the-reference-image-reaches-the-planner-on-both-engines.md).** Its planner half stands unchanged: both planners are multimodal, the image travels as a base64 `image_url` content part, `vision_planner_model` remains a separate key with `planner_model` as its fallback, and the image is still transient. What changes is the half that said no image model would see the picture on Iris, and that Helios's would have to wait for a third-party provider.

## What changed

Nothing about the account changed. What changed is that ADR-SHARED-0003 asked for the wrong thing.

It required Helios's image call to keep a JSON body so that gateway cost tracking survived, and then found no Workers AI model with all three of {JSON body, optional image, no mask}. That is a true finding. But it treated cost tracking as non-negotiable and a reference image as the thing to defer, and once Iris had been running flux-2-klein over multipart in production shape for weeks, the trade was visible from the other side: the multipart path *works*, it is *proven*, and what it costs is a number in an audit column — not the feature.

The second finding, that Iris's image model "could take one image but not two", was simply wrong about the model in use. It reasoned about `stable-diffusion-v1-5-inpainting`, the JSON-bodied candidate from ADR-SHARED-0002 — a path that was never built. The model Iris actually calls is flux-2-klein through `getImageToImageOutput`, which takes **up to four** input images (`MAX_INPUT_IMAGES`), named `input_image_0` through `input_image_3`. The motif never had to be displaced. There was room all along.

## Decisions

**Iris sends two images: the motif first, the reference second.** `input_image_0` is Helios's motif and `input_image_1` is the user's picture, and the composed prompt names them in exactly that order ("The first is the pattern to colour... The second is a colour reference"). Position is a contract, not an implementation detail: swapping them leaves both the array and the prompt individually valid while the model recolours the photograph and reads the pattern as a palette — a full-price run that comes back looking like the model ignored us.

The prompt clause leads the string rather than being appended, which is the one deviation from this engine's append-only prompt rule. Everything else in `buildImageModelPrompt` describes the *output*; this describes the *inputs*, and a model that reads a palette instruction before learning which picture it applies to has to reinterpret it.

**Helios branches on whether a reference is attached.** No reference: flux-1-schnell, JSON body, through the gateway, cost recorded — byte-for-byte the call it has always made. With a reference: flux-2-klein over multipart with the gateway off, the same path Iris uses. Two config keys, `image_model` and `image_to_image_model`, because these are two genuinely different calls and keeping them apart is what lets a request without an upload be provably unaffected.

**A missing `image_to_image_model` is a refusal, not a fallback.** When a request carries a reference image and no image-to-image model is configured, `imageModelFor` throws before anything bills. The tempting alternative — quietly using `image_model` — spends the image model on a result that ignored the upload and leaves an audit row that looks entirely normal. Nothing downstream could ever tell that outcome from a working one.

**`ImageModelConfig` gains an optional `transport: "json" | "multipart"`.** Optional, so every value already in KV stays valid; absent means `"json"`, which is what they all mean today. It exists so that the open question — whether klein accepts *zero* input images, and can therefore serve the text-only path too — is answerable by a KV edit and one billed run rather than by another code change.

**Neither engine's `/resume` changes.** The reference image is transient and was never persisted, so a resumed run has none; the new parameter is optional and resume omits it. `resume.ts` was not touched in either engine, which is the strongest available statement that the retry path is unaffected.

## Consequences

**Helios loses image cost tracking on runs that attach a reference.** Multipart cannot route through the gateway (ADR-SHARED-0001) and the gateway is the only source that speaks dollars. This is the trade ADR-SHARED-0003 declined to make, made deliberately: recorded as an explicit `null` with a log line, never as a number, and only on the runs that carry an upload. The text-only path keeps its real cost.

**The audit row now records what was actually called.** `model`, `transport`, `steps` (JSON path only), `reference_image_sent` and `reference_dimensions`. The image row is opened before the call, so its metadata starts as a prediction; it is overwritten once the call returns. That mattered less when one model served every run and matters a great deal now that the model depends on the request — a row still naming flux-1-schnell after a call to klein is exactly the lying audit row ADR-0001 exists to prevent.

`reference_image_sent` on the image row and `had_reference_image` on the text row disagree on every resume, and the disagreement is the record: the params were shaped by a picture, this attempt's pixels were not.

**An oversized reference is measured, logged and sent.** flux-2-klein documents a 512px input cap and enforces nothing — it downscales silently, and the silence is the problem: a designer whose 3024x4032 photo is barely reflected in the output has no way to learn that from the run. So the size is read with `readJpegDimensions`, logged at `warn` when it exceeds the advisory, recorded on the row, and the image is sent anyway. Refusing would block nearly every phone photo, and there is no resize step available inside a Worker: no `sharp`, `cf.image` transforms only apply on a proxied zone with Image Resizing on, and the Images binding needs an account-level change.

The measurement degrades to `null` rather than throwing. `readJpegDimensions` is JPEG-only and a browser file picker will hand over a PNG; the size answers a debugging question, and failing a run that produced a good image because that question could not be answered would be the wrong trade.

**`readGatewayCost` must never be called after an ungated call.** Found while making this change and fixed with it. `env.AI.aiGatewayLogId` holds the most recent *routed* call on the binding, and an ungated call does not clear it — so calling it after the multipart image call does not return null, it returns the **planner's** cost and records it as the image's. Iris was already exposed to this and its own doc comment asserted the opposite. Both engines now report the null directly from the ungated branch, with a log line saying why.

**Helios's `buildImagePrompt` was tuned for Flux Schnell**, and klein will read it differently. The exclusion list and the monochrome lock are unchanged and still trail the whole positive block — the reference clause is inserted before both, so nothing a user uploads can weaken an ADR-0002 promise — but whether the phrase tables still produce what they used to on a different model is a question only a billed run answers.

**Still open: whether klein accepts a call with no input images.** If it does, setting `image_model` to `{"model":"@cf/black-forest-labs/flux-2-klein-9b","transport":"multipart"}` makes it the text-only path too, with no code change. If it does not, flux-1-schnell stays. One billed Helios run with no upload settles it.
