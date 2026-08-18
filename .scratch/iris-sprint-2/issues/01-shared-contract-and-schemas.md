# iris-01: Shared contract and schemas

**What to build:** four new Zod schemas in `packages/shared-types/src/v1/`, describing what a caller sends Iris, what Iris's planner returns, and what Iris hands back. No Iris app code, no model calls. Just the shapes.

**Objective:** every other Iris ticket needs these names to exist before it can compile. More importantly, `IrisResultSchema` is Atlas's input type, so until it is written down Atlas cannot build its sample data and the Atlas squad is blocked on us. This ticket exists to unblock both engines on day one.

**Final result:** anyone can `import { IrisRequestSchema, IrisParamsSchema, IrisResultSchema } from "@aureline/shared-types"` and get a compile-time type, a runtime validator, and a JSON schema for the model, all from one definition. The Atlas squad can write fixtures against `IrisResult` without waiting for Iris to work.

**Blocked by:** nothing. Start immediately, in parallel with iris-02 and iris-04.

**Status:** ready-for-human.

**Owner:** Maaz Bin Asif. **Reviewer:** Saad Naik.

**Duration:** 1 day. **Scheduled:** Thu Aug 20 to Thu Aug 20.

## Read this first

- `packages/shared-types/src/v1/messages.ts` is the whole existing contract, 83 lines. Read it top to bottom before writing anything. Every convention this ticket follows is already visible there.
- `.scratch/iris-sprint-2/plan.md`, sections "Architecture", "The planner's output: `IrisParamsSchema`", and "Cross-engine contract". The field list and the reasoning behind each field are already written there and are not repeated here.
- ADR-0002 for why Helios has no color field, which is the reason this schema exists at all.

## Decisions

1. **New file, not an edit to `messages.ts`.** Put Iris's shapes in `packages/shared-types/src/v1/iris.ts` and add one `export *` line to `src/index.ts`. `messages.ts` is Helios's file and stays that way. Two squads editing one contract file is the single most likely merge conflict in this sprint, and separate files make it impossible.
2. **`v1/`, same as Helios.** Versioning by directory, so a breaking change later lands as `v2/iris.ts` beside this rather than as an edit that silently breaks Atlas.
3. **`motif_ref` is a reference, never bytes.** An R2 key or a URL, as a string. Raw image bytes in a JSON request body means base64 in and out of every layer, a much larger request, and no way to look at the input afterwards. Helios already returns a servable URL rather than bytes for the same reason.
4. **`ColorNameSchema` is declared here but its value list is iris-04's call.** Write it with the 28 names from the plan as a starting point and a comment saying iris-04 owns the final list. Do not block this ticket on the color sign-off, and do not let iris-04 have to touch `IrisParamsSchema` when it lands.
5. **`IrisResultSchema` is a Zod schema, not a bare TypeScript interface.** Helios's `HeliosResult` is an `interface` (`messages.ts:76`). Iris's is a schema instead, because Atlas will receive this over the wire from another worker and needs to validate it at runtime, which an interface cannot do. This is a deliberate difference from Helios, so note it in a comment.
6. **`session_id` means the same thing it means for Helios.** It picks the Durable Object instance (ADR-0005), not the invocation. Same bounds as Helios uses: `min(1).max(128)`, optional. Copy the doc comment's intent, do not invent new semantics.

## Agreed shapes, do not invent your own

```ts
// packages/shared-types/src/v1/iris.ts

/**
 * The controlled color vocabulary. iris-04 owns the final list and the hex
 * value behind each name; these 28 are the starting proposal from
 * .scratch/iris-sprint-2/plan.md. A fixed enum rather than free text because
 * nothing downstream can map "emerald", "emerald green" and "dark jewel
 * green" onto one hex value.
 */
export const ColorNameSchema = z.enum([
  "ivory", "cream", "sand", "taupe", "stone", "charcoal", "black", "white",
  "crimson", "rust", "terracotta", "coral", "blush", "rose",
  "amber", "gold", "mustard", "ochre",
  "olive", "sage", "emerald", "forest_green", "mint",
  "teal", "turquoise", "cobalt", "navy", "indigo",
  "plum", "burgundy",
]);

export type ColorName = z.infer<typeof ColorNameSchema>;

/** What the planner call returns. Saved on the audit row as planner_params. */
export const IrisParamsSchema = z.object({
  primary_color: ColorNameSchema,
  secondary_color: ColorNameSchema.optional(),
  accent_color: ColorNameSchema.optional(),
  harmony: z.enum(["monochrome", "analogous", "complementary", "triadic", "neutral"]),
  saturation: z.enum(["muted", "balanced", "vibrant"]),
  background_treatment: z.enum(["solid", "gradient", "textured", "transparent"]),
  mood: z.string().trim().min(1),
});

export type IrisParams = z.infer<typeof IrisParamsSchema>;

/** Shared by the wire contract and the iris_runs audit table, same as Helios. */
export const IrisStatusSchema = z.enum(["running", "completed", "failed"]);

export type IrisStatus = z.infer<typeof IrisStatusSchema>;

/**
 * `concept` is the same free text sent to Helios, not a color-only fragment.
 * There is no coordinator engine yet, so the caller sends it to both.
 *
 * `source_p_invoc_id` is the Helios run that produced `motif_ref`. It is
 * carried forward onto every iris_runs row so a full-pipeline view is possible
 * before the databases are merged. See docs/sprint-2-3-conventions.md.
 */
export const IrisRequestSchema = z.object({
  concept: z.string().trim().min(1).max(1000),
  motif_ref: z.string().trim().min(1).max(512),
  source_p_invoc_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type IrisRequest = z.infer<typeof IrisRequestSchema>;

/** Same shape and meaning as HeliosResumeRequestSchema. */
export const IrisResumeRequestSchema = z.object({
  p_invoc_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type IrisResumeRequest = z.infer<typeof IrisResumeRequestSchema>;

/**
 * What Iris returns, and therefore what Atlas consumes.
 *
 * A schema rather than an interface (unlike HeliosResult) because Atlas
 * receives this across a worker boundary and has to validate it at runtime.
 *
 * `width` and `height` are here so Atlas knows what it is placing without
 * having to fetch and decode the image first.
 */
export const IrisResultSchema = z.object({
  p_invoc_id: z.string(),
  source_p_invoc_id: z.string(),
  status: IrisStatusSchema,
  params: IrisParamsSchema.nullable(),
  image_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});

export type IrisResult = z.infer<typeof IrisResultSchema>;
```

## Work

- [ ] Create `packages/shared-types/src/v1/iris.ts` with exactly the shapes above. Copy them, do not retype them from memory. (**Maaz Bin Asif**)
- [ ] Add `export * from "./v1/iris";` to `packages/shared-types/src/index.ts`. Check the existing barrel first: it is a single `export *` today, so match whatever form is already there. (**Maaz Bin Asif**)
- [ ] Every schema above carries a doc comment explaining what the field is for, in the same voice `messages.ts` uses. A reader should not have to open the plan to understand a field. This is not optional polish: `messages.ts`'s comments are the reason nobody had to ask what `session_id` meant in sprint 1. (**Maaz Bin Asif**)
- [ ] Do **not** add a `color` field, hint, or anything similar to `HeliosParamsSchema`. ADR-0002 rejected even a temporary color hint. If it feels like Helios should pass something, that is a sign the concept text should carry it instead. (**Maaz Bin Asif**)
- [ ] Do **not** touch `messages.ts` at all. `git diff --stat` on this ticket should show two files: one new, one barrel line. (**Maaz Bin Asif**)
- [ ] `npx tsc --noEmit` passes from inside `packages/shared-types`. (**Maaz Bin Asif**)

### Review gates

- [ ] **`IrisResultSchema`'s field names are a cross-squad commitment.** Read them as the Atlas manager, not as a reviewer of Iris: is there anything Atlas will need that is missing, and is there anything here Atlas will have to ignore? Say so now, because changing this after Atlas has fixtures built means changing both engines. (**Maaz Ahmad**)
- [ ] Confirm `width` and `height` are enough for Atlas to place the pattern, or name what else it needs. (**Maaz Ahmad**)
- [ ] Nobody approves their own work. Maaz Bin Asif does not tick either gate above. (**both**)

## Verification without burning budget

**Budget: zero.** Nothing here calls a model.

1. From `packages/shared-types`, run `npx tsc --noEmit`. It must be clean.
2. In a scratch file, check the three jobs one schema does. All three must work off the same definition:
   ```ts
   IrisRequestSchema.parse({ concept: "art deco paisley", motif_ref: "patterns/x.jpg", source_p_invoc_id: "abc" });
   // throws on a missing motif_ref
   z.toJSONSchema(IrisParamsSchema);
   // produces the JSON schema the planner model will be handed in iris-08
   ```
3. Confirm `z.toJSONSchema(IrisParamsSchema)` does not throw. If it does, a field is using something the JSON schema converter cannot express, and iris-08 will fail at runtime instead of here.

## Two things that will waste your afternoon

**`z.enum` with 30 values and `z.toJSONSchema` is fine, but `.optional()` on an enum is where it gets fussy.** Run step 3 above before you tick anything. `getTextualModelOutput` hands the converted schema to the model, so a schema that converts badly produces a model that returns badly, and the failure surfaces four tickets later in iris-08 looking like a model problem.

**The package is symlinked by npm workspaces, so there is no build step, but there is a stale-type step.** If another workspace does not see your new export, it is almost always that the workspace was never installed. Run `npm install --package-lock-only` from the repo root, never a bare `npm i`, and never hand-resolve a lockfile conflict (see `docs/sprint-2-3-conventions.md`).
