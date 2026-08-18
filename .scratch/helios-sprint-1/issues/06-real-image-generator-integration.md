# 06 — Real image generator integration (Flux Schnell) + R2 provisioning

**What to build:** Right now the image stage is a stub that returns a fake URL. This ticket makes it real. The planner's params become a real black and white pattern image from Flux Schnell, the image is saved in R2, and the API returns a URL you can open in a browser.

**Blocked by:** nothing. 01, 03 and 05 are all merged.

**Status:** done. Built, merged and verified end to end on a real call.

**Team:** Single-Agent Structure Team

## what Flux Schnell accepts

We checked the real Workers AI model schema.

| Input | Accepted? | Notes |
|---|---|---|
| `prompt` | yes | 1 to 2048 characters. Required. |
| `steps` | yes | default 4, **max 8** |
| `width` / `height` | not listed | we send them anyway, see below |
| `negative_prompt` | no | there is no such field |
| `seed` | not listed | shows up in one doc example only |

The model replies with `{ image: "<base64>" }`. `getImageModelOutput` already turns that into bytes for you.

## Decisions already made

1. **Never send `steps` above 8.** Our config file allows up to 50, but the value in KV is 4 and stays 4.
2. **Send `width` and `height` anyway.** The KV value has `width: 1024, height: 1024`. Pass them along. If the model complains or ignores them, we will change the config.
3. **Let the translator fold the two prompts into one.** Call `buildImagePrompt(params, { supportsNegativePrompt: false })` and send the single `prompt` it returns. The model has no negative field, and `buildImagePrompt` already handles that: it appends the exclusions behind a `Do not include:` lead-in and returns `negative_prompt: null`. Do not take `negative_prompt` and stick it on the end yourself. The bare list reads as things to draw, so you end up asking for colour, text and watermarks by name. Check the result stays under 2048 characters.
4. **Always send `skipCache: true`.** The gateway keeps image replies for an hour, and we have no seed to make each call different. Without this flag the same concept keeps returning the exact same cached image.
5. **Take the model name from `config.imageModel.model`.** Do not read `env.IMAGE_MODEL`. That var is only the backup value if KV is missing (ADR-0008).
6. **The image maker does not touch R2. The pipeline does.** `generateImage` calls the AI and returns the raw image bytes, nothing more. `pipeline.ts` then hands those bytes to the save function in `r2.repository.ts`, gets the key back, and stores it. This matches how the pipeline already handles the database, and it keeps the image maker simple enough to test with no fake bucket.
7. **All R2 code lives in `repository/r2.repository.ts`.** The pipeline only calls those functions. Do not put `PATTERNS.put(...)` or `PATTERNS.get(...)` anywhere else.

## Agreed shapes, do not invent your own

Three people touch this ticket and their code has to fit together. So the shapes are fixed here, in writing. Write these exactly. If you think one is wrong, say so in the group before changing it, not after.

**`repository/r2.repository.ts`** — two functions, nothing else:

```ts
/** Saves the image and returns its key. */
export async function savePatternImage(
	bucket: R2Bucket,
	pInvocId: string,
	image: Uint8Array,
	contentType: string,
): Promise<string>;

/** Reads an image back. Returns null when the key does not exist. */
export async function readPatternImage(
	bucket: R2Bucket,
	key: string,
): Promise<R2ObjectBody | null>;
```

The key is always `patterns/{p_invoc_id}.jpg`. `savePatternImage` builds it, nobody else does.

**What the image maker returns:**

```ts
export interface GeneratedImage {
	image: Uint8Array;
	contentType: string;
	cost_usd: number | null;
}
```

**The route:** `GET /images/patterns/{p_invoc_id}.jpg`. Everything after `/images/` is the key. Return the bytes with the stored content type, or 404 if `readPatternImage` gives back null.

**How the full URL is built:** `runPipeline` gains an `origin` argument, and `agent.ts` passes `new URL(request.url).origin` into it. The pipeline then sets `image_url` to `${origin}/images/${key}`. We pass the origin in rather than guessing it, because the worker has no reliable way to know its own public address.

**Saving the row:**

```ts
completeImageRun(db, pInvocId, imageR2Key, costUsd);
```

## Who does what

Ali Amir takes the model side, everything about calling Flux and what comes back from it. Arham Zahid takes the data side, everything about storing that result and serving it. Subhan validates the output as before.

Two places the line is not clean, so they are written down here:

**Do the `env` signature change first, before anything else.** It is model side work, but it edits `pipeline.ts`, which is the data side's file. If the pipeline is already being rewritten when this lands, the two of them collide on the same lines. It is a small change and it unblocks both, so get it in early.

**Cost is a handoff, not one person's job.** Ali reads the number from the gateway log and puts it in `cost_usd` on `GeneratedImage`. Arham passes whatever is in there straight to `completeImageRun`, with no checking and no second-guessing. If it is null, store null. This is written down because a value handed between two people is exactly the kind of thing both assume the other dealt with.

## Work

- [x] R2 bucket is ready. `helios-bucket` exists and is bound as `PATTERNS` in `wrangler.jsonc` — **Arham Zahid**
- [x] Drop the preview bucket. Remove `preview_bucket_name` from `wrangler.jsonc` so we have one bucket only, the same way we did for KV. Two stores just means an image saved in one is missing from the other and nobody remembers which they are looking at. Local dev already simulates R2 on disk, so nothing breaks. Add `// "remote": true` as a commented line, so anyone who needs the real bucket for a session can switch it on. Delete `helios-bucket-preview` from the dashboard afterwards — **Arham Zahid** (infra)
- [x] Write `repository/r2.repository.ts`. The file exists but is empty. It needs two functions: one that saves image bytes and returns the key, and one that reads an image back out by key for the route below. Use the key format `patterns/{p_invoc_id}.jpg` so an image can be matched to its run row without a lookup — **Arham Zahid** (data layer)
- [x] Add `env` to `generateImage`. The real call needs `env.AI` and `env.AI_GATEWAY_ID`. It does **not** need `env.PATTERNS`, because the image maker never touches R2 (decision 6). This one word changes both `imageGenerator.ts` and `pipeline.ts`, so **one person does both files in a single commit**. If two people do it separately they will clash on the same line — **Ali Amir**
- [x] Make `services/imageGenerator.ts` call Flux Schnell through `getImageModelOutput` (ADR-0004, we are not using Flux 1.1 Pro or Replicate this sprint). Use the real params from ticket 05, the model and steps from `config.imageModel`, the folded prompt from decision 3, and pass `{ gateway: { id: env.AI_GATEWAY_ID, metadata: { p_invoc_id }, skipCache: true } }`. Return the raw image bytes and their content type. Do not save anything, do not build a URL — **Ali Amir**
- [x] Change what `GeneratedImage` holds. Today it is `{ image_url, cost_usd }`, which was only true for the stub. It becomes the bytes and their content type instead, since the URL does not exist until the pipeline has saved the file — **Ali Amir**
- [x] Swap the stub in `services/pipeline.ts` for the real image call, then pass the returned bytes to the save function in `r2.repository.ts`. The pipeline is the only place that talks to storage — **Arham Zahid** (owns `services/pipeline.ts`)
- [x] Store the key that came back in `image_r2_key` on the `image` row from ticket 03. `completeImageRun` currently takes only a cost, so it needs the key as an argument too — **Arham Zahid** (pipeline persistence)
- [x] Read the image's cost from the gateway log and save it in `cost_usd`. See the cost section at the bottom for exactly how, and for why a missing cost must never fail the run — **Ali Amir**
- [x] Add a route that reads the image back out of R2 through the repository function, and make `HeliosResult.image_url` return the **full URL**, not just the key. Someone should be able to paste it in a browser and see the pattern — **Arham Zahid** (owns `index.ts`)
- [x] In `imageModelMetadata` in `pipeline.ts`, save `width` and `height` **only if the model sends them back**. Leave them out otherwise. We should never record a size we asked for but did not get, because that makes the audit row lie — **Arham Zahid**
  - How it landed: `getImageModelOutput` throws away everything except `image`, so the model never reports a size back and neither field is recorded at all. `steps` now records the value actually sent, which is `min(config steps, 8)`, not the raw config value. Same reasoning, one step further: the row states what happened, not what we asked for.
- [x] Add tests for the image generator using a fake AI runner, so they cost nothing. No fake bucket needed, since the generator no longer touches R2. Cover: the folded prompt reaches the model, `skipCache` is sent, and the model returning no image is handled. Test the R2 key format separately against the repository function — **Ali Amir**
- [x] A real concept, end to end, gives a real black and white pattern image — **M. Subhan** (checks the output against the ticket-04 translator, non-development)

**Budget: 3 real image calls.** Everything else uses the fake runner. This is the first ticket that spends image quota, so keep an eye on it.

## Settled: where the image cost comes from

The image model's reply contains only the picture. There is no cost or usage in it. We checked with a real call.

But the AI Gateway records the cost, and we can read it from inside the Worker with no API token:

```ts
const logId = env.AI.aiGatewayLogId;              // set after a routed call
const log = await env.AI.gateway(env.AI_GATEWAY_ID).getLog(logId);
log.cost;      // 0.0019008 for one 4-step Flux image
log.duration;  // 4043 (ms)
log.cached;    // false
```

Verified against a real call: the number matched the gateway dashboard exactly.

Store real dollars. The text row currently holds neurons instead, which is a separate cleanup, so do not copy it.

Wrap `getLog` in try/catch. If it fails, leave `cost_usd` null and carry on. A missing cost must never fail a run.

## Verified on the first real run

One real call, `p_invoc_id` `c4366916-e6cb-44d8-a06d-825f7b167fb9`, 12.5 seconds, cost $0.0019008.

**The open question above is answered: yes, the log is readable in the same request as the call.** `cost_usd` came back as real dollars, not null. The try/catch stays anyway, because a cost we cannot read must still never fail a run.

What the run proved:

| Checked | Result |
|---|---|
| `image_url` | `http://localhost:8787/images/patterns/c4366916-....jpg`, a full URL. This also proves the Agents SDK keeps the original request URL when it hands off to the Durable Object, which was the one untested guess in the origin plumbing. |
| The image | 1024x1024 JPEG, pure black on white, half-drop paisley. No colour, no text, no border, no watermark. Fetched back through the route, not read off disk. |
| Image row | `status` completed, `image_r2_key` = `patterns/c4366916-....jpg`, `cost_usd` = 0.0019008, metadata = flux-1-schnell, steps 4. |
| Text row | `cost_usd` = 89.68. That is neurons, not dollars, sitting in the same column as the image row's dollars. Known and left alone: this ticket stores real dollars, and the text row's unit is a separate cleanup. |

Sending `width` and `height` broke nothing (decision 2 stands), though 1024x1024 is also Flux's default, so this is not proof the model honoured them.

**Budget: 1 of 3 real calls spent.**
