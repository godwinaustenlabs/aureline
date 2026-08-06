# 06 — Real image generator integration (Flux Schnell) + R2 provisioning

**What to build:** The real `HeliosParams` produced by the planner become a real black-and-white textile pattern image via Flux Schnell, stored in R2, completing the genuine end-to-end pipeline.

**Blocked by:** 01, 03, 05

**Status:** ready-for-agent

**Team:** Single-Agent Structure Team

- [ ] R2 bucket for `agent-helios` is provisioned (Single-Agent team infra, per this ticket) — **Arham Zahid**
- [ ] `services/imageGenerator.ts` calls Flux Schnell via Cloudflare Workers AI (ADR-0004 — not Flux 1.1 Pro/Replicate this sprint), using the real `planner_params` from ticket 05 — **Hashir Rauf** (LLM/AI integration)
- [ ] `services/pipeline.ts`'s image stage is swapped from the ticket-01 stub to this real implementation — **Arham Zahid** (owns `services/pipeline.ts`)
- [ ] The generated image is stored in R2; its key is recorded as `image_r2_key` on the `modality: image` row from ticket 03 — **Arham Zahid** (pipeline persistence)
- [ ] The image call passes `{ gateway: { id: env.AI_GATEWAY_ID, metadata: { p_invoc_id } } }` to `getImageModelOutput`. Note the gateway caches image responses for an hour by default (ADR-0006) and the cache key covers the model inputs — decide whether each invocation needs a fresh `seed` or `skipCache: true` — **Hashir Rauf** (LLM/AI integration)
- [ ] A real concept, end to end, produces a real generated black-and-white pattern image — **M. Subhan** (validates output against ticket-04 translator — non-development)
