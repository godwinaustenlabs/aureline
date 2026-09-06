# P2 handoff

**Branch:** `feature/p2-playground-design-grouping-MaazBinAsif`, cut from `feature/phase1-reference-image-and-image-prompt-MaazBinAsif` (`dc21dab`). 22 commits.

**Verified:** all five workspaces pass `npx tsc --noEmit`. `npm test` = **883 passing**, up from a 657 baseline. No model calls, no network, nothing billed.

Two documents:

- **This one** — what was built, and what is left.
- **[NOT-IMPLEMENTED.md](NOT-IMPLEMENTED.md)** — the Iris half: why it is not built, and why the plan's design for it does not work as written. Read it before picking up anything Iris-shaped.

`P2.md` and `phase-2-plan.md` are the original tickets. **Both contain errors found during the build** — §3 lists them. Where a doc and the code disagree, the code is right.

---

## 1. Local setup

`package-lock.json` was generated on Linux and resolves only the Linux rolldown bindings, so vitest 4 will not start on Windows:

```
npm install --no-save --no-package-lock @rolldown/binding-win32-x64-msvc@1.2.0
```

Every `npm install` prunes it — re-run after any dependency work. Node 22.18 is fine despite `engines: node >=24`.

---

## 2. What the pipeline does now

```
persist → classify → research → planner → validate → image
           (new)      (new)
```

**classify** — one small gated model call decides `{ mode, garment_part? }`. Fails loudly; there is no default mode. Written to its own `classification` column immediately, so a run that fails later still records what it thought it was making.

**research** — the model is handed one AI Search tool and decides for itself whether and what to search. **Ungated** (ADR-SHARED-0005): no gateway log, `research_cost_usd` always `null`. **Skipped entirely while `research_model` is empty, which is the committed default.**

**planner** — receives the mode and any retrieved `<source>` blocks through the `constraints` slot that has been open since Sprint 1.

**image** — mode-selected prompt. A tile gets the allover-repeat declaration; a motif gets a self-contained one.

**Cost:** `cost_usd` on the text row is **classify + planner**. Research contributes nothing because it is unmeasured — which is not the same as free.

---

## 3. Errors in `P2.md` / `phase-2-plan.md`

Build to the code.

1. **§8.3 — `tool_calls` location.** The research model puts `tool_calls` at the **top level**, not under `choices[0].message`; `arguments` is an **object**, not a JSON string; `id` is optional (`worker-configuration.d.ts:8187-8235`). A Chat-Completions-only reader finds nothing and silently reports "the model chose not to search". `runToolLoop` reads all three live envelopes.
2. **§5.2 — "llama-3.2-11b-vision-instruct does not list function calling".** False. It accepts `tools` and declares `tool_calls` (`:6391-6408`). Vision + tools in one request is still **unverified on a real call**.
3. **§6.2 — the column definition generates a broken migration.** `.notNull()` with no default produces `ALTER TABLE … ADD … NOT NULL`, which SQLite accepts on an empty table and **rejects on a populated one**. Fixed with `.default({})`.
4. **§8.3 — `AI_SEARCH.search` takes `{ query }` directly.** `AiSearchSearchRequest` is `{query}` XOR `{messages}`.
5. **T3 — `<source>` rendering cannot live in `research.ts`.** `ToolLoopResult.chunks` carries `{key, score, chars}`, not the text. Rendering is in `runToolLoop`; `context` carries the finished string.
6. **T6 — the ADR pointer path.** ADR-0006 is at `docs/adr/`, not `docs/adr/shared/`.
7. **T6 — the stated reason for going ungated does not hold.** `readGatewayCost` runs immediately after its own call and the planner runs after research, so a gated research call would not corrupt the planner's cost. The real reasons: a gated research stage would report only its **last** loop turn's cost under a column named for the whole stage; and an ungated call does **not** clear `aiGatewayLogId`, so a read there returns the **classifier's**.
8. **§5.2 — `research_model: ""` is not an off switch under `TextModelSchema`.** `min(1)` makes it fail validation and fall back to the var, which is a real model — so the key meant to disable retrieval would enable it, warning on every request. Hence `OptionalTextModelSchema`.
9. **T4 — the image prompt assumed a tile in three places**, not one. See §4.
10. **`instance` is `"HelioKB"`, not `"helios-kb"`.** Dashboard casing.

---

## 4. Traps worth knowing before you edit

- **`test-env.ts`'s `AI.run` fake dispatches on model id with the image reply as the catch-all.** A new stage with a new model id gets an image back where it expected JSON. Add a branch *before* the fall-through.
- **`test-env.ts`'s `research` override takes an array** — one reply per turn. A single value is returned on every turn, so the model asks to search forever and only the iteration cap stops it.
- **`readGatewayCost`'s `stage` union is `"classify" | "planner" | "image"`.** `"research"` is missing on purpose: an ungated call does not clear `aiGatewayLogId`, so a read there returns the classifier's cost. That type is the only thing preventing it.
- **The research system prompt is DB-backed**, so a stored row has no classification in it. `buildResearchUserPrompt` carries the classification in the user turn instead. Remove it and retrieval silently stops being about the right kind of design.
- **`classification` is declared last in `schema.ts`** because `ALTER TABLE ADD COLUMN` appends. Do not tidy it next to `planner_params` — schema, migrations and `test-db.ts` would then describe three different tables.
- **`garment_part`'s vocabulary is enforced by the prompt, not the schema.** `ClassificationSchema` caps length only.
- **The image prompt's `"a single centred illustration"` exclusion is tile-only.** On a motif it forbids the output. Every other exclusion applies to both — `"colour"` is an ADR-0002 promise and is never mode-dependent.
- **`vitest` does not typecheck.** A hand-written copy of `fakeEnv`'s overrides in `pipeline.test.ts` had drifted and was silently ignoring an override; only `npx tsc --noEmit` caught it. Run both.

---

## 5. Files

**New**

| File | |
|---|---|
| `packages/shared-utils/src/runToolLoop.ts` (+ test) | the bounded AI Search tool loop, `SEARCH_TOOL` |
| `packages/shared-types/src/v1/common.test.ts` | the first tests this package has ever had |
| `apps/agent-helios/src/services/classifier.ts` (+ test) | `classifyConcept` |
| `apps/agent-helios/src/services/research.ts` (+ test) | `runResearch`, `RetrievalMetadata` |
| `apps/agent-helios/src/prompts/classifier.prompt.ts` (+ test) | `helios-classifier-v1` |
| `apps/agent-helios/src/prompts/research.prompt.ts` (+ test) | `helios-research-v1`, `buildResearchUserPrompt` |
| `apps/agent-helios/src/prompts/planner.prompt.test.ts` | the `constraints` slot had zero coverage since Sprint 1 |
| `apps/agent-helios/src/repository/migrations.test.ts` | the first test in the repo that runs a migration |
| `apps/agent-helios/drizzle/0001_*.sql`, `infrastructure/d1/migrations/helios/0002_*.sql` | the `classification` column |
| `docs/adr/shared/0005-the-research-call-is-ungated-and-bounded.md` | |

**Changed**

| File | |
|---|---|
| `packages/shared-types/src/v1/common.ts` | `DesignMode`, `Classification`, `SearchQuality` |
| `apps/agent-helios/src/config.ts` | 7 KV keys, `researchModelFor`, `OptionalTextModelSchema`, `BooleanFromStringSchema`, `rejectBlank` |
| `apps/agent-iris/src/config.ts` | the same, **6 keys** — no `classifier_model` |
| `apps/agent-helios/src/db/schema.ts` | `classification` column, declared last |
| `apps/agent-helios/src/db/schema.d1.ts` | slots → `helios_planner`, `helios_classifier`, `helios_research`; `helios_image` removed as dead |
| `apps/agent-helios/src/services/pipeline.ts` | the two new stages, cost sum, metadata, `lineage` param |
| `apps/agent-helios/src/services/resume.ts` | full re-run branch for a run with no params |
| `apps/agent-helios/src/services/planner.ts` | `constraints` |
| `apps/agent-helios/src/prompts/planner.prompt.ts`, `image.prompt.ts` | `helios-planner-v3`, `helios-image-v4` |
| `apps/agent-helios/src/repository/do.repository.ts`, `d1.repository.ts` | `recordClassification`; `MAX_ROWS_PER_INSERT` 8 → 7 |
| `apps/frontend/src/domain/runView.ts` | `readClassification`, `groupByDesign` |
| `apps/frontend/src/components/RunHistory.tsx`, `PromptsPanel.tsx` | mode column, new slots live |
| both `wrangler.jsonc` + `worker-configuration.d.ts` | vars, `ai_search` binding on Helios |

---

## What's left

### Human only — nothing works without these

1. **Upload documents to HelioKB and index them.** Everything built retrieves from it. Until it has content, the best possible outcome is `quality: "thin"` on every run.

   **A starter knowledge base is in [knowledge-base/](knowledge-base/)** — three Markdown documents covering tile repeats and edge continuity, motifs and garment placement, and linework/texture/contrast. Upload all three as they are; they are enough to exercise the whole retrieval path end to end.

   They are written so that **every value the planner can emit appears in them** — all five `repeat_type` values, all five `texture_technique` values, every garment part, every scale/density/contrast level. That is the point: retrieved prose the planner cannot act on is worse than no retrieval, because it looks like evidence. Sections are 400–900 characters, comfortably over `min_chunk_chars: 200`, so a single-section hit returns `quality: "ok"` rather than `"thin"`.

   No filenames are referenced anywhere, including between the documents — the tool description is deliberately general because the KB layout is expected to change, and anything assuming a filename breaks silently when someone reorganises. **Tune the grounding by editing these documents, not the code.** They are general textile reference, not Aureline house style; replace them with studio opinion where you have it.
2. **Apply the D1 migration:** `wrangler d1 migrations apply helios-d1 --remote`. **Stop the dev server first** — it holds the files open and the command silently does nothing. The DO-local migration applies itself on next wake.
3. **Turn retrieval on,** once 1 and 2 are done: set the KV key `research_model` to `@cf/meta/llama-3.2-11b-vision-instruct`. No deploy. It ships empty on purpose, so an unindexed KB cannot bill a research call on every request.
4. **Confirm `HelioKB` is the exact dashboard string.** Nothing validates `instance_name` at build time; a wrong name surfaces only on a live call.

### Code

| What | Where |
|---|---|
| **Docs** — new stages, bindings, config keys, files. Note that research cost is always null, so `cost_usd` understates what a run spent. | `docs/spec.md`, `flows.md`, `architecture.md`, `directory-structure.md`, `helios-runs-conventions.md` |
| **Iris** — not built, by decision. **Read [NOT-IMPLEMENTED.md](NOT-IMPLEMENTED.md) first**; the plan's design for it does not work as written. | — |

### First billed run, when the KB is ready

In this order:

1. `research_model: ""` — proves no regression against today plus the classify stage.
2. A tile concept — `mode=tile`, a query about seamless repeats, `quality=ok`.
3. A motif naming a garment part — the part appears in the query, in the `classification` column, and in the image prompt.
4. **A run with a reference image** — the one unverified combination: does the research model accept `tools` **and** an `image_url` part in the same request?
5. An empty-KB run — completes, warns, `quality` thin or none.
6. `/resume` on a deliberately failed research run — new `pipeline_id`, same `design_session_id`.

In the AI Gateway dashboard expect **two** logged calls per Helios run (classify, planner), with the research call **absent**. That is ADR-SHARED-0005 working, not a routing bug.
