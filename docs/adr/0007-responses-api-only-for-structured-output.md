# `getTextualModelOutput` speaks the Responses API only, and sends the schema rather than merely checking it

> **This decision was reversed on 2026-08-07.** The helper now uses the Chat Completions shape, because the Responses shape does not report token or neuron usage. Read the update at the bottom of this file before acting on anything above it. Everything below this line describes what we decided at the time and why, which is still worth reading.

Ticket 02 shipped `getTextualModelOutput` and closed with all four boxes ticked, but the helper could not have worked against a live model. It compiled the caller's JSON schema with Ajv and used it to grade the reply, while the request itself went out as `ai.run(model, { prompt })` — the model was never told what shape to produce. It then validated the raw `ai.run` return against that schema, and Workers AI never returns bare output: `gpt-oss-120b` wraps the answer in an `output` array with a `reasoning` item ahead of the `message` item, and the JSON sits as a string inside the message. Validation therefore failed on every attempt, the retry loop exhausted, and the helper threw. Deterministically, on every call, for every model. Six unit tests passed throughout, because each mocked the model returning a bare JSON string — a shape nothing produces. The envelope itself was already known; ADR-0006 records that establishing it cost real debugging time.

Decision: the request is built in the Responses API shape — `instructions`, `input`, and `text.format` carrying the JSON schema with `strict: true`. The schema now constrains the model instead of only grading it, and validation stays as a second line of defence, because `strict` is a contract with the provider rather than a guarantee. The reply passes through an extractor that opens the envelope before validation: Responses-API `output` arrays first, then classic `{ response }` bodies, then bare strings, and anything unrecognised is handed to the validator untouched so the error comes from one place.

Validation is Zod, not Ajv, and that was not a style preference. Ajv compiles each schema into JavaScript source and evaluates it with `new Function`, which the Workers runtime forbids: a live call failed with `Code generation from strings disallowed for this context` before the request ever reached the model. The helper could not have run in the runtime it ships to, independent of everything else described here. The unit tests missed it because vitest runs in Node, where the same code is legal — the same green-tests-broken-code pattern that hid the envelope bug. Zod validates by walking the value, so there is nothing to generate. The caller passes the Zod schema they already have from `@aureline/shared-types`, the helper derives the JSON Schema for the model with `z.toJSONSchema`, and there is no hand-maintained second copy to drift. Zod emits `additionalProperties: false` and a complete `required` list, which happens to be exactly what `strict: true` demands. The `$schema` dialect key is stripped, since providers reject unknown keys inside a `json_schema` block. The Responses-API branch is deliberately first — those replies are objects, so any later ordering would let them fall through to an "already an object" case and reproduce the original bug. The extractor searches the `output` array for a `message` item rather than taking `output[0]`, because the `reasoning` item precedes it.

Rejected alternative: supporting both request families behind a flag or a model-id lookup. `docs/Models Summary.md` names Llama 3.3 70B as the secondary and GLM 4.7 Flash as a cost fallback, and both want chat-completions shape — `messages` plus `response_format` — so a helper covering all three would need branching in the request body, the extractor, and the tests. Helios calls `gpt-oss-120b` and nothing else today. Branching for models no caller invokes is speculative work whose correctness nobody can check, and a model-id lookup makes an unrecognised id fail at runtime rather than at the type level.

The consequence is worth stating plainly, because it is a trap: **setting `PLANNER_MODEL` to `@cf/meta/llama-3.3-70b-instruct` or a GLM model will not work.** The call goes out with `input` and `text.format` where the model expects `messages` and `response_format`, and it fails at the provider rather than anywhere legible. This is a config change any engineer would reasonably assume is safe, since `PLANNER_MODEL` is a plain string in `wrangler.jsonc` and both models are documented as fallbacks. Adding support means branching the request body and teaching the extractor the chat-completions envelope — perhaps half a day, and worth doing at the point a fallback is actually wired, not before.

`maxRetries` now defaults to `2` rather than `3`. The old default disagreed with `MAX_RETRIES: "2"` in `wrangler.jsonc`, and since no caller passed the option, the code's number silently won and the configured one had never taken effect. Two defaults for one knob is how that happens, so the library default now matches the committed fallback. It stays optional rather than required because `shared-utils` is engine-agnostic and its own tests call the helper without a Worker `Env`; callers are expected to pass the runtime value. Each attempt is a billed call, so the difference is not cosmetic.

The thrown error now quotes a truncated excerpt of the last response alongside the Ajv errors. An envelope mismatch previously produced a wall of Ajv output that never mentioned the actual problem, which is part of why this survived review.

One consequence for the next reader: the bare-string extraction path exists only because ticket 02's original tests exercise it, and no Workers AI model returns that shape. It is cheap to keep and it costs one branch. Do not read it as evidence that some model somewhere replies that way.

---

## Update: we switched to the Chat Completions shape

**Date:** 2026-08-07. This reverses the decision above. The helper now sends `messages` + `response_format`, not `instructions` + `input` + `text.format`.

**Why we changed.** The decision above was made without ever checking what the model reports back about itself. When ticket 05 wired up the real planner, every run saved a cost of zero. The model answered correctly and then said it had used zero tokens and zero neurons, which is not true. The call was billed.

We tested both request shapes against the same model, on the same account, through the same gateway, an hour apart. The only difference was the request body.

- Responses shape (`input` + `text.format`): `{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "neurons": 0}`
- Chat Completions shape (`messages` + `response_format`): `{"prompt_tokens": 1842, "completion_tokens": 256, "total_tokens": 2098, "neurons": 76.06}`

So the request shape decides whether usage is reported at all. There is no setting or flag involved.

This was easy to miss because an earlier test with Llama 3.2 1B, which uses the older `{ response, usage }` shape, returned a proper neuron count. That made `neurons` look like a field every model fills in. It is not.

**Why we did not just wait for a fix.** The same gap was fixed upstream in vLLM in August 2025 (PR #22667, which added token counting to the gpt-oss serving path). Cloudflare still returns zeros a year later, and other users report the same thing on their community forum. So this is not something that resolves itself on a known timeline.

**What we gave up.** The reason the original decision picked one shape was to avoid branching, and we still avoid branching. We simply branch to the other side. The extractor keeps its Responses branch for now, so nothing that already worked stops working.

**What we got back.** Cost tracking works, and `cost_usd` now holds a real neuron count. The trap recorded above also goes away: Llama 3.3 70B and GLM 4.7 Flash want the Chat Completions shape, which is exactly what we now send, so pointing `PLANNER_MODEL` at a fallback model is no longer structurally broken. That is untested, but it is no longer excluded by design.

**The new trap, and it is a real one.** Chat Completions defaults to **256 output tokens**. The Responses shape defaulted to around 129,000, so this never came up before. This model spends part of its output budget thinking before it writes the answer, and in our first test it used about 200 tokens thinking and then ran out of room, cutting the JSON in half:

```
{"contrast_level":"high","density":"balanced","line_weight":"medium","motif_type":"geometric fan","repeat
```

Broken JSON looks exactly like the model misbehaving, so it gets retried and billed again, and the error message points at the wrong problem. The helper therefore always sends `max_tokens` and never accepts the default. It defaults to `2048` and exposes `maxOutputTokens` for callers. Measured on real calls: prompt 1842 tokens, completion 253 to 269 tokens including the thinking.

**One more rule that came out of this.** A usage figure of zero means the provider did not report anything, not that the call was free. Saving a zero into a cost column is worse than saving nothing, because a report built on it will look correct while being wrong. Zero is stored as null. See `extractNeuronCost` in `apps/agent-helios/src/utils.ts`.

**Still true from the original decision.** Validation is Zod and not Ajv, for the runtime reason given above. The schema is sent to the model, not only used to grade the answer. Validation stays as a second check because `strict` is a promise from the provider, not a guarantee. The error quotes an excerpt of the last response. `maxRetries` defaults to 2.
