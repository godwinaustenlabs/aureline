# Phase 2 plan: mode classification, AI Search grounding, and an agentic research stage

This doc is about **what we build next**, and the exact steps for it. It picks
Phase 2 from
[tile-motif-and-agentic-capabilities-roadmap.md](tile-motif-and-agentic-capabilities-roadmap.md)
(roadmap §2.2 and §4) and adds the mode-determination step that roadmap §3
places immediately before it, because the retrieval query is built out of the
mode and cannot exist without it.

Anyone picking up a ticket from this phase should be able to read this doc and
know exactly what to build, without needing to ask what the goal is.

Everything in §3 was decided in planning. Nothing here is a guess, and the two
things that are genuinely still open are named in §14 rather than left to drift.

---

## 1. What is in this phase

Today an engine runs two stages: one planner call that turns free text into
typed params, then one image call. The planner knows nothing beyond its own
system prompt. There is no grounded, retrievable knowledge in the system at all
— a grep for `tool_calls`, `autorag`, `vectorize` or `AI Search` across
`apps/` and `packages/` returns nothing outside generated Cloudflare type
files.

The one hook that already exists is a slot deliberately left empty in Sprint 1.
`apps/agent-helios/src/prompts/planner.prompt.ts:187-194` says so out loud:

> `constraints` is the brand / design-guideline injection slot… **Unused in
> Sprint 1 — the slot exists so adding the RAG layer later does not reshuffle
> the whole prompt.**

This phase fills that slot.

| Work | What it is | Detail |
|---|---|---|
| A. Config and bindings | Each engine gets its own AI Search binding and seven new runtime-tunable keys | §5 |
| B. Mode contract | `mode` (tile / motif) and `garment_part` are classified once in Helios and stored in a `classification` column; other engines read from Helios's runs | §6 |
| C. Classify stage | A small model call that decides the mode before anything else happens | §7 |
| D. Research stage | The agentic AI Search tool loop — the model decides when and what to search | §8 |
| E. Prompts | Two new DB-backed prompt slots per engine; planner and image prompts learn about mode and retrieved context | §9 |
| F. Wiring, resume, playground | Pipeline stages, the audit row, the resume branch, and grouping runs by design | §10–§12 |

**Both engines together** — Helios and Iris. Atlas has no app in the repo yet.

**Not in this phase:** human-in-the-loop (roadmap Phase 3), generating several
garment parts in one run (see §6.3), and the output-format question (roadmap
§2.6 — explicitly still open pending AI-team research, so images stay `.jpg`
here).

---

## 2. Before you start: what a human must do in Cloudflare

AGENTS.md §11 forbids creating Cloudflare resources from code or CLI. Someone
has to do this by hand, and **nothing in this phase runs end to end until they
have**:

1. Create two **AI Search** instances in the dashboard, named `helios-kb` and
   `iris-kb`. Two separate instances, not one shared — roadmap §2.2: *"each
   engine gets its own separate KB instance, even where some content overlaps."*
2. Upload the seed Markdown into each instance's **built-in storage** (not R2,
   not a website crawl) and wait for the first index to finish.
3. Confirm the instance names back to whoever is implementing. The plan assumes
   the two names above; if they differ, only two lines in two `wrangler.jsonc`
   files change.

**Knowledge base content.** Markdown files, with topics sectioned inside each
document by heading. No filename convention — the code must not depend on
filenames, because the content layout is expected to change. This means the
tool's `description` string stays general and the grounding is tuned by editing
the KB, not by editing code.

**Good news for scheduling:** you can build and merge all of §5–§12 before the
instances exist. With no binding present, `research_model` resolves empty, the
research stage is skipped with a log line, and every Helios run behaves like
today plus a classify stage. Iris runs behave exactly as today. That is a
working state, not an outage.

---

## 3. Decisions already taken

Do not re-open these. They were settled in planning and several of them are the
reason the design looks the way it does.

| Question | Decision |
|---|---|
| How the tool loop is wired | **Two separate calls.** A research call carries the tools; the planner call keeps its strict JSON schema and is otherwise untouched |
| Engines | Helios and Iris, together |
| Who decides tile vs. motif | A **classifier stage that runs before everything else in Helios**, reading the user's prompt. Iris does not run a classifier — it reads the classification from Helios's runs via the shared `design_session_id`. No new request field — assume the concept text carries the signal |
| Classifier fails | **Stop the run**, error `classify: …` (Helios only) |
| Retrieval errors | **Stop the run**, error `research: …`, with a resume option |
| Retrieval returns nothing / very little | **Run completes.** The model may re-query within a cap; then we warn, record it, and carry on. The KB gets fixed by hand |
| Resume (no params) | Re-runs from the top. **Helios:** classify → research → planner → image. **Iris:** research → planner → image (no classify — classification already exists in Helios's text row). If it fails again, it fails again |
| Resume (image failure) | Re-runs image stage only, using the planner's `image_prompt` directly. The planner had full context when it generated that prompt |
| Research call and AI Gateway | **Ungated.** No gateway id, so no log and no cost figure. `research_cost_usd` is `null`, never `0` |
| Research model | Its own KV key, default `@cf/meta/llama-4-scout-17b-16e-instruct` — one of only three Workers AI models that list **vision *and* function calling** |
| Reference image | Goes to the **research call as well**, on top of reaching the planner as it does today |
| KB source | AI Search **built-in storage**, Markdown, sectioned by heading, no filename convention |
| Binding | One `ai_search` instance binding per engine, both named `AI_SEARCH` |
| Local dev | `"remote": true` — local dev queries the real deployed instance. Accepted |
| Grouping several parts of one design | **Reuse `design_session_id`.** The part is read out of Helios's `classification` column. No new column on Iris |
| Prompts | Helios: new `_classifier` and `_research` slots. Iris: new `_research` slot only. Dead `iris_color` / `helios_image` slots removed |
| AI Search's own query rewriting | KV-toggleable, **off by default** |
| Caps | `max_tool_iterations` 3, `max_search_results` 5, `min_chunk_chars` 200, `search_match_threshold` KV-tunable |

---

## 4. The pipeline, before and after

**Today:**

```
persist → planner → validate → image
```

**After this phase:**

```
Helios:  persist → classify → research → planner → validate → image
                         (new)      (new)

Iris:    persist → planner → validate → image
         (unchanged — reads classification from Helios's runs)
```

`type Stage` is declared at `apps/agent-iris/src/services/pipeline.ts:29` and
`apps/agent-helios/src/services/pipeline.ts:29`. Helios's gains `"classify"` and
`research"`. Iris's gains nothing — it has no classify or research stage. The
two new Helios stages are inserted between `startTextRun` and `planConcept`
(Helios `pipeline.ts:289`).

What each stage does:

1. **persist** — unchanged. Opens the `text` row as `running`.
2. **classify** — Helios only. One small model call. Reads the concept (and the
   reference image, if any) and answers `{ mode, garment_part? }`. Fails loudly.
   Iris does not run this stage — it reads the classification from Helios's runs
   via the shared `design_session_id`.
3. **research** — Helios only. The agentic loop. The model is handed a search
   tool and decides whether and what to search. Produces retrieved text, or
   nothing. Iris does not run this stage.
4. **planner** — today's call, unchanged in shape, but its system prompt now
   receives the retrieved text through the `constraints` slot (Helios) or
   classification context (Iris, read from Helios's runs).
5. **validate** — re-parses the params. On Helios, the classification is stored
   in its own column, not merged into params.
6. **image** — unchanged. One image call, one image.

**Still exactly two audit rows per invocation.** ADR-0001 is untouched: one
`text` row and one `image` row sharing a `pipeline_id`. The two new stages add
no rows and no columns, so **there is no migration to the runs tables.**

---

## 5. Work A: Config and bindings

### 5.1 The AI Search binding

Add to **both** `apps/agent-helios/wrangler.jsonc` and
`apps/agent-iris/wrangler.jsonc`:

```jsonc
/**
 * Each engine's own knowledge base (roadmap §2.2) — deliberately NOT shared,
 * unlike the R2 bucket. The binding name is `AI_SEARCH` on every engine so
 * research.ts reads identically everywhere; the instances are told apart by
 * `instance_name`.
 *
 * `remote: true` is required, not optional. AI Search has no local simulator,
 * so without it `wrangler dev` has no retrieval at all. Note this means local
 * dev queries the REAL deployed instance.
 */
"ai_search": [
  {
    "binding": "AI_SEARCH",
    "instance_name": "iris-kb",   // "helios-kb" on Helios
    "remote": true
  }
]
```

**Do not use `env.AI.autorag()` or `env.AI.aiSearch()`.** Both are already
marked `@deprecated` in the `worker-configuration.d.ts` committed in this repo:
*"AutoRAG has been replaced by AI Search. Use the standalone
`ai_search_namespaces` or `ai_search` Workers bindings instead."*

After editing either `wrangler.jsonc`, run `npm run cf-typegen` **from inside
that app** and commit the regenerated `worker-configuration.d.ts` in the same
commit (AGENTS.md §9).

### 5.2 Seven new config keys, per engine

All runtime-tunable from KV, all with a committed fallback var, following the
existing five-key `FIELDS` pattern exactly (Helios `src/config.ts:203-283`,
Iris `src/config.ts:164-229`).

| KV key | Config field | wrangler var | Validation | Default |
|---|---|---|---|---|
| `research_model` | `researchModel` | `RESEARCH_MODEL` | `TextModelSchema` | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| `classifier_model` | `classifierModel` | `CLASSIFIER_MODEL` | `TextModelSchema` | same as above |
| `max_tool_iterations` | `maxToolIterations` | `MAX_TOOL_ITERATIONS` | int 1–10 | `3` |
| `max_search_results` | `maxSearchResults` | `MAX_SEARCH_RESULTS` | int 1–20 | `5` |
| `min_chunk_chars` | `minChunkChars` | `MIN_CHUNK_CHARS` | int 0–5000 | `200` |
| `search_match_threshold` | `searchMatchThreshold` | `SEARCH_MATCH_THRESHOLD` | number 0–1 | `0.5` |
| `ai_search_query_rewrite` | `queryRewrite` | `AI_SEARCH_QUERY_REWRITE` | bool from string | `false` |

**Why `research_model` is a separate key and not just the planner's model.**
The planner resolves to `vision_planner_model` when a reference image is
attached, and that model — `@cf/meta/llama-3.2-11b-vision-instruct` — does
**not** list function calling. Reusing it would mean retrieval silently never
fires on exactly the runs that carry an image, with no error anywhere. A
separate key makes the tool-capable model an explicit choice.

**`research_model: ""` is the off switch.** Same convention as
`VISION_PLANNER_MODEL` today: an empty string skips the whole research stage
with a log line, no deploy needed.

**Why query rewriting is off by default.** AI Search can rewrite the query with
its own LLM before searching. The model is already writing the query itself —
that is the entire point of the agentic design — so leaving rewrite on adds a
second billed model call we do not control, per search. The key exists so you
can A/B it from KV later.

### 5.3 Steps for each key

Six mechanical edits, all visible in the existing code:

1. Add the field to the `HeliosConfig` / `IrisConfig` interface.
2. Add its name to the `source: Record<…>` union — omitting it breaks
   `describeConfig`'s typecheck, which is the point.
3. Add a Zod schema if it is not a plain number or model.
4. Add the `FIELDS` entry (`key`, `field`, `var`, `schema`, `prepare`,
   `fromVar`, `describe`).
5. Add the var to `ConfigEnv`.
6. Add the var to `wrangler.jsonc`, then `npm run cf-typegen`.

### 5.4 One new selector

Beside `plannerModelFor` (Helios `config.ts:365-374`), on both engines:

```ts
/**
 * The model that makes the research call, or null when research is switched
 * off. Null rather than a throw: an unconfigured KB is a working state, and
 * every engine must keep running before the instances exist.
 */
export function researchModelFor(config: IrisConfig): TextModelConfig | null
```

---

## 6. Work B: The mode contract

### 6.1 The shared classification type

`packages/shared-types/src/v1/common.ts` — shared, because classification is
engine-independent and both engines must agree on the vocabulary:

```ts
export const DesignModeSchema = z.enum(["tile", "motif"]);

export const ClassificationSchema = z.object({
  mode: DesignModeSchema,
  /** Which garment part this run is for. Motif runs only; absent on tile. */
  garment_part: z.string().trim().min(1).max(64).optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;
```

### 6.2 Classification lives in its own column — not in params

The classifier's output is stored in a dedicated `classification` column on
Helios's text row (`helios_runs`), not merged into `planner_params`. The column
stores the full `Classification` object: `{ mode: "tile" }` or
`{ mode: "motif", garment_part: "front" }`.

**Why a separate column, not a merge into params.** The classification is
infrastructure — it is the classifier's decision about what kind of design this
is, not a creative output of the planner. Keeping it separate means:

- `HeliosParamsSchema` and `IrisParamsSchema` are **unchanged** — no
  `*PlannerOutputSchema` needed, no `.omit()`, no merge at validate.
- The planner's schema stays exactly what it is today. The mode is passed to
  the planner via the `constraints` slot in the system prompt, not as a field
  the planner produces.
- Resume is simpler: image retry uses the planner's `image_prompt` directly,
  with no classification to re-merge.
- The playground reads `classification` from Helios's text row, not from
  `planner_params`.

**The column on Helios's DO schema:**

```ts
classification: text("classification", { mode: "json" }).notNull(),
```

Default value: `{}` (empty object) before the classifier runs. After the
classifier succeeds, it is overwritten with the full `Classification` object.

**D1 export impact.** Helios currently has 12 columns in `helios_runs` and
`MAX_ROWS_PER_INSERT = 8` (12 × 8 = 96 ≤ 100). Adding `classification` makes
it 13 columns, so `MAX_ROWS_PER_INSERT` drops to **7** (13 × 7 = 91 ≤ 100,
13 × 8 = 104 > 100). The comment in `d1.repository.ts` and the arithmetic
test must be updated.

**Iris does not gain this column.** Iris reads the classification from
Helios's runs via the shared `design_session_id`. Iris's schema is unchanged.

### 6.3 No request-schema change

The user's concept text carries the mode signal, so `HeliosRequestSchema` and
`IrisRequestSchema` are untouched and every existing caller keeps working.

**One part per run.** A motif run generates one garment part, one image call,
two audit rows. Building several parts in one invocation would mean N image
calls and 1+N rows, which contradicts ADR-0001 outright and needs a superseding
ADR, a wire-contract change and playground work — a phase of its own. Users
build parts one at a time and the runs are grouped afterwards (§12).

---

## 7. Work C: The classify stage

**Helios only.** The classifier runs once in Helios before anything else.
Other engines (Iris, Atlas) read the classification from Helios's runs via the
shared `design_session_id`. There is no classifier stage in Iris's pipeline.

New file: `apps/agent-helios/src/services/classifier.ts`.

```ts
export async function classifyConcept(
  env: Env,
  config: HeliosConfig,
  run: {
    concept: string;
    systemPrompt: string;
    pipeline_id: string;
    image?: ReferenceImage;
  },
): Promise<TextualModelOutput<Classification>>
```

This is deliberately the least novel thing in the phase. It reuses
`getTextualModelOutput` completely unchanged: same Chat Completions shape, same
`response_format: json_schema, strict: true`, same gateway config, same retry
loop, same `maxRetries` from config. Copy `planner.ts`'s structure. The only
differences are the schema (`ClassificationSchema` — two fields) and the model
(`config.classifierModel`).

Notes:

- **`maxOutputTokens` stays at the helper's default (2048).** The answer is
  ~30 tokens, but gpt-oss-style models spend part of the budget thinking before
  writing, and ADR-0007 records exactly what happens when that budget is too
  tight: the JSON truncates mid-object, looks like the model misbehaving, and
  gets retried and billed again.
- **The reference image is passed here too.** The classifier model is
  vision-capable, and a photo of a repeating scarf print versus a photo of an
  embroidered neckline is precisely the signal that separates tile from motif.
- **It routes through the gateway** (ADR-0006), and its cost is read
  immediately after the call. See §11.
- **Failure throws.** `runPipeline`'s existing catch records
  `error: "classify: …"`, fails both rows, and returns. No new error machinery.

Log line, matching the planner's existing style:

```
classify: model=… mode=motif part=neckline images=1 pipeline=…
```

---

## 8. Work D: The research stage and the AI Search tool

Two new files: `packages/shared-utils/src/runToolLoop.ts` (shared, engine-
agnostic) and `src/services/research.ts` on each engine.

### 8.1 `getTextualModelOutput` is not modified

Worth stating plainly, because it looks like the obvious place to put this and
it is the wrong one:

- Its body is pinned to `response_format: json_schema, strict: true`. Telling a
  model "your next output must satisfy this schema" and "you may call tools" in
  the same request is a conflict the provider resolves however it likes. If it
  resolves it by never emitting `tool_calls`, we get a perfectly valid params
  object back, zero errors, and retrieval simply never happened — with nothing
  in the run to say so. `temp logs.md` in this repo already shows
  `@cf/openai/gpt-oss-120b` returning `"function_call": null` on every call.
- Its retry loop already mutates `messages` in place to append schema-repair
  turns (`appendCorrection`, `getTextualModelOutput.ts:293-311`). Interleaving
  tool turns into the same array puts one `maxRetries` counter in charge of two
  unrelated budgets — a repair budget and a tool budget. ADR-0009 exists to
  keep "one attempt" meaning one billed call.
- It is used by both engines and ~45 tests, for a behaviour only one stage
  needs.

So the tool loop is a **sibling helper**. Two calls per run instead of one is
the price, and what it buys is a run where *"the model chose not to search"* and
*"the model could not search"* are distinguishable in the log.

### 8.2 The tool definition

```ts
{
  name: "search_design_reference",
  description:
    "Search the textile design reference knowledge base for guidance on how a " +
    "correct output looks for a given mode and garment part. Call this before " +
    "deciding the design direction.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A natural-language search query." },
    },
    required: ["query"],
  },
}
```

Deliberately general, with no mention of filenames or document structure,
because the KB layout is expected to change and code that assumes a filename
convention breaks silently when it does.

### 8.3 The loop

Bounded by `config.maxToolIterations` — AGENTS.md §7: anything that can trigger
a repeated model call needs a bounded attempt count.

1. **Call the model, ungated:**

   ```ts
   await ai.run(researchModel, { messages, tools, max_tokens }, undefined);
   ```

   No third argument at all. Messages are: the research system prompt (from the
   DB slot), the concept, the classification result, and the reference image as
   `image_url` parts if one was attached — the same content shape
   `buildUserContent` already produces in `getTextualModelOutput`.

2. **No `tool_calls` in the reply → stop.** Retrieval did not happen. That is a
   legitimate outcome, recorded as `quality: "none"`, not an error.

3. **Otherwise run the search:**

   ```ts
   await env.AI_SEARCH.search({
     messages: [{ role: "user", content: query }],
     ai_search_options: {
       retrieval: {
         max_num_results: config.maxSearchResults,
         match_threshold: config.searchMatchThreshold,
       },
       query_rewrite: { enabled: config.queryRewrite },
     },
   });
   ```

   The response carries `search_query` and a `chunks` array; each chunk has
   `text`, `score`, and `item.key` (the source document).

4. **Measure the result.** If the total text is under `config.minChunkChars`,
   the `role: "tool"` message handed back says so explicitly — *"no strong
   matches for that query; try different wording"* — so the model can rephrase
   and search again rather than giving up on a thin first attempt.

5. **Push the tool result and loop**, until the model stops calling tools or the
   iteration cap is reached.

### 8.4 What happens with a thin or empty result

At the cap, or when everything came back thin: **warn loudly, record
`retrieval_quality: "thin"`, and proceed to the planner.** An empty knowledge
base is a working state, not an outage — the same never-throw discipline
`resolveConfig` (ADR-0008) and `resolvePrompt` already follow. This is also what
makes it possible to ship this phase before the KB content exists.

An AI Search **exception** is a different thing and does stop the run, at
`research:`, with a resume option (§10.3).

### 8.5 Rendering the chunks for the planner

Following Cloudflare's own bring-your-own-generation-model guidance, so
provenance survives into the prompt and the planner can be told where a claim
came from:

```ts
chunks
  .map((c) => `<source name="${c.item.key}">${c.text}</source>`)
  .join("\n\n");
```

That string is what goes into the planner's `constraints` slot.

---

## 9. Work E: Prompts

### 9.1 New DB slots

Prompts are database-backed as of Phase 1 Work C, editable in the playground
with no deploy. The classifier and research prompts are the two most likely in
the whole system to need tuning against a live KB, so they belong in the
database, not in code.

**Helios** gets two new slots (classifier runs here):

```ts
// Helios — was ["helios_planner", "helios_image"]
enum: ["helios_planner", "helios_classifier", "helios_research"]
```

**Iris** gets one new slot (research only — classification comes from Helios):

```ts
// Iris — was ["iris_planner", "iris_color"]
enum: ["iris_planner", "iris_research"]
```

The removed `iris_color` / `helios_image` slots were dead — nothing has ever
read them (`db-prompt-rows.md`: *"The other two slots are dead - nothing reads
them"*).

**Expect no migration.** Drizzle's `text(col, { enum })` is a TypeScript-level
constraint that emits plain `text` with no `CHECK`, so changing the list should
produce an empty diff. Run `npm run db:generate:d1` inside each app and confirm
that. If it *does* produce a migration, commit it exactly as generated —
migrations are never hand-edited (AGENTS.md §8). Any leftover `iris_color` rows
become unreferenced data; a human deletes them or leaves them inert.

`resolvePrompt(d1, slot, codeFallback)` reads the new slots exactly as it reads
the planner ones today, and never throws — no row, a too-short row, or D1 being
down all fall back to the code string.

### 9.2 New prompt files

Helios gets two new prompt files. Iris gets one (research only). **Never edit a
prompt in place — bump the ID.**

| File | Exports |
|---|---|
| `src/prompts/classifier.prompt.ts` (Helios only) | `HELIOS_CLASSIFIER_PROMPT_VERSION`, `buildClassifierSystemPrompt()` — how to read tile vs. motif out of a concept, and the vocabulary for naming a garment part |
| `src/prompts/research.prompt.ts` (both engines) | `*_RESEARCH_PROMPT_VERSION`, `buildResearchSystemPrompt(classification)` — that a search tool exists, when to use it, and to search on the mode and part it has been given |

### 9.3 Changed prompt files

**`planner.prompt.ts`, both engines.** The `constraints` argument is finally
used. The prompt also gains explicit guidance on **how to use everything now
arriving at it** — the `<source>` blocks, the mode, and the garment part — since
more context in front of a model is worth nothing if the model has not been told
what to do with it. Iris's `buildPlannerSystemPrompt()` has no `constraints`
parameter today and gains Helios's. Bump to `helios-planner-v3` /
`iris-planner-v3`.

Ordering is already settled by the existing comment and must not change:
constraints sit **after** the field grounding and **before** the examples —
injected constraints override general guidance, while the examples still get the
last word on output shape.

**`image.prompt.ts` / `color.prompt.ts`.** Mode-selected clauses:

- **tile** — one seamless repeating unit, edges continuous, no visible seam.
- **motif** — a single motif for the named garment part, theme consistent,
  part-appropriate.

Bump to `helios-image-v4` / `iris-color-v4`. On Helios the mode clause must land
**before** `Do not include:` — the monochrome lock and exclusion list are
ADR-0002 promises, and there is already a test asserting the reference-image
clause lands before the exclusions. Extend it.

---

## 10. Work F: Wiring

### 10.1 The pipeline

**Helios** — `runPipeline`, between `startTextRun` and `planConcept`:

```ts
stage = "classify";
const classified = await classifyConcept(env, config, {
  concept: req.concept, systemPrompt: classifierPrompt.text,
  pipeline_id: pipelineId, image: req.image,
});
const classifyCost = await readGatewayCost(env, "classify");

stage = "research";
const research = await runResearch(env, config, {
  concept: req.concept, classification: classified.data,
  systemPrompt: researchPrompt.text, pipeline_id: pipelineId, image: req.image,
});
// no cost read here — the research call is ungated by decision

stage = "planner";
const planned = await planConcept(env, config, {
  concept: req.concept, systemPrompt: plannerPrompt.text,
  pipeline_id: pipelineId, image: req.image,
  constraints: research.context,          // the new field
});
const plannerCost = await readGatewayCost(env, "planner");

stage = "validate";
params = HeliosParamsSchema.parse(planned.data);
// classification is stored separately in its own column, not merged into params
```

**Iris** — no classify stage. Iris reads the classification from Helios's
runs via the shared `design_session_id`. Its pipeline is:

```
persist → research → planner → validate → image
```

The research stage in Iris uses the classification read from Helios to
inform its search queries. The `classification` field is passed to
`runResearch` after reading it from Helios's runs (via the playground or
a direct query to Helios's `/runs` endpoint with the `design_session_id`).

`planConcept`'s `run` parameter is already an options object, so `constraints`
is one additive optional field — no new positional strings (AGENTS.md §6).

The three prompts are resolved once per invocation alongside the existing
planner prompt, next to the `resolvePrompt` call already at Iris
`pipeline.ts:269` / Helios `:260`.

### 10.2 The audit row

**Helios** — `model_metadata` on the `text` row is a free-form `notNull()` JSON
column, so everything below lands with **no migration** (`:306-327`):

```ts
{
  ...existing,                        // model, usage, prompt_source, had_reference_image, …
  classifier: { model, usage, prompt_source, cost_usd },
  retrieval: {
    instance: "helios-kb",
    enabled: true,                    // false when research_model is ""
    queries: ["…"],                   // what the model actually chose to search for
    chunks: [{ key, score, chars }],  // provenance, not the chunk text itself
    iterations: 2,
    quality: "ok" | "thin" | "none",
    cost_usd: null,                   // ungated, by decision — never 0
  },
}
```

The `classification` is stored in its own dedicated column on the text row
(`classification`), not inside `model_metadata`. This is the classifier's
output: `{ mode: "tile" }` or `{ mode: "motif", garment_part: "front" }`.
The column opens as `{}` before the classifier runs and is overwritten on
success.

**Iris** — no classifier metadata. Iris's `model_metadata` gains only the
`retrieval` block (same shape as above, with `instance: "iris-kb"`). The
classification is read from Helios's text row, not stored on Iris's rows.

`chunks` stores keys and scores, not the retrieved text. The text can be tens
of kilobytes per run and it is reproducible from the query; the keys are what
you actually need to answer *"which document made it say that."*

### 10.3 Resume

`src/services/resume.ts`, both engines, gains **one** branch.

Today resume re-runs the image stage of a run whose params already exist. A
`classify:` or `research:` failure produces no params at all, so there is
nothing for today's resume to resume.

**The new branch:** when the failed run has **no params**, resume re-runs
the full pipeline under a **new `pipeline_id`** sharing the original
`design_session_id`, counted against `max_resume_attempts` exactly like any
other resume. If it fails again, it fails again — no special retry, no
escalation, no second retry layer.

**Helios:** the full pipeline is `classify → research → planner → image`.
**Iris:** the full pipeline is `research → planner → image` (no classify —
the classification already exists in Helios's text row from the first run).

**Image retry is simpler.** When the image stage fails but params exist, resume
re-runs the image stage only — using the planner's `image_prompt` directly. The
planner already had full context (classification, research results) when it
generated that prompt, so re-running the image with the same params is
sufficient. No need to re-classify, re-search, or re-plan.

AGENTS.md §7 applies directly: check for the absent/malformed row **first** and
fail loudly. The guard is an explicit "params absent" check, never optional
chaining that quietly falls through into a second billed generation.

---

## 11. Cost and where it is recorded

`readGatewayCost` reads `env.AI.aiGatewayLogId`, which holds only **the most
recent routed call** on the binding (`src/services/gatewayCost.ts:36-48`).

**Helios** has three model calls per run, ordering is load-bearing:

| Call | Gateway | Cost |
|---|---|---|
| classify | on | read immediately after → `classify_cost_usd` |
| research | **off** | never read → `research_cost_usd: null` |
| planner | on | read immediately after → `planner_cost_usd` |

The ungated research call sits *between* two gated calls and never sets
`aiGatewayLogId`, so it cannot overwrite anything. Each cost is read immediately
after its own call. Nothing is misattributed.

The text row's single `cost_usd` column holds `classify + planner`.

**Iris** has two model calls per run (no classify):

| Call | Gateway | Cost |
|---|---|---|
| research | **off** | never read → `research_cost_usd: null` |
| planner | on | read immediately after → `planner_cost_usd` |

The text row's single `cost_usd` column holds `planner` only.

**A missing figure is `null`, never `0`.** ADR-0007's closing rule: *"A usage
figure of zero means the provider did not report anything, not that the call was
free. Saving a zero into a cost column is worse than saving nothing, because a
report built on it will look correct while being wrong."*

### The ADR this needs

Bypassing the gateway contradicts ADR-0006 (*all Workers AI calls route through
AI Gateway*). AGENTS.md §1 requires that be said out loud, not slipped in:

**`docs/adr/shared/0005-the-research-call-is-ungated-and-bounded.md`** — why the
research call carries no gateway id, why the ordering above makes that safe, why
`research_cost_usd` is `null` rather than `0`, and why the tool loop is a
sibling helper rather than a change to `getTextualModelOutput`. Add a pointer at
the top of ADR-0006, the way ADR-SHARED-0003 points at 0004.

---

## 12. Playground

The smallest surface in the phase, because the grouping key already exists.

- **`src/server/prompts.ts`** — `ENGINE_SLOTS` becomes
  `{ helios: ["helios_planner","helios_classifier","helios_research"], iris: ["iris_planner","iris_research"] }`.
  Iris has no classifier slot.
- **`PromptsPanel.tsx`** — `SLOT_LABELS` for the three new slots (Helios:
  classifier, research; Iris: research); `LIVE_SLOTS` grows to all five, so
  the "not read yet" chip disappears entirely. Nothing is dead any more.
- **`RunHistory.tsx` / `domain/runView.ts`** — group rows by
  `design_session_id` and label each by Helios's `classification.garment_part`
  (read from Helios's text row), so the neckline, sleeve and body runs of one
  design read as one set.
  `domain/designSession.ts` already mints and reuses the id — no new state, no
  new API call.

This is exactly what `design_session_id` already means per AGENTS.md §3: *"one
design, across every engine… the id that answers 'show me everything that went
into this design.'"*

**No API-client change.** `/generate` and `/resume` request bodies are
unchanged.

---

## 13. Failure behaviour, in one table

| What happens | Result |
|---|---|
| Classifier throws or returns an invalid shape | Run **fails** at `classify:`. Both rows failed. Resume available |
| `research_model` is `""` | Research **skipped** with a log line. Run continues, `retrieval.enabled: false` |
| No AI Search binding / instance missing | Same as a research error → run **fails** at `research:` |
| AI Search throws | Run **fails** at `research:`. Resume available |
| Model calls no tool | Run **completes**. `quality: "none"` |
| Search returns nothing, or under `min_chunk_chars` | Model may re-query within the cap; then **warn and continue**. `quality: "thin"` |
| Iteration cap reached | **Warn and continue** with whatever was retrieved |
| Planner or image fails | Exactly as today |

---

## 14. Files touched

| File | Change |
|---|---|
| `apps/agent-helios/wrangler.jsonc` + `worker-configuration.d.ts` | `ai_search` binding, seven vars, then `cf-typegen` |
| `apps/agent-iris/wrangler.jsonc` + `worker-configuration.d.ts` | `ai_search` binding, seven vars, then `cf-typegen` |
| `apps/agent-helios/src/config.ts` | seven `FIELDS` entries, `researchModelFor`, `source` union |
| `apps/agent-iris/src/config.ts` | seven `FIELDS` entries, `researchModelFor`, `source` union |
| `apps/agent-helios/src/db/schema.ts` | **new `classification` column** (JSON, not null, default `{}`) |
| `apps/agent-helios/src/db/schema.d1.ts` | slot enum → `helios_planner`, `helios_classifier`, `helios_research` |
| `apps/agent-iris/src/db/schema.d1.ts` | slot enum → `iris_planner`, `iris_research` (no classifier) |
| `apps/agent-helios/src/services/classifier.ts` | **new** (Helios only) |
| `apps/agent-helios/src/services/research.ts` | **new** |
| `apps/agent-iris/src/services/research.ts` | **new** |
| `apps/agent-helios/src/services/pipeline.ts` | classify + research stages, classification column write, metadata |
| `apps/agent-iris/src/services/pipeline.ts` | research stage only, no classify |
| `apps/agent-helios/src/services/planner.ts` | `constraints` threaded into the system prompt |
| `apps/agent-iris/src/services/planner.ts` | `constraints` threaded into the system prompt |
| `apps/agent-helios/src/services/resume.ts` | the no-params branch |
| `apps/agent-iris/src/services/resume.ts` | the no-params branch |
| `apps/agent-helios/src/prompts/classifier.prompt.ts` | **new** (Helios only) |
| `apps/agent-helios/src/prompts/research.prompt.ts` | **new** |
| `apps/agent-iris/src/prompts/research.prompt.ts` | **new** |
| `apps/agent-helios/src/prompts/planner.prompt.ts` | constraints used, context guidance, v3 |
| `apps/agent-iris/src/prompts/planner.prompt.ts` | constraints used, context guidance, v3 |
| `apps/agent-helios/src/prompts/image.prompt.ts` | mode clauses, v4 |
| `apps/agent-iris/src/prompts/color.prompt.ts` | mode clauses, v4 |
| `apps/agent-helios/src/repository/d1.repository.ts` | **`MAX_ROWS_PER_INSERT` drops from 8 to 7** (13 columns × 7 = 91 ≤ 100) |
| `packages/shared-utils/src/runToolLoop.ts` | **new**, exported from the barrel |
| `packages/shared-types/src/v1/common.ts` | `DesignModeSchema`, `ClassificationSchema` |
| `apps/frontend/src/server/prompts.ts`, `components/{PromptsPanel,RunHistory}.tsx`, `domain/runView.ts` | slots and grouping |
| `docs/adr/shared/0005-…` | **new ADR** |
| `docs/{spec,flows,architecture,directory-structure}.md` | new stages, bindings, config keys, files |
| `packages/shared-utils/src/getTextualModelOutput.ts` | **not touched** |
| Helios DO migration | **one migration** — adds `classification` column to `helios_runs` |
| Iris DO migration | **none** — no new columns |
| D1 migrations | **none** — slot enum changes are TypeScript-level only |

---

## 15. Tests

AGENTS.md §5: complete real objects, never a partial plus a cast. No `as never`,
no network, no model calls. Fake the `AI` binding, and fake `AI_SEARCH` as a
plain object with a `search` method.

| File | What it must prove |
|---|---|
| `runToolLoop.test.ts` | stops when the reply has no `tool_calls`; stops at `maxToolIterations` and does **not** call again; a thin result produces the rephrase nudge and the model gets a second chance; an AI Search throw propagates |
| `classifier.test.ts` (Helios only) | a tile concept and a motif concept classify correctly; a schema-invalid reply throws rather than defaulting to a mode; classification is written to the `classification` column, not merged into params |
| `research.test.ts` (both engines) | ungated — the third `ai.run` argument is `undefined` and `readGatewayCost` is never called on this path; the `<source>` rendering is exact; `quality` is `none` / `thin` / `ok` in the three cases |
| `pipeline.test.ts` (Helios) | six stages in order; a classify failure gives `error: "classify: …"` and two failed rows; the `classification` column carries the classifier's output; `cost_usd` is classify + planner and a missing figure is `null`, never `0` |
| `pipeline.test.ts` (Iris) | four stages in order (no classify); research stage works; `cost_usd` is planner only |
| `config.test.ts` | all seven keys resolve from KV, fall back to the var, and warn on a bad value; `researchModelFor` returns `null` for an empty model id |
| `resume.test.ts` (Helios) | a no-params failed run re-runs from classify under a new `pipeline_id` with the same `design_session_id`, counted against `max_resume_attempts`; a run that already has params resumes exactly as today (image only) |
| `resume.test.ts` (Iris) | a no-params failed run re-runs from research (no classify) under a new `pipeline_id` with the same `design_session_id`, counted against `max_resume_attempts`; a run that already has params resumes exactly as today (image only) |
| `{image,color}.prompt.test.ts` | tile and motif clauses are mutually exclusive; on Helios the mode clause lands **before** `Do not include:` |
| `planner.prompt.test.ts` | with no `constraints`, the string is byte-identical to v2's |
| `d1.repository.test.ts` (Helios) | `MAX_ROWS_PER_INSERT` is 7 and the arithmetic test passes with 13 columns |
| frontend `prompts.test.ts`, `worker.test.ts` | Helios slots include `helios_classifier`; Iris slots do **not** include `iris_classifier` |

---

## 16. Verification

1. `npm test` from the repo root — free. 645 currently pass; nothing may
   regress.
2. `npx tsc --noEmit` from **inside** each of `apps/agent-iris`,
   `apps/agent-helios`, `apps/frontend`, `packages/shared-types`,
   `packages/shared-utils`. Never from the root — the apps use
   `moduleResolution: node`.
3. `npm run cf-typegen` inside each app after the `wrangler.jsonc` edits.
4. `npm run db:generate:d1` inside each app — expect an **empty** diff (§9.1).
5. **Billed, and only on an explicit go-ahead.** In this order:
   - **Research off** (`research_model: ""` in KV) — must be identical to
     today's behaviour apart from the classify stage on Helios. This is the
     regression proof and it comes first.
   - **A tile concept** — log shows `mode=tile`, a search query about seamless
     repeats, chunks returned, `retrieval.quality="ok"`.
   - **A motif concept naming a garment part** — the part appears in the query,
     in Helios's `classification` column, and in the image prompt.
   - **A run with a reference image** — confirms the research model accepts
     `tools` **and** an `image_url` part in the same request. This is the one
     genuinely unverified combination in the phase.
   - **An empty-KB run** — completes, warns, `quality` is `thin` or `none`.
   - **`/resume` on a deliberately failed research run** — new `pipeline_id`,
     same `design_session_id`.
6. In the AI Gateway dashboard, confirm **two** calls logged per Helios run
   (classify and planner) and the research call absent. Iris shows only planner
   (no classify). That is the ungated decision working as designed, not a
   routing bug.

**Never run a deploy.** A human does that (AGENTS.md §10, §11).

---

## 17. Git

Branch naming per AGENTS.md §10, cut from the engine's integration branch. Far
over the ~400-line guidance as one change, so split it:

| PR | Contents |
|---|---|
| 1 | §5 config and the `ai_search` bindings, plus `cf-typegen`. No behaviour change |
| 2 | §6 contract (`classification` column in Helios schema, `ClassificationSchema`) + §7 Helios classify stage, its prompt and its slot + D1 export chunk size update |
| 3 | `runToolLoop` + §8 research stage (both engines) + the new ADR |
| 4 | §9 prompt changes and version bumps + §10.2 metadata wiring |
| 5 | §10.3 resume branch + §12 playground + docs updates |

Tick the ticket's checkboxes in the same PR that does the work.

---

## 18. Risks accepted, and what is still open

**Accepted risks:**

- **Vision + tools in one request is unverified.**
  `@cf/meta/llama-4-scout-17b-16e-instruct` lists both capabilities, but nobody
  has sent both at once. If it refuses, the fallback is a text-only research
  call — a config change, not a code change, because the image is threaded as an
  optional field. The two alternatives that also list both are
  `@cf/zhipu/glm-5.3-flash` and `@cf/qwen/qwen3.8-27b`.
- **The research call has no cost figure and no gateway log.** By decision.
  Recorded as an explicit `null` with a log line.
- **Three model calls per run instead of one**, so a run costs meaningfully more
  before the image call is even reached. The off switch and
  `max_tool_iterations` are the two levers.
- **`remote: true` means local dev queries production AI Search.** Queries are
  free within beta limits, but query rewriting — if you turn it on — spends
  Workers AI from a local `npm run dev`.
- **AI Search is beta-priced.** Free within limits today; Cloudflare promises 30
  days' notice before billing starts. Worth a calendar reminder.
- **Prompt tuning is not budgeted here.** The phrase tables were tuned for Flux
  Schnell and text-only planning. The first billed runs against a real KB are
  where the mode clauses and the context guidance will need work.

**Still open:**

- **`search_match_threshold`'s starting value.** Set at `0.5` and KV-tunable. On
  a new KB a threshold that is too high returns zero chunks on every query and
  looks exactly like a broken binding — check the first runs' logged scores
  before trusting it.
- **Output format.** Roadmap §2.6 ("vector or PNG, never JPG") is explicitly
  still open pending AI-team research. Images stay `.jpg` in this phase.
  Changing that is its own piece of work and must not be smuggled in here.
