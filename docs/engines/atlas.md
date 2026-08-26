# Atlas — the Repeat Engine

Only what differs from the engine shape the main docs describe. [architecture.md](../architecture.md), [spec.md](../spec.md), [database.md](../database.md) and [flows.md](../flows.md) use Helios as the worked example, and everything in them holds for Atlas unless it is contradicted here.

**Atlas takes Iris's colored pattern and places it onto a garment.** It is the last hop of Helios → Iris → Atlas, and the output is the thing the two-engine sprint exists to show.

## The state it is in

The pipeline is complete and the image call is **faked**. `POST /generate` runs real validation, writes a real row, saves real bytes to R2, exports to D1 and returns a real `AtlasResult` — but `services/placer.ts` returns a fixture image and spends nothing. atlas-07 replaces that one function body with the real image-to-image call; its signature is already the final one, so no call site moves.

| | |
|---|---|
| Contract, `atlas_runs`, repository, pipeline, routes, D1 export, pruning | Built |
| Garment glossary and `buildPlacementPrompt` | Built (final wording pending atlas-03) |
| The real model call | **Faked.** atlas-07 |
| `POST /resume`'s behaviour | **Route and validation only.** atlas-08 |
| Playground Atlas tab | Not started. atlas-10 |

## Four things that differ from Helios

**One audit row per invocation, not two.** Atlas has a single billable call and no text stage, so there is no partial-success case for a `modality` column to represent. `atlas_runs` has twelve columns and no `modality`. Code that assumes two rows will not crash on an Atlas run — it will render a `NaN` cost and look like a backend bug. [ADR-ATLAS-0001](../adr/atlas/0001-atlas-has-one-image-call-and-one-audit-row.md) has the full argument, including what would change the answer.

**No text model, and no free-text field on the request.** Every creative decision is already made upstream: repeat and linework by Helios, colour by Iris, and garment/region/coverage/scale are closed enums the caller picks from. So `AtlasRequestSchema` has no `concept`, no `notes`, no `style`. That is a safety property as much as a design one — with no text model to interpret it, free text would pass straight into a billed image prompt unvalidated.

**Four config keys, not five.** `image_model`, `max_retries`, `retention_limit`, `max_resume_attempts`. **There is no `text_model`.** `max_retries` exists so all four resolve through the same code path the other engines use, and governs nothing on Atlas's image path — nothing in Atlas auto-retries.

**The R2 bucket is shared with Iris.** Both bind `PATTERNS` to `images-bucket`. R2 has no migrations and no schema, so there is nothing two squads writing to one bucket can break — unlike D1, which stays per-engine until shared-03. Keys carry an engine prefix instead: `atlas/{pipeline_id}.jpg` and `iris/{pipeline_id}.jpg`. Helios keeps its own bucket and its own `patterns/` prefix, which names the file type rather than the engine, because it never needed to distinguish one.

## Two inputs, and the order matters

The request carries two references, and they are not symmetric:

| Field | What it is | Validation |
|---|---|---|
| `pattern_ref` | Iris's `image_url`, **or** an R2 key under `iris/` in the shared bucket | a loose string |
| `garment_ref` | A URL to the caller's photo of the actual garment | `.url()`, strictly |

`garment_ref` is a URL and never an R2 key, because there is no upload endpoint this sprint — nothing writes a caller's photo into our buckets. That is why one is validated as a URL and the other deliberately is not.

When atlas-07 lands, the pattern goes to the model as `input_image_0` and the garment as `input_image_1`, **always in that order**, because `buildPlacementPrompt`'s text refers to "the FIRST image" and "the SECOND image". Swapping them does not error; it produces a worse picture.

## Retry: nothing, at all

[ADR-0009](../adr/0009-retry-policy-is-per-stage-not-per-pipeline.md) says the policy is decided per stage. Read carefully for Atlas: Iris's text stage auto-retries because a slightly-wrong JSON reply is cheap and usually succeeds on a second ask. **Atlas has no such stage.** Its one call is expensive, one-shot, and likely to fail the same way twice, so every automatic retry would be a full duplicate charge on literally every failure.

A person retries by calling `POST /resume`, capped by `max_resume_attempts` counted over the **root** brief. Counting the immediate parent instead would let a chain of resumes each start a fresh count and spend without limit.

## Running it

Same as Helios ([running-locally.md](../running-locally.md)), with three differences:

```bash
npm run dev --workspace=apps/agent-atlas     # http://localhost:8787
curl localhost:8787/                          # Atlas Agent is running
```

- **Nothing bills today.** The image call is faked and the test suite's `AI` binding throws if anything touches it. If you see a charge from Atlas right now, that is the bug.
- **Run `npx tsc --noEmit` from inside `apps/agent-atlas`**, never the repo root, which resolves a TypeScript that rejects this project's `moduleResolution`.
- **Reach local KV through `npm run kv:put` / `kv:get`**, never bare `wrangler` from the root, which finds no `wrangler.jsonc` and silently does nothing.

`database_id` and the KV namespace `id` in `wrangler.jsonc` are placeholders. Local dev simulates both and needs neither; a deploy against the real API needs both.
