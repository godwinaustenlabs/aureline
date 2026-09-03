# P2 handoff

State as of the last commit on `feature/p2-helios-classification-column-MaazBinAsif`.

**Branch chain:** cut from `feature/phase1-reference-image-and-image-prompt-MaazBinAsif` (`dc21dab`). 15 commits.

**Verified:** all five workspaces pass `npx tsc --noEmit`. `npm test` = **825 passing**, up from a 657 baseline. No model calls, no network.

Read `P2.md` for the tickets and `phase-2-plan.md` for the design. **Both contain errors that were found and corrected during the build — see "Corrections" below. Build to the code, not to the docs.**

---

## 1. Local setup

`package-lock.json` was generated on Linux and resolves only the Linux rolldown bindings, so vitest 4 will not start on Windows. Fix, which does not touch the lockfile:

```
npm install --no-save --no-package-lock @rolldown/binding-win32-x64-msvc@1.2.0
```

Every `npm install` prunes it. Re-run it after any dependency work.

Node 22.18 is fine despite `engines: node >=24` (`node:sqlite` is unflagged from 22.13).

---

## 2. Done

### T6 — ADR

| File | |
|---|---|
| `docs/adr/shared/0005-the-research-call-is-ungated-and-bounded.md` | new |
| `docs/adr/0006-all-model-calls-route-through-ai-gateway.md` | pointer added at top |

### T1 — shared types and the tool loop

| File | |
|---|---|
| `packages/shared-types/src/v1/common.ts` | `DesignModeSchema`, `DesignMode`, `ClassificationSchema`, `Classification`, `SearchQualitySchema`, `SearchQuality` |
| `packages/shared-types/src/v1/common.test.ts` | new, 15 tests |
| `packages/shared-utils/src/runToolLoop.ts` | new — `runToolLoop`, `SEARCH_TOOL`, `ToolLoopEnv`, `SearchRunner`, `RunToolLoopConfig`, `RunToolLoopOptions`, `ToolLoopResult`, `RetrievedChunk` |
| `packages/shared-utils/src/runToolLoop.test.ts` | new, 31 tests |
| `packages/shared-utils/src/index.ts` | barrel |
| `packages/shared-{types,utils}/package.json` | shared-utils now depends on shared-types; shared-types gained vitest + a `test` script (it had neither) |

`shared-types/src/index.ts` was **not** changed — it is `export * from './v1/common'`, so the re-exports happen automatically.

### T0 — config (not in P2.md; T2/T3 cannot compile without it)

| File | |
|---|---|
| `apps/agent-helios/src/config.ts` | 7 keys, `researchModelFor`, `OptionalTextModelSchema`, `BooleanFromStringSchema`, `booleanFromVar`, `rejectBlank` |
| `apps/agent-helios/src/config.test.ts` | fixtures extended + ~20 new tests |
| `apps/agent-helios/wrangler.jsonc` | 7 vars, `ai_search` binding → `HelioKB`, `remote: true` |
| `apps/agent-iris/src/config.ts` | same, **6 keys** (no `classifier_model`) |
| `apps/agent-iris/src/config.test.ts` | same treatment |
| `apps/agent-iris/wrangler.jsonc` | 6 vars, **no `ai_search` binding** |
| both `worker-configuration.d.ts` | regenerated |
| both `src/services/test-env.ts` | new vars, `AI_SEARCH` fake, `classifier`/`research`/`search` overrides |

KV keys: `research_model`, `classifier_model` (Helios only), `max_tool_iterations`, `max_search_results`, `min_chunk_chars`, `search_match_threshold`, `ai_search_query_rewrite`.

### T2 + T5 — classifier (Helios)

| File | |
|---|---|
| `apps/agent-helios/src/services/classifier.ts` | new — `classifyConcept` |
| `apps/agent-helios/src/services/classifier.test.ts` | new, 18 tests |
| `apps/agent-helios/src/prompts/classifier.prompt.ts` | new — `HELIOS_CLASSIFIER_PROMPT_VERSION`, `buildClassifierSystemPrompt` |
| `apps/agent-helios/src/prompts/classifier.prompt.test.ts` | new, 11 tests |

T5 folded into T2 — one prompt, one version, edge cases in from the start.

### T3 — research (Helios only)

| File | |
|---|---|
| `apps/agent-helios/src/services/research.ts` | new — `runResearch`, `RetrievalMetadata` |
| `apps/agent-helios/src/services/research.test.ts` | new, 24 tests |
| `apps/agent-helios/src/prompts/research.prompt.ts` | new — `HELIOS_RESEARCH_PROMPT_VERSION`, `buildResearchSystemPrompt`, `buildResearchUserPrompt` |
| `apps/agent-helios/src/prompts/research.prompt.test.ts` | new, 15 tests |

Iris's half is **not built** — decision, see §4.

### §6.2 — the `classification` column

| File | |
|---|---|
| `apps/agent-helios/src/db/schema.ts` | `classification` text json, notNull, `.default({})`, **declared last** |
| `apps/agent-helios/drizzle/0001_wide_psylocke.sql` | generated |
| `infrastructure/d1/migrations/helios/0002_careless_northstar.sql` | generated |
| `apps/agent-helios/src/repository/test-db.ts` | DDL mirror |
| `apps/agent-helios/src/repository/d1.repository.ts` | `MAX_ROWS_PER_INSERT` 8 → 7 |
| `apps/agent-helios/src/repository/d1.repository.test.ts` | column count 12 → 13 |
| `apps/agent-helios/src/repository/migrations.test.ts` | new, 6 tests — first test in the repo that runs a migration |

**Nothing writes to the column yet.** The migration has **not been applied** to any live database — a human runs `wrangler d1 migrations apply helios-d1 --remote` for D1; the DO migration applies itself on next wake.

---

## 3. Corrections to `P2.md` / `phase-2-plan.md`

Build to the code. These are all wrong in the docs.

1. **§8.3 — `tool_calls` location.** The default research model puts `tool_calls` at the **top level**, not under `choices[0].message`; `arguments` is an **object**, not a JSON string; `id` is optional (`worker-configuration.d.ts:8187-8235`). A Chat-Completions-only reader finds nothing and silently reports "the model chose not to search". `runToolLoop` reads all three live envelopes.

2. **§5.2 — "llama-3.2-11b-vision-instruct does not list function calling".** False. It accepts `tools` and declares `tool_calls` (`worker-configuration.d.ts:6391-6408`). Vision+tools in one request is still **unverified on a real call** (§18).

3. **§6.2 — the column definition is a broken migration.** `.notNull()` with no default generates `ALTER TABLE … ADD … NOT NULL`, which SQLite accepts on an empty table and rejects on a populated one. Fixed with `.default({})`.

4. **§8.3 — `AI_SEARCH.search` takes `{ query }` directly.** `AiSearchSearchRequest` is `{query}` XOR `{messages}`.

5. **T3 — `<source>` rendering cannot live in `research.ts`.** `ToolLoopResult.chunks` carries `{key, score, chars}` and not the text. Rendering is in `runToolLoop`; `context` carries the finished string.

6. **T6 — the ADR pointer path.** ADR-0006 is at `docs/adr/`, not `docs/adr/shared/`.

7. **T6 — the stated reason for going ungated does not hold.** `readGatewayCost` runs immediately after its own call and the planner runs after research, so a gated research call would not corrupt the planner's cost. The real reasons: a gated research stage would report only its **last** loop turn's cost under a column named for the whole stage, and an ungated call does **not** clear `aiGatewayLogId`, so reading a cost on this path returns the **classifier's**. Both are in the ADR.

8. **§5.2 — `research_model: ""` does not work as an off switch under `TextModelSchema`.** `min(1)` makes it fail validation and fall back to the var, which is a real model — the key meant to disable retrieval would enable it, warning every request. Hence `OptionalTextModelSchema`.

9. **T2 — two test criteria are not testable in `classifier.test.ts`.** "Classification is NOT merged into params" and "cost is read from gateway after call" both belong in `pipeline.test.ts`; `classifier.ts` touches neither.

10. **`instance` is `"HelioKB"`, not `"helios-kb"`.** Dashboard casing.

---

## 4. Decisions taken

| | |
|---|---|
| AI Search instance | `HelioKB` (Helios). An `iris-kb` now exists but is unused. |
| Research model | Same as the planner: `@cf/meta/llama-3.2-11b-vision-instruct` |
| `RESEARCH_MODEL` var | **`""`** — retrieval off by default until HelioKB has documents indexed. Turn on by setting the KV key `research_model`, no deploy. |
| Iris this phase | **Nothing.** Iris research and `iris-color-v4` are dropped: Iris has no way to read Helios's classification (no service binding, no shared DB, `/runs` takes `pipeline_id` only). `iris-planner-v3` dropped for the same reason — nothing would fill `constraints`. |
| `classifier_model` on Iris | Omitted. Iris never classifies, so the key would be permanently dead. |
| T5 | Folded into T2. |
| Verification | Tests only. No billed run has happened. |

---

## 5. Things to know

- **`test-env.ts`'s `AI.run` fake dispatches on model id with the image reply as the catch-all.** Any new stage with a new model id gets an image back where it expected JSON. Add a branch before the fall-through.
- **`test-env.ts`'s `research` override takes an array** — one reply per turn. A single value is returned on every turn, so the model asks to search forever and only the iteration cap stops it.
- **The research system prompt is DB-backed**, so `resolvePrompt` returns a stored row that has no classification baked in. That is why `buildResearchUserPrompt` exists — it carries the classification in the user turn, which survives either prompt source. Remove it and retrieval silently stops being about the right kind of design.
- **`classification` is declared last** in `schema.ts` because `ALTER TABLE ADD COLUMN` appends. Do not "tidy" it next to `planner_params`.
- **`garment_part` vocabulary is enforced by the prompt, not the schema.** `ClassificationSchema` caps length only.
- Both engines' `worker-configuration.d.ts` were a workerd version stale; the regeneration is split into its own commits (`0cc278c`, `fd1fb97`).

---

## What's left

### Blocking, human only

1. **Upload documents to HelioKB and let it index.** Everything built retrieves from it. Until it has content the best possible outcome is `quality: "thin"` on every run.
2. **Apply the D1 migration**: `wrangler d1 migrations apply helios-d1 --remote`. Stop the dev server first.
3. **Confirm `HelioKB` is the exact dashboard string.** Nothing validates `instance_name` at build time — a wrong name surfaces only on a live call.

### Code — 7 steps, in dependency order

| # | What | Files |
|---|---|---|
| 2 | **DB prompt slots.** Without these the classifier and research prompts can only ever use their code fallback. | `apps/agent-helios/src/db/schema.d1.ts` enum → `["helios_planner","helios_classifier","helios_research"]`; `apps/frontend/src/server/prompts.ts` `ENGINE_SLOTS`; `PromptsPanel.tsx` `SLOT_LABELS`/`LIVE_SLOTS`; `frontend/src/server/{prompts,worker}.test.ts` hardcode the old arrays. Expect an empty migration — the enum is TypeScript-level only. |
| 3 | **`helios-planner-v3`** + thread `constraints`. Put the new `<source>`/mode/garment-part guidance **inside** the existing ternary at `planner.prompt.ts:266` so a no-args call stays byte-identical to v2. | `prompts/planner.prompt.ts`, `services/planner.ts` (`run` object gains `constraints?`), `services/pipeline.test.ts:170` hardcodes `"helios-planner-v2"`. No `planner.prompt.test.ts` exists — create one. |
| 4 | **Pipeline wiring.** The step that makes any of this run: `persist → classify → research → planner → validate → image`. `Stage` union, `classifyConcept`, `readGatewayCost(env,"classify")`, `runResearch`, `constraints: research.context`, write the `classification` column, `retrieval` + `classifier` blocks in `model_metadata`, `cost_usd` = classify + planner. `readGatewayCost`'s `stage` param is typed `"planner" \| "image"` — **do not widen it to include research** (ADR-SHARED-0005). | `services/pipeline.ts:29,247-388`, `repository/do.repository.ts` (`RowSeed`, a classification write), `services/pipeline.test.ts` |
| 5 | **`helios-image-v4`** mode clauses. Lands after `MONOCHROME_LOCK` (`:214`) and before `params.image_prompt` (`:230`), which puts it before `Do not include:`. | `prompts/image.prompt.ts`, `image.prompt.test.ts:95-99` hardcodes `"helios-image-v3"` |
| 6 | **Resume no-params branch.** A classify/research failure produces no params, so today's resume has nothing to resume. New `pipeline_id`, same `design_session_id`, counted against `max_resume_attempts`. Check for the absent row **first** and fail loudly. | `services/resume.ts`, `resume.test.ts` |
| 7 | **Playground.** Group runs by `design_session_id`, label by `classification.garment_part`. | `frontend/src/domain/runView.ts` (`groupRows` groups by `pipelineId` only today), `components/RunHistory.tsx`, `api/runs.ts` `RunRow` needs `classification` |
| 8 | **Docs.** New stages, bindings, config keys, files. | `docs/{spec,flows,architecture,directory-structure}.md`, `docs/helios-runs-conventions.md` (research cost is null; `cost_usd` understates the run) |

### Dropped from this phase

Iris research, `iris-research` prompt slot, `iris-planner-v3`, `iris-color-v4`. All need a Helios→Iris classification transport, which does not exist. Cheapest option when wanted: `classification` as an optional field on `IrisRequestSchema`, passed by the playground — but `phase-2-plan.md` §6.3 says "no request-schema change", so that needs relaxing first.

### First billed run, when the KB is ready

In this order (`phase-2-plan.md` §16):

1. `research_model: ""` — proves no regression against today's behaviour.
2. A tile concept — `mode=tile`, a query about seamless repeats, `quality=ok`.
3. A motif naming a garment part — the part appears in the query, the `classification` column, and the image prompt.
4. **A run with a reference image** — the one unverified combination: does the research model accept `tools` **and** an `image_url` part together?
5. An empty-KB run — completes, warns, `quality` thin or none.
6. `/resume` on a deliberately failed research run — new `pipeline_id`, same `design_session_id`.

In the AI Gateway dashboard expect **two** calls per Helios run (classify, planner) and the research call **absent**. That is ADR-SHARED-0005 working, not a routing bug.
