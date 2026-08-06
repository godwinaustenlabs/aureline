# 05 — Real planner integration (GPT-OSS-120B, structured output)

**What to build:** A real user concept produces real, schema-valid `HeliosParams` via GPT-OSS-120B, persisted as the pipeline's `modality: text` row. The image stage can remain stubbed at this point.

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

**Team:** Single-Agent Structure Team

- [ ] `tools.ts` contains the `HeliosParams` schema definition, plus a thin call into `shared-utils`' `getTextualModelOutput` helper — **Arham Zahid** (owns `tools.ts`)
- [ ] `services/planner.ts` calls GPT-OSS-120B via Cloudflare Workers AI, using structured output (JSON schema), not tool-calling — **Hashir Rauf** (LLM/AI integration)
- [ ] `services/pipeline.ts`'s planner stage is swapped from the ticket-01 stub to this real implementation — **Arham Zahid** (owns `services/pipeline.ts`)
- [ ] A real concept string produces schema-valid `HeliosParams`, persisted correctly as the `modality: text` row from ticket 03 — **Hashir Rauf** (review/verification)
- [ ] The planner call passes `{ gateway: { id: env.AI_GATEWAY_ID, metadata: { p_invoc_id } } }` to `getTextualModelOutput`, and after the first real call the request is visible in the AI Gateway dashboard log with token counts and cost (ADR-0006) — **Hashir Rauf** (LLM/AI integration)
- [ ] Uses whatever prompt/schema exists at integration time (ticket 04's draft if ready, otherwise a rough placeholder) — not blocked on ticket 04's completion — **M. Subhan** (hands off ticket-04 prompt/schema — non-development)
