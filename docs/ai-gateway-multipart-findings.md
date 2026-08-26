# AI Gateway and multipart image-to-image: findings

**Local note, deliberately not committed.** Nothing here is a decision; it is a record of what was tried.

Date: 2026-08-24. Model under test: `@cf/black-forest-labs/flux-2-klein-9b`.

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

## What the evidence points at

The gateway does not appear to be carrying the multipart body through to the model.

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

**This is the best-evidenced hypothesis, not a confirmed root cause.** We ruled out
everything on our side of the wire. We did not prove anything about the gateway's side.

## A separate wall, unrelated

`AiError: 4006` — the daily free-tier neuron allocation (10,000/day) exhausted. Not a
bug and not something to work around in code. It resets daily; lifting it is a paid-plan
decision for a human.

## What this costs us

iris-09 wants `readGatewayCost(env, "image")` and carries a review gate reading *"confirm
the gateway log's cost matches `cost_usd` on the image row."* That gate cannot pass today.

iris-09 needs one of: a Cloudflare-side fix, a different way to reach the cost, or an
explicit decision to accept a null cost on the image row. The third is less bad than it
sounds — `readGatewayCost` already tolerates it by design: *"A missing, failed or
unlogged cost is always tolerated as `null`. Cost is an audit concern and must never fail
a run that otherwise worked."* Someone still has to decide it out loud.

## Tension with ADR-0006

ADR-0006 says all Workers AI calls route through the gateway. This one cannot, today.

iris-07 ships the gateway wiring complete but inert — `buildAiRunOptions` returns
`undefined` when no id is passed, so a caller turns it on with one line whenever it
starts working, and no helper change is needed. iris-09 does not pass an id for now.

If that is still true at the end of the sprint, ADR-0006 needs an amendment or a
superseding ADR. That is a group decision, not one to make inside a helper PR.
