# 09 — Minimal playground

**What to build:** A minimal internal page where the team can trigger a real Helios pipeline run and see its output, without curling the API directly.

**Blocked by:** 01, 06

**Status:** ready-for-agent

**Team:** Frontend Team

- [ ] A single page with a text input for the concept, plus an image-upload field — **Maaz Ahmad** (frontend-only this sprint)
- [ ] Submitting the text input calls `HeliosAgent`'s endpoint and triggers a real pipeline run — **Maaz Ahmad**
- [ ] The uploaded image (if any) is not wired to the planner — it is discarded (reference-image input is out of scope this sprint) — **Ali Amir**
- [ ] The page renders the raw `HeliosResult` JSON and the generated image — no polished/labeled param display — **Ali Amir**
