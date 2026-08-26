# atlas-01: Shared contract and schemas

**What to build:** Atlas's Zod schemas in `packages/shared-types/src/v1/atlas.ts`: what a caller sends Atlas, what placement it performed, and what it hands back. No Atlas app code, no model calls. Just the shapes.

**Objective:** every other Atlas ticket needs these names to exist before it can compile, and one of them, `AtlasRequestSchema`, has to state in code that Atlas's input is Iris's output rather than a copy of it. Writing that down once here is what stops the two engines drifting apart while both squads work in parallel. It is also what lets atlas-06 build sample data that is guaranteed to match what Iris will really send.

**Final result:** anyone can `import { AtlasRequestSchema, AtlasPlacementSchema, AtlasResultSchema } from "@aureline/shared-types"` and get a compile-time type and a runtime validator from one definition. The sample colored pattern atlas-06 builds validates against `IrisResultSchema` because the contract makes it impossible for it not to.

**Blocked by:** iris-01. `IrisResultSchema` has to exist before Atlas can import it. iris-01 has no blockers of its own, so it lands on day one and this follows immediately.

**Status:** blocked, waiting on iris-01.

**Owner:** Maaz Ahmad. **Reviewer:** Saad Naik.

**Duration:** 1 day. **Scheduled:** Fri Aug 21 to Fri Aug 21.

## Read this first

- `packages/shared-types/src/v1/iris.ts` from iris-01, in full. `IrisResultSchema` is Atlas's input, so this is not background reading, it is half the specification.
- `packages/shared-types/src/v1/messages.ts` (83 lines), the original contract. Every convention this file follows is already visible there.
- `.scratch/atlas-sprint-2/plan.md`, "Cross-engine contract" and "Database shape". The reasoning behind the fields is written there and is not repeated here.
- `.scratch/shared-sprint-2/issues/02-iris-atlas-wiring.md`, decision 1. That ticket is the one that finds out whether this one was done right.

## Decisions

1. **New file, `packages/shared-types/src/v1/atlas.ts`, plus one `export *` line in the barrel.** Same rule iris-01 followed. Two squads editing one contract file is the most likely merge conflict in this sprint, and separate files make it impossible. Do not touch `messages.ts` and do not touch `iris.ts`.
2. **Atlas's input is `IrisResultSchema`, imported from `./iris`, never restated.** `AtlasRequestSchema` carries a `pattern_ref` and a `source_p_invoc_id` taken from an `IrisResult`, and the file imports the Iris type to say so in code rather than in a comment. A hand-maintained duplicate compiles on both sides and fails at runtime on the first real call.
3. **`pattern_ref` is a reference, never bytes.** A URL or an R2 key, as a string. Same reasoning as `motif_ref` in iris-01, decision 3.
4. **`source_p_invoc_id` is required, not optional.** Atlas cannot run without a pattern to place, so there is no case where the upstream run is unknown. Making it optional would invite a row with no traceable origin, which is exactly what shared-03 later depends on not existing.
5. **No free-text field on the request.** Not `concept`, not `notes`, not `style`. Atlas has no text model to interpret free text, so anything free-form would go straight into an image prompt, which is an unbounded input to a billed call and cannot be validated. Everything the caller can ask for is a fixed enum. If that turns out to be too narrow, widening an enum is a small change; removing a free-text field after the playground sends it is not.
6. **The request also carries `garment_ref`, a second reference image: a real photo of the shirt the pattern gets printed on.** This supersedes the plan's original call of "no garment image, the garment comes from the prompt alone", decided later in the same session once it became clear a real anchor image gives the model something concrete to render onto rather than inventing a garment from words. Unlike `pattern_ref`, there is no engine that produces this image and no upload endpoint in this sprint: `garment_ref` is a plain URL to an already-hosted photo, which Atlas fetches itself. It is not an R2 key, because nothing writes the caller's photo into any of our buckets. If an upload endpoint is added in a later sprint, `garment_ref` stays a reference either way and only the set of valid reference shapes widens. `garment_ref` is validated with `.url()`, which `pattern_ref` deliberately is not: `pattern_ref` might be an R2 key or a URL depending on how Iris hands it off, but `garment_ref` in this sprint is always a URL, so the schema can and should say so. `garment_type` and the region/coverage/scale fields are unchanged and still required: the reference image anchors the actual garment shape and texture, atlas-05's prompt text still states what it is and how the pattern goes on it. Both together, not one replacing the other.
7. **The placement shape is called `AtlasPlacementSchema`, not `AtlasParamsSchema`.** In Helios and Iris, "params" means what the planner model decided. Atlas has no planner, so its equivalent is what the caller asked for plus what the prompt builder resolved. A different job gets a different name, so nobody goes looking for the planner that produced it.
8. **`AtlasResultSchema` is a Zod schema, not an interface**, matching `IrisResultSchema` and deliberately unlike `HeliosResult`. Athena will eventually read this across a worker boundary and will need to validate it at runtime, which an interface cannot do.
9. **`session_id` means what it means everywhere else.** It picks the Durable Object instance (ADR-0005), not the invocation. Same bounds as Helios and Iris use.
10. **The region and garment enums live here, not in the Atlas app.** atlas-05 writes the prompt text and the gloss for each value, and atlas-10's playground renders its controls from these same enums. One list, three consumers.

## Agreed shapes, do not invent your own

```ts
// packages/shared-types/src/v1/atlas.ts
import { IrisResultSchema } from "./iris";

/**
 * The garment areas a pattern can be placed on. A fixed list rather than free
 * text because there is no text model in Atlas to interpret "around the collar
 * bit". atlas-05 owns the description behind each name; the list itself is
 * settled here so the playground and the prompt builder read the same one.
 */
export const GarmentRegionSchema = z.enum(["back", "front", "neck", "hem", "sleeve"]);

export type GarmentRegion = z.infer<typeof GarmentRegionSchema>;

/** The garment the pattern is placed on. The caller also sends a real photo
 *  of it as garment_ref, but the model still needs the type named in words
 *  so the prompt can describe cut and fit precisely. */
export const GarmentTypeSchema = z.enum(["tshirt", "kurta", "scarf", "hoodie", "dress"]);

export type GarmentType = z.infer<typeof GarmentTypeSchema>;

/**
 * What this run placed, and how. Recorded on the audit row as garment_regions.
 * Named "placement" rather than "params" because no planner model produced it:
 * it is the caller's request plus whatever atlas-05's builder resolved.
 */
export const AtlasPlacementSchema = z.object({
  garment_type: GarmentTypeSchema,
  regions: z.array(GarmentRegionSchema).min(1).max(5),
  coverage: z.enum(["allover", "panel", "trim"]),
  pattern_scale: z.enum(["small", "medium", "large"]),
  prompt_version: z.string().trim().min(1),
});

export type AtlasPlacement = z.infer<typeof AtlasPlacementSchema>;

/** Shared by the wire contract and the atlas_runs audit table. */
export const AtlasStatusSchema = z.enum(["running", "completed", "failed"]);

export type AtlasStatus = z.infer<typeof AtlasStatusSchema>;

/**
 * `pattern_ref` is Iris's image_url or R2 key, a reference and never bytes.
 * `garment_ref` is a URL to the caller-supplied photo of the actual garment
 * the pattern gets printed on. There is no upload endpoint in this sprint,
 * so unlike pattern_ref this is never an R2 key, only a URL Atlas fetches
 * itself. `source_p_invoc_id`
 * is the Iris run that produced the pattern, carried onto every atlas_runs
 * row so a full-pipeline view is possible before the databases are merged.
 * See docs/sprint-2-3-conventions.md.
 *
 * There is deliberately no free-text field: Atlas has no text model, so
 * anything free-form would reach a billed image call unvalidated.
 */
export const AtlasRequestSchema = z.object({
  pattern_ref: z.string().trim().min(1).max(512),
  garment_ref: z.string().trim().url().max(512),
  source_p_invoc_id: z.string().trim().min(1).max(128),
  garment_type: GarmentTypeSchema,
  regions: z.array(GarmentRegionSchema).min(1).max(5),
  coverage: z.enum(["allover", "panel", "trim"]).default("allover"),
  pattern_scale: z.enum(["small", "medium", "large"]).default("medium"),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type AtlasRequest = z.infer<typeof AtlasRequestSchema>;

/** Same shape and meaning as HeliosResumeRequestSchema and IrisResumeRequestSchema. */
export const AtlasResumeRequestSchema = z.object({
  p_invoc_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type AtlasResumeRequest = z.infer<typeof AtlasResumeRequestSchema>;

/**
 * What Atlas returns. A schema rather than an interface, matching IrisResult,
 * because Athena will read this across a worker boundary.
 */
export const AtlasResultSchema = z.object({
  p_invoc_id: z.string(),
  source_p_invoc_id: z.string(),
  status: AtlasStatusSchema,
  placement: AtlasPlacementSchema.nullable(),
  image_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});

export type AtlasResult = z.infer<typeof AtlasResultSchema>;

/**
 * Atlas's input is Iris's output. This helper exists so that the connection is
 * enforced by the compiler rather than by everyone remembering it. shared-02
 * swaps sample data for real data and this is the function it goes through.
 */
export function atlasInputFromIrisResult(
  result: z.infer<typeof IrisResultSchema>
): Pick<AtlasRequest, "pattern_ref" | "source_p_invoc_id">;
```

## Work

- [x] Create `packages/shared-types/src/v1/atlas.ts` with exactly the shapes above. Copy them rather than retyping from memory. (**Maaz Ahmad**)
- [x] Import `IrisResultSchema` from `./iris` and write `atlasInputFromIrisResult` against it (decision 2). If it throws when `image_url` or `p_invoc_id` is null, that is correct: a failed Iris run has nothing for Atlas to place. Say so in the doc comment. (**Maaz Ahmad**)
- [x] Add `export * from "./v1/atlas";` to `packages/shared-types/src/index.ts`. Check the barrel's existing form first and match it. This one line is the only shared edit this ticket makes. (**Maaz Ahmad**)
- [x] Every schema carries a doc comment in the same voice `messages.ts` uses. A reader should not need the plan open to understand a field. (**Maaz Ahmad**)
- [x] Do **not** define a `ColoredPattern` type, or any other local restatement of `IrisResult` (decision 2). (**Maaz Ahmad**)
- [x] Do **not** touch `messages.ts` or `iris.ts`. `git diff --stat` should show one new file and one barrel line. (**Maaz Ahmad**)
- [x] `npx tsc --noEmit` passes from inside `packages/shared-types`. (**Maaz Ahmad**)

### Review gates

- [ ] **Read this as the Iris manager.** Is anything Atlas needs missing from `IrisResultSchema`, and is anything in it that Atlas has to ignore? Now is when changing it is cheap; after atlas-06 has fixtures it means changing both engines. (**Saad Naik**)
- [ ] Confirm `atlasInputFromIrisResult` is the only path from an Iris result into an Atlas request, and that nothing reconstructs it field by field. (**Saad Naik**)
- [ ] Confirm the five regions and five garment types are the ones we actually want to support, because atlas-05 writes prompt text for each and atlas-10 renders a control for each. Adding one later means touching three tickets' output. (**Saad Naik**)
- [ ] Confirm there is no free-text field anywhere on the request (decision 5). (**Saad Naik**)
- [ ] Confirm `garment_ref` is required, validated as a URL (not a loose string like `pattern_ref`), and does not replace `garment_type` (decision 6). (**Saad Naik**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** Nothing here calls a model.

1. `npx tsc --noEmit` from inside `packages/shared-types` is clean.
2. In a scratch file, parse a valid request and confirm the two defaults apply:
   ```ts
   AtlasRequestSchema.parse({ pattern_ref: "colored/x.jpg", garment_ref: "https://example.com/shirt.jpg", source_p_invoc_id: "iris-1", garment_type: "tshirt", regions: ["back"] });
   // coverage: "allover", pattern_scale: "medium"
   ```
3. Confirm an empty `regions` array is rejected. A run that places a pattern nowhere would still bill.
4. Feed a real-shaped `IrisResult` through `atlasInputFromIrisResult` and confirm the result parses as the first two fields of an `AtlasRequest`.

## Two things that will waste your afternoon

**A `.default()` on a Zod field changes the inferred input type and the inferred output type differently.** `z.infer` gives you the parsed type, where `coverage` is required. The thing the playground sends is the input type, where it is optional. If atlas-10 types its form state as `AtlasRequest` and finds it must supply `coverage`, that is this, not a bug. Use `z.input<typeof AtlasRequestSchema>` on the sending side.

**Copying `IrisResult`'s fields into a local interface will look like it works for weeks.** Both engines compile, both test suites pass, and the first real chain in shared-02 fails on a field name. Decision 2 is not a style preference, and the import is the thing to check before anything else.
