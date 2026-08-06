# 05 — Real planner integration (GPT-OSS-120B, structured output)

**What to build:** A real user concept produces real, schema-valid `HeliosParams` via GPT-OSS-120B, persisted as the pipeline's `modality: text` row. The image stage can remain stubbed at this point.

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

**Team:** Single-Agent Structure Team

- [ ] `tools.ts` imports `HeliosParamsSchema` from `@aureline/shared-types` and passes it straight to `getTextualModelOutput`, plus the thin call itself. **Do not define the schema here.** The original wording said `tools.ts` "contains the `HeliosParams` schema definition", which made sense when the helper took raw JSON Schema and someone had to hand-write one. It takes the Zod schema now and derives the JSON Schema itself, so a second copy would only drift — and `HeliosParamsSchema` is the contract `pipeline.ts`, `imageGenerator.ts` and both prompt files already run on — **Arham Zahid** (owns `tools.ts`)
- [ ] Confirm the AI Gateway auth setup before the first live call. There is no `apps/agent-helios/.dev.vars` in the repo; if the `helios` gateway has authentication on, the token goes in `.dev.vars` locally and `wrangler secret put` for deploy, never in `wrangler.jsonc` `vars` — **Hashir Rauf** (LLM/AI integration)
- [ ] `services/planner.ts` calls GPT-OSS-120B via Cloudflare Workers AI, using structured output (JSON schema), not tool-calling — **Hashir Rauf**
- [ ] The model id comes from `env.PLANNER_MODEL`, not a string literal in `planner.ts` — **Hashir Rauf**
- [ ] The planner call passes `{ gateway: { id: env.AI_GATEWAY_ID, metadata: { p_invoc_id } } }` to `getTextualModelOutput`, and after the first real call the request is visible in the AI Gateway dashboard log with token counts and cost (ADR-0006) — **Hashir Rauf**
- [ ] `services/pipeline.ts`'s planner stage is swapped from the ticket-01 stub to this real implementation — **Arham Zahid** (owns `services/pipeline.ts`)
- [ ] `TEXT_MODEL_METADATA_STUB` is retired. `pipeline.ts` hardcodes `{ model: "gpt-oss-120b", provider: "openai", temperature: 1 }`; real values must come from the call that actually ran, or the audit row records a model that was never used — **Arham Zahid**
- [ ] Token counts and `cost_usd` are written to the text row. Workers AI returns `usage.neurons`; per ticket 03, `cost_usd = neurons / 1000 * 0.011` with the rate in `vars`. Carry the raw `neurons` count in `model_metadata` too, so it can be backfilled — **Arham Zahid**
- [ ] No new inline DB code. Metadata and cost reach storage through `repository/do.repository.ts`'s existing functions (`startTextRun` / `completeTextRun`), extending their parameters if needed; `pipeline.ts` stays free of Drizzle. Ticket 03 skipped naming its target file and needed a follow-up refactor to undo it — **Arham Zahid**
- [ ] A real concept string produces schema-valid `HeliosParams`, persisted correctly as the `modality: text` row from ticket 03 — **Hashir Rauf** (review/verification)

**The `shared-utils` prerequisites are already done**, so this ticket starts from a working helper. `getTextualModelOutput` now sends the schema to the model as `text.format` rather than only checking the reply against it, opens the `gpt-oss-120b` `output` envelope before validating (a `reasoning` item precedes the `message` item), takes the system prompt via `options.instructions` separately from the user input, and defaults to 2 attempts to match `MAX_RETRIES`. 32 tests pass, up from 22.

Two things that follow from it, both easy to trip over:

- **`PLANNER_MODEL` cannot be pointed at Llama 3.3 70B or GLM 4.7 Flash.** They are named as fallbacks in `docs/Models Summary.md`, but they want the chat-completions request shape and only the Responses API shape is supported. The call fails at the provider, not anywhere legible. See `docs/adr/0007-responses-api-only-for-structured-output.md`.
- **Pass `maxRetries` explicitly** from config. The helper's default is a standalone-use fallback, not policy, and every attempt is a billed call.

**Cost warning:** every `wrangler dev` request against the `AI` binding bills real Workers AI quota, and the retry loop multiplies that by `maxRetries` per request. Build the unwrapping against a recorded or fake response first; only then point it at the live model.
