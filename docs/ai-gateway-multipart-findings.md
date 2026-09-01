# AI Gateway and multipart image-to-image: findings

**A record of what was tried, not a decision.** The decisions this fed into are
ADR-SHARED-0001 (why the multipart path cannot reach the gateway) and
ADR-SHARED-0002 (what Iris does about it). (An earlier header called this file "deliberately not committed";
it has been in git since `0bfde36`, and several places still cite it as local. It is
not.)

Date: 2026-08-24, with the resolving probe added 2026-08-31. Model under test:
`@cf/black-forest-labs/flux-2-klein-9b`.

**Resolved, and then routed around.** Jump to "What it actually was" for why the
multipart call fails; everything above it is the investigation that led there, kept
because two of its conclusions were wrong in instructive ways. Then read "How Iris
got a working gateway anyway" at the end — the answer was a different model, not a
fix to this one.

## What we were trying to do

Route one image-to-image call through the `iris` AI Gateway, so the cost could be read back off the gateway log the way `readGatewayCost` already does for Helios (`apps/agent-helios/src/services/gatewayCost.ts`). ADR-0006 says every Workers AI call goes through the gateway, and iris-09 is written on the assumption that this one will.

## What happened

Every gateway-routed attempt failed with `AiError: 8001: Invalid input`. Not once did a
gateway-routed multipart call succeed.

## What we ruled out

Each of these was changed on its own, with everything else held still. The error did not
move for any of them.

- **The model.** `flux-2-klein-9b`, `flux-2-klein-4b`, and `flux-2-dev`. All three take
  the identical `{ multipart: { body, contentType } }` input and all three return
  `{ image: "<base64>" }`.
- **The body encoding.** Raw `ReadableStream`, buffered `Blob`, and `ArrayBuffer`.
- **The image source.** A real Helios motif fetched over HTTP, and an image built
  locally in the worker.
- **The multipart field name.** We had been sending `image`. The correct name is
  `input_image_0`, through `input_image_3`, up to four images — confirmed against
  Cloudflare's own `flux-2-klein-9b` changelog post
  (`https://developers.cloudflare.com/changelog/post/2026-01-28-flux-2-klein-9b-workers-ai/`).
  This was a genuine bug in the probe and worth fixing on its own account, but fixing it
  did not resolve the `8001`.
- **The input image size.** The real motif is 1024×1024 and the docs cap inputs under
  512×512. We resized to 512×512 with `fetch(url, { cf: { image: { width, height, fit } } })`
  and confirmed the resize genuinely applied — wrangler prints its own warning,
  *"Local cf.image transforms are a low-fidelity mock; only resize, rotate and format
  conversion are applied."* Still `8001`.

## What the evidence looked like it pointed at — superseded, read the next section

At the time this read as: the gateway is not carrying the multipart body through to
the model. That was wrong, and the section is kept because the reasoning was
reasonable and the way it failed is worth knowing.

- **The gateway's own request log showed the body as `"body": {}`** — an empty object —
  on both occasions we looked, with two different models. Whatever the gateway forwarded,
  it was not the form we built.
- **`flux-2-dev` did not error at all** under identical construction. It returned an
  unrelated stock "FLUX.2" branded demo image. That is what a model does when it receives
  a prompt and no usable reference image and quietly falls back to text-to-image — not
  what it does when it receives a malformed one.
- **The gateway rejects a raw `ReadableStream` outright**, with *"AI Gateway does not
  support ReadableStreams yet."* That is the documented shape Cloudflare's own example
  uses, so working around it means buffering to a `Blob` — which is the path that then
  fails with `8001`.
- **The one call that ever worked did not go through the gateway.** Ali Amir's original
  iris-06 probe succeeded, and his own findings say why the cost was missing: *"gateway
  `iris` not configured."* It ran before the gateway existed, straight to Workers AI.
  That single fact is what explains the discrepancy between "PR #27 worked" and "our
  re-verification keeps failing" — they are not the same call.

**This was the best-evidenced hypothesis, not a confirmed root cause** — and it was
wrong. We ruled out everything on our side of the wire except the one thing that
mattered: we never ran the same body shape *without* the gateway.

## What it actually was

Probe, 2026-08-31: three body shapes, each sent twice, once with the `iris` gateway
and once without. Six calls, all rejections, so effectively free.

| `multipart.body` | direct | through the gateway |
|---|---|---|
| string | `8001: Invalid input` | `8001: Invalid input` |
| `Blob` | `8001: Invalid input` | `8001: Invalid input` |
| `ReadableStream` | **succeeds** — a real 730 KB image | `AI Gateway does not support ReadableStreams yet.` |

**The `8001` is not the gateway's doing.** A `Blob` fails with it when no gateway is
involved at all. It is what the model returns for a body that is not a stream.

So: the model requires a `ReadableStream`; AI Gateway refuses one. The only body type
the model accepts is the only body type the gateway refuses, and buffering around the
second error produces the first. There is no third option to find.

### The two things this file got wrong, and why

**`"body": {}` in the gateway log was never evidence.** A direct `Blob` call
serializes to `{}` in exactly the same way and still reaches the model's validator, so
`{}` in a log row says nothing about what was forwarded. A proposed mechanism built on
it — that `ai.run`'s input is JSON-serialized on the gateway path, erasing every binary
shape — is a real property of JavaScript (`ReadableStream`, `Blob` and `ArrayBuffer`
all do stringify to `{}`) but is not what breaks this call. The probe's string arm
survives `JSON.stringify` intact and still returns `8001`, direct and gatewayed alike.

**"The body encoding: raw `ReadableStream`, buffered `Blob`, and `ArrayBuffer` — the
error did not move"** conflated two different failures. The stream failed with the
gateway's own ReadableStream message; the other two failed with `8001` for being the
wrong type. Read apart they point straight at the answer. Read as one identical
failure they look like a serialization boundary, which is exactly the wrong turn taken
above.

### A correction to this probe's own first reading

The stream-direct arm was first reported as "reached the model, `3043`, choked on
a deliberately corrupt JPEG." That was wrong, and it was wrong for a reason worth
keeping: the probe let the `Response` that serializes the form fall out of scope
while passing its `body` on, and **the stream does not outlive the Response**. The
`3043` was the probe's own bug. Re-run with the `Response` held, and the same
arm produces a real image. The table above carries the corrected result, which
is stronger evidence than the original, not weaker — a stream sent direct
succeeds outright.

Two things follow. The trap is now commented at the construction site in
`getImageToImageOutput`, because extracting those four lines into a function is
an ordinary refactor that would break every image call. And `3043` should be read
as "the body did not arrive intact", not as "the model rejected the content" —
Cloudflare returns it for both.

### The cheapest fix, checked and unavailable

flux-2-klein's successful response is `{ image }` and nothing else — no `usage`,
no `neurons`. ADR-0006 derived the planner's cost from `usage.neurons` in the
response body, which needs no gateway at all, and it was worth checking whether
the image model does the same. It does not. The gateway is genuinely the only
source of dollars for this call.

The general lesson, cheap to apply next time: **an encoding sweep needs a control arm
without the component under suspicion.** Six calls answered what a sprint of five
one-armed sweeps could not.

## A separate wall, unrelated

`AiError: 4006` — the daily free-tier neuron allocation (10,000/day) exhausted. Not a
bug and not something to work around in code. It resets daily; lifting it is a paid-plan
decision for a human.

## What this costs us

iris-09 wants `readGatewayCost(env, "image")` and carries a review gate reading *"confirm
the gateway log's cost matches `cost_usd` on the image row."* That gate cannot pass today.

iris-09 needed one of: a Cloudflare-side fix, a different way to reach the cost, or an
explicit decision to accept a null cost on the image row. **The third was taken**, in
ADR-SHARED-0001. `readGatewayCost` already tolerated it by design: *"A missing, failed or
unlogged cost is always tolerated as `null`. Cost is an audit concern and must never fail
a run that otherwise worked."* That gate can now be closed as decided rather than blocked.

## Tension with ADR-0006 — resolved

ADR-0006 says all Workers AI calls route through the gateway. That is impossible for
any call whose body must be a stream, which is every image-to-image call this repo
will make.

**ADR-SHARED-0001 amends it**, and also records the two consequences that had been
drifting: `getImageToImageOutput` now throws on a gateway id rather than degrading
(with the reason attached, so nobody rediscovers the `8001`), and the null `cost_usd`
on Iris's image row is a decision rather than an accident.

The one condition that would reverse it is narrow and checkable: **AI Gateway
supporting `ReadableStream`.** Watch for that, not for "multipart support". Set
`allowGatewayMultipart` on a real call that succeeded, never on a changelog entry.


## How Iris got a working gateway anyway

Nothing above is wrong, and none of it became fixable. The multipart call still
cannot reach AI Gateway and there is no arrangement of body types that changes
that. What changed is the question: instead of asking how to route *this* model,
the 2026-08-31 session asked which model on the account can be routed at all.

`@cf/runwayml/stable-diffusion-v1-5-inpainting` takes a plain JSON body, and a
plain JSON body routes without complaint — verified end to end through the `iris`
gateway, `aiGatewayLogId` `01M1C43NMHZKZSP1GHNHDDW9KX`. Iris now runs it by
default, with an explicit `transport` field in config selecting which helper
sends the request. `cost_usd` on the image row is a real number again.

The cost of that is real too and is recorded in ADR-SHARED-0002: 512x512 instead
of 1024x1024, and a visibly weaker recolour. flux-2-klein stays one KV edit away
for work that needs the better image, at the price of the null cost this whole
document explains.

Models ruled out on the way, so nobody re-walks them: `sdxl-base` and
`xl-lightning` carry no image tensor (`3030`); `dreamshaper-8-lcm` wants an
`image` of shape `[1]`, which nothing produces; `stable-diffusion-v1-5-img2img`
answers `5018` and is not on the account.

The methodological lesson from the whole sprint, worth more than any of the above:
**an encoding sweep needs a control arm without the component under suspicion.**
Six calls — three body shapes, each sent with a gateway and without — answered
what a sprint of one-armed sweeps could not, because the `8001` everyone was
chasing turned out to have nothing to do with the gateway.
