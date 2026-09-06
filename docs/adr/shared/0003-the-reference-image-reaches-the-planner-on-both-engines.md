# The reference image reaches both planners, and only Helios's image model

> **Partly superseded by [ADR-SHARED-0004](0004-the-reference-image-reaches-both-image-models.md).** Its image-model decisions no longer hold: the reference now reaches both engines' image models, Iris sends the motif *and* the reference, and Helios uses flux-2-klein over multipart rather than waiting on a third-party provider. The reasoning below is kept because it was sound on the evidence it had, and because one of its premises was wrong in a way worth being able to find again — it reasoned about a JSON-bodied inpainting model that was never built, not about the multi-image model Iris actually calls.
>
> **Everything about the planner still stands**, as do the transient-image and `vision_planner_model` decisions.

`docs/Project Wide/phase-1-plan.md` §2 says a user's reference image is "sent to the planner call and to the image-model call" on every engine. Building it exposed that this is not one decision but two, and that one of them was not available.

The planner half is uniform and was never in doubt: both engines' planners become multimodal, the image travels as a base64 `image_url` content part in the Chat Completions body, and that hop was never touched by the AI Gateway's multipart restriction — it is an ordinary JSON request.

The image-model half is where the two engines stop resembling each other.

**Helios's image model could not take a reference image at all.** `getImageModelOutput` calls Flux Schnell with `prompt` and `steps`. There is no input-image parameter to add. Honouring §2 step 4 on Helios means replacing the model and the request shape, not extending a call.

**Iris's could take one, but not two.** §2 step 5 decided Iris would build a new JSON-bodied image-to-image call. The only model on the account that takes a JSON body and reaches the gateway is `stable-diffusion-v1-5-inpainting` (ADR-SHARED-0002), and it takes exactly one image plus a mask. Iris already spends that one image on the motif — Helios's output, the thing Iris exists to colour. A user reference would have to displace it, which inverts what the engine is for. The only multi-image path on the account is flux-2-klein over multipart, which ADR-SHARED-0001 proved cannot reach the gateway.

Decision: **the reference image reaches Iris's planner and stops there.** Iris's image call keeps receiving the motif alone, exactly as it does today — `colorizer.ts`, `getImageToImageOutput` and Iris's `image_model` config are untouched by this work. The reference image still influences the coloured output, through the planner's params and through `image_prompt`, which is the free-form layer built for precisely this (phase-1-plan §6). §2 step 5 is dropped from this phase rather than half-built.

This is a real reduction against the phase-1 doc and is recorded rather than absorbed: on Iris, no image model ever literally sees the user's picture.

Decision: **Helios moves to a third-party image model reachable through AI Gateway's universal endpoint, taking an optional base64 reference image in a JSON body.** Three properties were required together and no Workers AI model has all three. A JSON body, because the gateway refuses `ReadableStream` and Helios's `cost_usd` is real today — a multipart move would trade working cost tracking for a reference image, which is the regression ADR-SHARED-0001 exists to warn about. An *optional* image, because a request without one must keep working exactly as it does now, and a two-model branch doubles the image paths under test. And no mask, because a mask is a concept from inpainting that has no meaning for pattern generation.

The account sweep behind that is in `docs/ai-gateway-multipart-findings.md` and is not repeated here. Its short form: the klein family is stream-only, `sdxl-base` and `xl-lightning` carry no image tensor, `dreamshaper-8-lcm` wants a shape nothing produces, `sd-v1-5-img2img` is not on the account, and `sd-v1-5-inpainting` requires both a mask and a mandatory image.

Consequence: **this half of the work is blocked on a decision that is not the implementer's to make.** Which provider, at what price, is Subhan's call under phase-1-plan §5. Adding the provider to the gateway and putting its key in `wrangler secret put` is a human's action (AGENTS.md §11). The branch and the config field are built ahead of it so the hole is visible rather than implied.

Consequence: **Helios's `buildImagePrompt` translator was tuned for Flux Schnell** — its clause order, its folded-in exclusion list, its 2048-character cap — and a different provider's model invalidates none of that automatically but verifies none of it either. Re-checking it is part of adopting the model, not a follow-up.

Decision: **the reference image is transient.** It is read off the request, held for the invocation, and never written to R2. Persisting it would need a key convention, a retention rule and a pruning path, which is scope this phase does not have. The consequence is that `POST /resume` cannot reproduce it — and does not need to: resume never re-runs the planner, it reuses the stored params, which already carry whatever the planner took from the image. So a resumed run is not missing anything, and refusing to resume such runs would block retry on exactly the runs most likely to want one. What resume does record is `had_reference_image` on the text row's `model_metadata`, so "why does this look different" stays answerable from the audit table alone.

Decision: **a separate `vision_planner_model` config key, with `planner_model` kept as the fallback.** The vision model is used for every request, image or not, rather than swapping models per request — one model means one set of planner behaviour to tune and one prompt that has to work, where branching would mean two of each and a class of bug that only appears when an image is attached. Keeping the old key is what makes the swap reversible from KV without a deploy, which is the same property ADR-0008 exists to preserve.
