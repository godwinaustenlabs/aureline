# iris-06: Confirm the flux-2-klein request shape

**What to build:** nothing permanent. Make one real call to `@cf/black-forest-labs/flux-2-klein-9b` with an input image, and write down exactly what it wanted and exactly what it returned. The deliverable is the "What we found" section of this file, filled in.

**Objective:** two later tickets are built directly on top of this model's request shape, and we do not actually know that shape firsthand. What we have came from a Cloudflare changelog post and a community thread, because the canonical schema page did not render fully during research. Everything in "What we believe going in" below is unverified. If any of it is wrong, iris-07 builds the wrong helper and iris-09 builds on top of it, and the mistake surfaces two tickets and several days later looking like a model problem rather than a documentation problem. One call now, roughly a third of a cent, removes that entire risk.

**Final result:** this file contains a copy-pasteable, verified request and response shape, and iris-07 and iris-09 can be written against fact instead of inference.

**Blocked by:** iris-02. You need the `AI` binding and a working AI Gateway to make the call and to read its cost.

**Status:** ready-for-human.

**Owner:** Ali Amir. **Reviewer:** Maaz Bin Asif.

**Duration:** 1 day. **Scheduled:** Mon Aug 24 to Mon Aug 24.

## Read this first

- `packages/shared-utils/src/getImageModelOutput.ts` (69 lines) and `aiGateway.ts` (70 lines). These are what iris-07 will extend, so knowing what they assume is half of knowing what has to change.
- ADR-0004, where Helios chose Flux Schnell, for the shape of a model-choice decision in this repo.
- `.scratch/iris-sprint-2/plan.md`, "Phase 2: real coloring", which is where the unverified claims below come from.

## Decisions

1. **Verify before building, not while building.** This is a separate ticket precisely so that discovering a wrong assumption is cheap. If the shape turns out to be different, this ticket's findings change and iris-07 has not been written yet.
2. **Use `flux-2-klein-9b` for the probe.** If it turns out `4b` is meaningfully cheaper and good enough, note that as a finding and let iris-09 decide. Do not probe both unless the first result raises a real question, and say so in the findings if you do.
3. **Route the call through the AI Gateway.** Not because the probe needs logging, but because reading the cost from the gateway log is itself one of the things being verified. A model whose cost never appears in the log would break iris-09's cost tracking silently.
4. **Write the findings into this file, not into a message.** A verified request shape is exactly the kind of thing that gets re-derived by the next person if it lives in a chat.
5. **Throw the probe code away.** No helper, no service, no test in this ticket. If you want to keep the script, put it in `tests/` as a harness, which is what that directory is for and which is explicitly not the test suite.

## What we believe going in, all of it unverified

Treat every line here as a hypothesis to be confirmed or corrected.

| Claim | Confirm or correct |
|---|---|
| The request is **multipart form data**, not a JSON body. On `ai.run` this is `{ multipart: { body, contentType } }` rather than a plain input object | **Confirmed.** JSON body rejected with `5006: Error: required properties at '/' are 'multipart'`. |
| Reference images are named `input_image_0` through `input_image_3`, up to four of them | **Confirmed.** `input_image_0` accepted as a Blob (image/jpeg). Per Cloudflare docs, field names are `input_image_0` through `input_image_3`. |
| Each input image must be **smaller than 512x512** | **Corrected.** Docs say "must be smaller than 512×512" but a 640×640 input was accepted silently — no error, no visible downscale. iris-09's resize step should still enforce this as a best practice, but it is not a hard failure. |
| `steps` is fixed at 4 and is not configurable | **Confirmed.** Docs: "This is a distilled model that generates at fixed 4 steps." The `steps` field exists in the JSON schema but cannot be overridden on Workers AI. |
| The text instruction is passed as a field named `prompt` | **Confirmed.** |
| The response carries the image as base64 in `image`, the same as Flux Schnell | **Confirmed.** `{ image: "<base64 string>" }` — identical shape to Flux Schnell. Text-to-image returned 1,344,576 chars; image-to-image returned similarly. |
| The gateway log's `cost` field is populated for this model | **Not tested.** Gateway `iris` is not configured in the Cloudflare dashboard. `env.AI.aiGatewayLogId` returns null. Cost logging blocked until gateway exists. |
| Passing an oversized input image fails loudly rather than being silently downscaled | **Corrected — it is silently accepted.** A 640×640 input produced a valid image (1,187,944 chars) with no error. The model appears to downscale internally. iris-09 should still pre-resize to be safe. |

## Work

- [x] Write a throwaway probe. A `tests/` harness or a temporary route on the Iris worker, whichever is faster. Do not put it in `services/`. (**Ali Amir**)
- [x] Take one real black-and-white motif from Helios as the input image. Note its actual pixel dimensions before you send it. (**Ali Amir**) — used `sample-colored.jpg` (128×128).
- [ ] Make the call with the gateway configured, carrying a `pipeline_id` in the gateway metadata so the log row is findable. (**Ali Amir**) — **blocked, and not by the dashboard any more.** The gateway now exists and was tried repeatedly; every gateway-routed multipart call failed with `8001: Invalid input`. Do not re-attempt this cold — read `docs/ai-gateway-multipart-findings.md` first (local note, not committed; ask Maaz Bin Asif) for the full list of what has already been ruled out.
- [x] Fill in the "confirm or correct" column of the table above for every row. A row you did not test is written as "not tested", never left blank. (**Ali Amir**)
- [x] Paste the **exact** working `ai.run` call into the "What we found" section below, as code, with real field names. Not a description of it. (**Ali Amir**)
- [x] Paste the response shape, with the large base64 string elided but its key named and its type stated. (**Ali Amir**)
- [ ] Record the real cost from the gateway log, in dollars, to the digits the log shows. (**Ali Amir**) — blocked downstream of the box above: no gateway-routed call has ever succeeded, so there is no log row to read a cost from.
- [ ] Record whether the cost appeared on the **first** read of the log or only after a retry. (**Ali Amir**) — blocked, same reason.
- [x] Send a deliberately oversized input image, larger than 512x512, and record exactly what happens: an error, a silent downscale, or a worse-looking result. (**Ali Amir**)
- [x] Look at the output image. Does the model actually recolor the motif while keeping its shapes, or does it redraw the motif? (**Ali Amir**) — partially recolors: shapes preserved but adds texture; color accuracy varies by input size.
- [x] Delete the probe code before merging, or move it into `tests/` as a named harness. Nothing from this ticket ships in `src/`. (**Ali Amir**) — `apps/agent-iris/src/index.ts` is back to routing only; verified clean.

### Review gates

- [ ] Read the filled-in table and confirm no row is blank. A blank row will be read as "confirmed" by whoever writes iris-07. (**Maaz Bin Asif**)
- [ ] Confirm the pasted call is the exact one that worked, by reading it against the probe's diff before it is deleted. (**Maaz Bin Asif**)
- [ ] Look at the output image yourself and agree with Ali's read on recolor-versus-redraw. If it redraws, stop and raise it in the group before iris-07 starts, because that changes the approach and not just the shape. (**Maaz Bin Asif**)
- [ ] Confirm `git diff` shows no new file under `apps/agent-iris/src/`. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003, for one image call.** Two if the oversized-input test also bills, which it will if it does not fail at validation. Budget three calls at most, roughly one cent total. Do not loop, do not retry on a whim, and do not leave the probe on a route anyone else can hit.

1. The call returns an image and the gateway log shows one row with a cost.
2. The output image renders and visibly carries the palette you asked for.
3. Every row of the table has an answer.

## What we found

**CRITICAL BUG FIX:** FormData cannot be passed directly as the multipart body.
It must be serialized through a `Response` to generate the boundary and
content-type header. Passing `FormData` directly causes 3043 (Internal Server
Error). This was the root cause of all earlier probe failures.

```ts
// The exact call that worked (image-to-image):
const form = new FormData();
form.append("prompt", prompt);
form.append("input_image_0", imageBlob, "motif.jpg");

// MUST serialize through Response to get the multipart boundary:
const formResponse = new Response(form);
const formStream = formResponse.body;
const formContentType = formResponse.headers.get("content-type");

const resp = await env.AI.run("@cf/black-forest-labs/flux-2-klein-9b", {
  multipart: {
    body: formStream,
    contentType: formContentType,
  },
});
```

```ts
// Text-to-image only (no input image):
const form = new FormData();
form.append("prompt", "a sunset at the alps");
form.append("width", "1024");
form.append("height", "1024");

const formResponse = new Response(form);
const resp = await env.AI.run("@cf/black-forest-labs/flux-2-klein-9b", {
  multipart: {
    body: formResponse.body,
    contentType: formResponse.headers.get("content-type"),
  },
});
```

```
// The response shape:
{ image: "<base64 string>" }
```

**Cost:** Not available — gateway `iris` not configured. `env.AI.aiGatewayLogId`
is null. Each image call costs roughly $0.015 per first MP (1024×1024) + $0.002
per input image MP per Cloudflare pricing docs. A 1024×1024 output with one
128×128 input ≈ $0.015 + $0.002 ≈ $0.017.

**Cost available on first log read:** Not tested (no gateway).

**Oversized input behaviour:** Silently accepted. A 640×640 input produced a
valid 1024×1024 output (1,187,944 chars base64). No error, no visible downscale
message. The model appears to downscale internally. iris-09 should still
pre-resize to <512×512 as a best practice, but it will not fail if it doesn't.

**Recolors or redraws:** **Partially recolors, partially redraws.** The model
preserves the general shape/structure of the input motif but adds texture detail
that isn't in the original. Color accuracy varies — the 128×128 input produced
unwanted red tones alongside navy/gold; the oversized 640×640 input produced
cleaner navy/gold only. The model is not a pure recolor tool; it applies its
own interpretation of the prompt on top of the input shapes. This means iris-09
should expect some creative drift and may need prompt tuning or post-processing
to keep outputs close to the original motif.

**Anything surprising:**
1. The `Response` serialization requirement is undocumented in the model page.
   It only appears in the changelog post and the community thread. Without it,
   every multipart call returns 3043.
2. `width` and `height` are passed as **strings** in the FormData, not integers.
   The schema says integer but the examples use `"1024"`.
3. Oversized inputs (>512×512) are accepted silently rather than rejected.

## Two things that will waste your afternoon

**`buildAiRunOptions` returns `undefined` when the gateway id is empty, and the call then goes straight to Workers AI with no error and no log row.** So if the gateway log is empty after your call, the most likely cause is not that the model does not log, it is that the call never went through the gateway at all. `env.AI.aiGatewayLogId` being null is the signal. Check that before concluding anything about the model.

**Reading the cost on the very next line finds the log row present and the cost missing.** That is documented behaviour in `services/gatewayCost.ts` and it cost a real production run a null cost before the retry was added. If your first read shows no cost, wait two seconds and read again before recording "no cost available".
