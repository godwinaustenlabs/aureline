# 04 — Planner prompt, `HeliosParams` field-list validation, and image-prompt translator

**What to build:** A first-draft planner system prompt and a `HeliosParams` → Flux-prompt translator, tested standalone against real textile-vocabulary concepts — proving the schema and prompt make textile sense before they're wired into the live pipeline.

**Blocked by:** None — can start immediately, parallel to every other ticket

**Status:** ready-for-agent

**Team:** AI Team

- [ ] A first-draft planner system prompt exists, defining the planner's role, output schema, and textile vocabulary grounding — **Maaz Ahmad** (prompt engineering & model selection)
- [ ] The 8-field placeholder `HeliosParams` list (`motif_type, repeat_type, scale, density, line_weight, texture_technique, contrast_level, style`) is tested against 8-10 real textile-vocabulary concepts and refined/validated per the Models & Prompts Research doc's methodology — **M. Subhan** (AI evaluation / scoring rubric)
- [ ] A `HeliosParams` → Flux-prompt translator exists, tested standalone — **Maaz Ahmad** (prompt engineering — standalone research script, not production code)
- [ ] Findings and any resulting schema changes are documented (feeding a possible follow-up ticket to update `shared-types` — not a blocker to ticket 05) — **M. Subhan**
- [ ] None of this is wired into the live pipeline yet — tested standalone only — **M. Subhan**
