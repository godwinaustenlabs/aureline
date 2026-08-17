# Sprint 2 summary: Iris and Atlas

Both sprints follow the same shape: build the pipeline against fake data first, then swap in the real model call.

## Iris sprint , the Chromatic Engine

**Job:** takes Helios's black-and-white motif and colors it. Nothing else, no tiling, no placement (that's Atlas).

### Phase 1: skeleton against sample data

- Objective: get the whole plumbing working (schemas, Durable Object, D1, KV, routes) before spending a cent, so other people can build against it immediately.
- Defines `IrisRequestSchema` (`concept`, `motif_ref`, optional `session_id`), `IrisParamsSchema`, `IrisResultSchema` in `packages/shared-types`.
- Pipeline runs end to end on fixture images standing in for Helios's motif and for Iris's own colored output. No model call, no cost.
- Routes already return real-shaped data, so nothing downstream (playground, Atlas) has to change shape later.

### Phase 2: real coloring

- Objective: turn the skeleton into a real two-call pipeline, same as Helios's text-then-image pattern.
- **Text call**: `@cf/openai/gpt-oss-120b` reads `concept`, returns a structured palette (`IrisParamsSchema`: primary/secondary/accent color from a 28-name fixed vocabulary, harmony, saturation, background treatment, mood). Has an explicit fallback rule for concepts that mention no color at all.
- **Image call**: `@cf/black-forest-labs/flux-2-klein-9b`, confirmed image-to-image capable. Takes Helios's motif as `input_image_0` via multipart form data (not the JSON body every other call in the repo uses), needs the input resized under 512x512 first, `steps` fixed at 4.
- Both calls go through AI Gateway, cost read from the real gateway log, one audit row per modality (`iris_runs`, `text`/`image`) sharing one `p_invoc_id`, ADR-0001's shape, unchanged.

### Failure handling

Text stage retries automatically (cheap, likely to fix itself). Image stage never auto-retries (expensive, one-shot), a human triggers `POST /resume` instead, capped by `max_resume_attempts` counted over the root invocation. A failed run still returns HTTP 200 with a settled status inside it.

### How it wires up

- **To Helios:** no direct call. Whoever calls the API sends the same concept text to both engines manually (no coordinator exists yet); Iris takes Helios's output image by reference (`motif_ref`) and reads only the color-relevant parts of the same concept text, ignoring shape, line and texture, which stays Helios's job.
- **To Atlas:** Iris's `IrisResultSchema` is the contract Atlas builds against from day one, using fixture data shaped exactly like it, so Atlas is never blocked waiting for Iris's real model call. The real join between the two lands late, as `shared-02`.
- **To the playground:** `apps/frontend` (currently on the `playground` branch) gets an engine switch added for Iris in iris-12, which is also what unblocks Atlas's own playground panel.

## Atlas sprint , the Repeat Engine (read as garment placement this sprint)

**Job:** takes Iris's colored pattern and places it across garment regions (back, neck, hem), producing the final piece shown on clothing. This is the thing that makes the two-engine work look like one product.

### Phase 1: skeleton against sample data

- Objective: same move as Iris, get the whole plumbing real before any money is spent.
- Defines Atlas's input/output types in `packages/shared-types`, importing `IrisResultSchema` rather than duplicating it, so a garment reference is literally "whatever Iris produces."
- Durable Object, D1, KV, R2 scaffolding stood up with an empty pipeline stage.
- Pipeline wired against sample colored-pattern images that validate against `IrisResultSchema`, so swapping in Iris's real output later is a data change, not a code change.

### Phase 2: real repetition/placement

- Objective: one real image call that places the pattern on a garment, using two input images (Iris's colored pattern and a real photo of the shirt the caller uploads as `garment_ref`) plus a descriptive prompt built from `garment_type`, regions, coverage and pattern scale. Amended after the tickets were first written: the original call was words-only, no garment image; a real anchor photo was added because it gives the model something concrete to render onto instead of inventing a garment from text.
- Same `flux-2-klein` model as Iris, called with Iris's colored image as `input_image_0` and the garment photo as `input_image_1`, `getImageToImageOutput` reused unchanged from Iris's shared-utils work.
- It is one call only, ever, no text/planner stage, because there's nothing left for a text model to interpret: repeat style already came from Helios's params, and garment/region choice is a small fixed set the caller picks from an enum, not an open-ended language problem.
- Before committing to Phase 2, a cheap one-call probe (`atlas-03`, ~$0.003) answers a question iris-06 can't: can this model actually place a pattern on the garment shown in a second reference image, or does it ignore it, blend the two, or return a flat tiled square. That's the finding that could invalidate the whole approach, so it's checked first.
- `atlas_runs` is one row per invocation, not two, a deliberate, documented departure from ADR-0001, because Atlas has exactly one billable call and no partial-success case to represent. It carries twelve columns, not eleven, once `garment_ref` is added; the D1 export chunk size is eight rows, not nine, as a direct consequence.

### Failure handling

Same reasoning as Iris/ADR-0009, but with only one stage: nothing auto-retries at all. `POST /resume` re-runs the single image call under a spend cap counted over the root invocation.

### How it wires up

- **To Iris:** `source_p_invoc_id` on every Atlas row points at the Iris invocation whose colored output it placed, one hop, same `root`/`resumed_from` idea Helios already uses for resumes, extended one link further up the chain (Helios to Iris to Atlas).
- **To Helios (indirectly):** Atlas never calls Helios or Iris directly; a person (or eventually the playground) passes the URL/reference forward by hand at each hop, since there's no coordinator engine (Athena) yet.
- **To the playground:** Atlas's panel (`atlas-10`) lands strictly after Iris's (`iris-12`), same owner, so the two frontend changes never overlap.

## The joint end-of-sprint stitching

Both sprints converge on three shared tickets, deliberately sequenced last:

- **`shared-02`**: the real Iris to Atlas wiring, once both engines' sample-data phases are stable.
- **`shared-03`**: consolidates the three separate D1 databases (`helios-d1`, `iris-d1`, `atlas-d1`) into one, once no ticket in either backlog still touches a schema, so a full-pipeline view becomes one join instead of three stitched reads.
- **`shared-04`**: per-engine ADR directories, done first (day one), so both squads can write ADRs in parallel without colliding on a shared number sequence.

The only real cross-sprint blockers are one-directional (Atlas waits on Iris, never the reverse): atlas-01 on iris-01's result schema, atlas-03 on iris-06's confirmed request shape, atlas-07 on iris-07's image-to-image helper, atlas-10 on iris-12's engine switch.
