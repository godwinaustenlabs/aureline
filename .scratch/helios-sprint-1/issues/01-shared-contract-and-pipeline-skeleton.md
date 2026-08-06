# 01 — Shared contract, agent/index split, and pipeline skeleton

**What to build:** A request to `agent-helios` flows through the real module shape (routing → agent → pipeline → stages → response) instead of the current hardcoded stub in `index.ts`, using the real `HeliosRequest`/`HeliosParams`/`HeliosResult` contract. Every later ticket builds on this skeleton by swapping one stage's stub for a real implementation.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

**Team:** Multi-Agent Structure Team

- [x] `packages/shared-types` exports the Sprint 1 `HeliosRequest`, `HeliosParams` (fields: `motif_type, repeat_type, scale, density, line_weight, texture_technique, contrast_level, style` — no color field, per ADR-0002), and `HeliosResult`, replacing the old placeholder shapes — **Maaz Bin Asif**
- [x] `index.ts` is routing-only, delegating to `routeAgentRequest`; the inline stub logic currently there is removed — **Maaz Bin Asif**
- [x] `agent.ts` (new) holds the `HeliosAgent` class; request validation happens directly in `onRequest` — **Maaz Bin Asif**
- [x] `services/pipeline.ts` (new) is the fixed-order orchestrator — planner → validate → imageGenerator — initially calling stub/canned implementations of each stage — **Maaz Bin Asif**
- [x] `agent.ts` calls into `services/pipeline.ts` and returns a `HeliosResult`-shaped response end-to-end — **Maaz Bin Asif**
- [x] The `respository` folder is renamed to `repository` (typo fix, done while this area is being touched) — **Maaz Bin Asif**
