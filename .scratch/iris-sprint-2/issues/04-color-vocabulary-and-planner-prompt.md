# iris-04: Color vocabulary and planner prompt

**What to build:** the final color vocabulary (names plus one hex value each), the glossary file that pairs each name with its meaning, the planner prompt that turns a free-text concept into an `IrisParams` object, and the deterministic function that turns those params into the sentence sent to the image model.

**Objective:** this is the only part of Iris that reasons about color as a design domain rather than as data. Helios has the same shape: `prompts/planner.prompt.ts` is the only component in Helios that reasons about textiles, and everything else just moves its output around. Getting the vocabulary and the prompt right here is what decides whether the same concept produces a consistent palette across runs, and it is the one part of the sprint that is a judgement call rather than an engineering one.

**Final result:** a fixed list of color names, each with a hex value and a one-line gloss; a prompt that reliably returns a valid `IrisParams` for a concept that names colors and a plausible one for a concept that names none; and a `buildColorPrompt` function that turns any valid `IrisParams` into one sentence with no design judgement of its own.

**Blocked by:** nothing for the vocabulary and the prompt text. `buildColorPrompt`'s exact wording benefits from iris-06's confirmed model behaviour, so write it, then revisit its clause order once iris-06 lands.

**Status:** ready-for-human.

**Owner:** M. Subhan. **Reviewer:** Maaz Bin Asif.

## Read this first

- `apps/agent-helios/src/prompts/planner.prompt.ts` (273 lines). This is the reference for everything in this ticket: how the glossaries are typed against the schema, how each enum value gets a gloss, how the system prompt is structured, and how the prompt carries a version id.
- `apps/agent-helios/src/prompts/image.prompt.ts` (178 lines). `buildImagePrompt` is a deterministic translator from eight params to one Flux sentence with no design judgement in it. `buildColorPrompt` is the same idea for color.
- `.scratch/iris-sprint-2/plan.md`, the "`ColorNameSchema`, the color vocabulary" section, which has the proposed 28 names and their hex values in a table. That table is the starting point, not the answer.
- ADR-0002, which is why color is Iris's job at all.

## Decisions

1. **The vocabulary is a closed enum, not free text.** Helios can leave `motif_type` and `style` as free strings because motif types are genuinely unbounded. Colors cannot be, because nothing downstream can map "emerald", "emerald green" and "dark jewel green" onto one hex value. This is settled and is not up for re-litigation in this ticket.
2. **One hex value per name, defined once.** In `prompts/color.glossary.ts`, in the same file as the gloss. Two sources of truth for what `emerald` means is how the planner and the image prompt end up disagreeing.
3. **Each enum value must have a gloss, enforced by the type system.** Type the glossary as a `Record<ColorName, ...>` so adding a name to `ColorNameSchema` without writing its hex and gloss is a **compile error**, not a runtime surprise. Helios's glossaries do exactly this and it is the reason no Helios enum value ever shipped unexplained.
4. **The no-color fallback rule goes in the prompt text, not left to the model.** Many concepts name no color at all: "art deco paisley with fine linework" has nothing to extract. The prompt must tell the model what to do in that case, in words, rather than hoping it improvises well. The rule: infer a palette from the described mood, era or style, prefer `harmony: "neutral"` and `saturation: "muted"`, and never return an empty or invalid result.
5. **The prompt reads only `concept`.** It never sees the motif image. `@cf/openai/gpt-oss-120b` is text-only and has no image input at all, which was confirmed against Cloudflare's docs. Do not write a prompt that refers to "the image" or "the pattern shown", because there is no image in that call.
6. **The prompt ignores everything Helios's planner already handles.** Shape, line weight, texture technique, contrast, repeat style and scale are Helios's, and the same concept text goes to both engines. Iris's prompt should say so explicitly, so the model does not try to describe the motif back to us.
7. **`buildColorPrompt` has no design judgement in it.** It is a translator: params in, one sentence out, deterministically. If it starts making choices (picking a color the params did not name, deciding a palette is unbalanced), those choices become invisible and unversioned. Any judgement belongs in the planner prompt, where it is reviewable.
8. **Prompts are versioned, not edited in place.** Export a version id (`iris-planner-v1`, `iris-color-v1`) and record it in the row's `model_metadata`, so a run's output stays attributable to the prompt that produced it. When the prompt changes meaningfully, the version changes.
9. **28 names is a size choice, and the reviewer may change it.** Enough for real variety without asking the model to choose between near-duplicates it cannot reliably distinguish. `rust` and `terracotta` are already close; a third similar rust-orange adds noise, not range. If a name is added, say which gap it fills.

## Agreed shapes, do not invent your own

```ts
// apps/agent-iris/src/prompts/color.glossary.ts

/**
 * One entry per ColorName. Typed as a full Record, so adding a name to
 * ColorNameSchema without adding it here is a compile error.
 */
export const COLOR_GLOSSARY: Record<ColorName, { hex: string; gloss: string }> = {
  ivory: { hex: "#F5F1E6", gloss: "a warm off-white, barely tinted, reads as unbleached cloth" },
  // ... one line per name
};

export const HARMONY_GLOSSARY: Record<IrisParams["harmony"], string> = { ... };
export const SATURATION_GLOSSARY: Record<IrisParams["saturation"], string> = { ... };
export const BACKGROUND_GLOSSARY: Record<IrisParams["background_treatment"], string> = { ... };
```

```ts
// apps/agent-iris/src/prompts/planner.prompt.ts
export const IRIS_PLANNER_PROMPT_VERSION = "iris-planner-v1";
export function buildPlannerSystemPrompt(): string;
export function buildPlannerUserPrompt(concept: string): string;

// apps/agent-iris/src/prompts/color.prompt.ts
export const IRIS_COLOR_PROMPT_VERSION = "iris-color-v1";
/** Deterministic. Same params in, same sentence out, always. */
export function buildColorPrompt(params: IrisParams): string;
```

## Work

### The vocabulary

- [ ] Go through the 28 proposed names and hex values in the plan and decide, for each one, whether it stays, changes value, or goes. Write the outcome into this ticket as a table so the decision is recorded, not just applied. (**M. Subhan**)
- [ ] Write `prompts/color.glossary.ts` with `COLOR_GLOSSARY` typed as a full `Record<ColorName, ...>` per decision 3. (**M. Subhan**)
- [ ] Each gloss is one line and describes the color as a person working with cloth would, not as a hex code restated in words. `"a warm off-white, barely tinted, reads as unbleached cloth"` is useful to a model; `"a very light yellowish white"` is not. (**M. Subhan**)
- [ ] Write the three smaller glossaries for `harmony`, `saturation` and `background_treatment`, each typed against the matching schema field. `background_treatment` matters more than it looks: without a decision there, the image call has to guess what happens to the space around the motif, and that guess shows up as visibly inconsistent output between runs. (**M. Subhan**)
- [ ] If a name changes or is added, update `ColorNameSchema` in `packages/shared-types/src/v1/iris.ts` in the same change. This is the only edit this ticket makes outside `apps/agent-iris`. Keep it to that one enum. (**M. Subhan**)

### The planner prompt

- [ ] Write `buildPlannerSystemPrompt`, embedding the glossaries so the model sees what each enum value means rather than just its name. Follow how Helios's system prompt lays this out. (**M. Subhan**)
- [ ] Write the no-color fallback rule into the system prompt as explicit instructions, per decision 4. Include at least one worked example inside the prompt: a concept with no color and the palette that should come back for it. (**M. Subhan**)
- [ ] Write into the prompt that the model must ignore shape, line weight, texture, contrast, repeat and scale, because another engine handles those (decision 6). (**M. Subhan**)
- [ ] Do **not** refer to an image, a motif, or "the pattern shown" anywhere in this prompt. The model receives text only (decision 5). (**M. Subhan**)
- [ ] Export `IRIS_PLANNER_PROMPT_VERSION`. (**M. Subhan**)

### `buildColorPrompt`

- [ ] Write `prompts/color.prompt.ts` with `buildColorPrompt(params: IrisParams): string`. Deterministic, no randomness, no default-filling beyond what the optional fields require. (**M. Subhan**)
- [ ] Resolve each color name to its hex from `COLOR_GLOSSARY` and put **both** the name and the hex in the sentence. A name alone is ambiguous to the model; a hex alone gives it nothing to reason with. (**M. Subhan**)
- [ ] Handle the optional fields: a palette with only `primary_color` must still produce a complete, sensible sentence, not one with a dangling "and". (**M. Subhan**)
- [ ] Clause order matters, because these models weight early clauses more heavily. Put the palette first and the mood last. Helios's `buildImagePrompt` has a comment saying exactly this; reproduce the reasoning. (**M. Subhan**)
- [ ] Export `IRIS_COLOR_PROMPT_VERSION`. (**M. Subhan**)
- [ ] Write `prompts/index.ts` as a barrel, matching Helios's. (**M. Subhan**)

### Testing, without a model

- [ ] Write a table-driven test asserting `buildColorPrompt` is deterministic: the same params produce the same string, twice. (**M. Subhan**)
- [ ] Assert every `ColorName` resolves to a hex, by iterating `ColorNameSchema.options` against `COLOR_GLOSSARY`. This catches a name added to the enum but not the glossary even if the type system somehow lets it through. (**M. Subhan**)
- [ ] Write a scratch harness at `tests/run-concept-iris.ts` that prints what `buildColorPrompt` produces for hand-typed params, so prompt changes can be eyeballed without a model call. `tests/run-concept.ts` is the existing example. It is a harness, not a test. (**M. Subhan**)

### Review gates

- [ ] **Sign off the vocabulary as a product decision, not an engineering one.** Are these the right 28 names for the garments we intend to show? Is anything obviously missing, and is anything a near-duplicate the model will not distinguish? (**Maaz Bin Asif**)
- [ ] Read the no-color fallback rule and try to think of a concept it does not cover. If you find one, it goes in the prompt as a second example. (**Maaz Bin Asif**)
- [ ] Confirm `buildColorPrompt` contains no `if` that makes a design choice. A branch handling an absent optional field is fine; a branch that picks a color is not. (**Maaz Bin Asif**)
- [ ] Confirm the only file touched outside `apps/agent-iris` is the `ColorNameSchema` enum. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero for this ticket.** The prompt is verified against a real model in iris-08, which owns that spend. Do not spend it here.

1. `npx tsx tests/run-concept-iris.ts` (or however the existing harness is run) prints prompts for several hand-typed param sets. Read them out loud. If a sentence is confusing to you, it is confusing to the model.
2. Delete one entry from `COLOR_GLOSSARY` and confirm `npx tsc --noEmit` **fails**. If it passes, the `Record<ColorName, ...>` typing is not doing its job and decision 3 is not actually enforced. Put it back.
3. Add a junk name to `ColorNameSchema` and confirm typechecking fails for the same reason. Put it back.
4. `npm test` passes, including the every-name-has-a-hex assertion.

## Two things that will waste your afternoon

**Writing the glossary as `Partial<Record<ColorName, ...>>` or as a plain object literal defeats the entire point.** It compiles, it looks correct, and then a color the planner is allowed to return has no hex behind it, and iris-09 produces an image with a missing color and no error anywhere. Verification step 2 exists specifically to prove this is not the case, so actually run it.

**A prompt that works on the tenth reading is not a prompt that works.** If you find yourself explaining to a reviewer what a sentence in the prompt is trying to say, rewrite the sentence. The model gets one reading, no follow-up questions, and no context beyond what is in the text.
