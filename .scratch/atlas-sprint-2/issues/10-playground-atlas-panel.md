# atlas-10: Playground support for Atlas

**What to build:** teach the playground at `apps/frontend` to drive Atlas as a third engine. A garment type control, region checkboxes, a pattern reference field, a garment reference field (a photo of the actual shirt, added to the request after this ticket was first written), and a run history that understands a one-row engine. Not a second app.

**Objective:** Atlas's output is a picture of a garment. There is no way to judge it from curl, and it is the thing the whole two-engine sprint exists to show. iris-12 already did most of the structural work by turning the page's single engine into a choice; this ticket adds the third option and the controls Atlas needs that neither other engine has. It is also where the demo actually lives, since running the full Helios to Iris to Atlas chain by hand is what shared-02 verifies and this page is the hand.

**Final result:** open the playground, switch it to Atlas, paste a pattern reference from an Iris run, paste or enter a reference to a real garment photo, pick a garment type and its regions, click generate, and see the patterned garment with its cost and its audit row. Resuming works from the same page.

**Blocked by:** iris-12, which lands the engine switch and the per-engine base URL this ticket extends, and atlas-06 for the real response shape. Same owner as iris-12, so these are strictly sequential rather than parallel, which is deliberate: two people editing this app at once is the one frontend merge conflict worth avoiding.

**Status:** blocked, waiting on iris-12.

**Owner:** Maaz Ahmad. **Reviewer:** Maaz Bin Asif.

## Read this first

- `.scratch/iris-sprint-2/issues/12-playground-image-input.md` in full, including its decisions. Everything it settled applies here: one app not two, the engine choice is explicit and never inferred from the URL, validation imports the worker's schema, and the spend confirmation carries the engine's own number. Its decision 10 is a note-to-self that becomes this ticket.
- `apps/frontend/src/state/settings.ts`, after iris-12 extended it. The `Engine` type is what gains a third member.
- `apps/frontend/src/api/client.ts` (128 lines). The three rules in its header comment still hold: no credentials, no retry or polling or timeout, `Content-Type` as the only header.
- `apps/frontend/src/domain/validate.ts`, and `validateIrisGenerate` from iris-12, which `validateAtlasGenerate` mirrors.
- `packages/shared-types/src/v1/atlas.ts` from atlas-01, for the enums the controls render from.

## Decisions

1. **A third value on the existing `Engine` type, not a parallel code path.** `'helios' | 'iris' | 'atlas'`. If adding the third engine requires anything structural, iris-12's engine switch was built too narrowly and fixing that is part of this ticket rather than working around it.
2. **The garment and region controls render from the enums in `shared-types`, not from a hand-written list.** `GarmentTypeSchema.options` and `GarmentRegionSchema.options`. A hand-written list drifts the moment atlas-01's enum changes, and it drifts silently because both sides still compile.
3. **Regions are checkboxes, not a text field.** They are a fixed multi-select with a minimum of one, which is exactly what `AtlasRequestSchema` says.
4. **Invalid garment and region combinations are disabled in the UI, not just rejected on submit.** atlas-05's `validRegionsFor` knows a scarf has no sleeve. If that logic is not importable from the worker, restate the pairing table in one place in the frontend and leave a comment naming atlas-05 as its source, rather than scattering the knowledge across components.
5. **Atlas has one audit row and no `text` modality.** iris-12 left a comment where the two-rows-per-invocation assumption lives; this is the ticket that has to satisfy it. A history table that assumes two rows will show Atlas runs as half-missing, and it will look like a backend bug.
6. **Atlas gets its own cost constant**, from atlas-03's measured figure. One image call, so one number, unlike Iris's text-plus-image total. A confirmation dialog showing another engine's price is worse than none.
7. **Validate with `AtlasRequestSchema` before sending**, imported from `@aureline/shared-types`, the same way `validateIrisGenerate` imports Iris's. Do not hand-copy the rules.
8. **Add the chain convenience action.** When an Iris run is selected in the history, offer to copy its `image_url` and `p_invoc_id` straight into Atlas's fields, exactly as iris-12 did for the Helios-to-Iris hop. There is no coordinator engine, so a person does this hand-off on every single run, twice per chain.
9. **`GET /runs` is free and must stay free.** It is the route the page calls on load and after every run. Nothing on that path may reach a model.
10. **Do not build a one-click full-chain button.** It is tempting and it is shared-02's territory, and a button that fires three billed calls from one click is exactly the thing the spend confirmation exists to prevent. Copying between panels is the supported flow.

## Agreed shapes, do not invent your own

```ts
// apps/frontend/src/state/settings.ts
export type Engine = 'helios' | 'iris' | 'atlas';
// loadBaseUrl / saveBaseUrl are already per-engine from iris-12. No change
// beyond the wider type.
```

```ts
// apps/frontend/src/api/client.ts
export async function generate(
  baseUrl: string,
  request: HeliosRequest | IrisRequest | AtlasRequest
): Promise<CallOutcome>;

/** One image call, so one number. From atlas-03's measured cost. */
export const ATLAS_GENERATE_COST_USD = /* from atlas-03 */;
export const ATLAS_RESUME_COST_USD = /* the same number: resume is the same call */;
```

```ts
// apps/frontend/src/domain/validate.ts
export function validateAtlasGenerate(
  patternRef: string,
  garmentRef: string,
  sourcePInvocId: string,
  garmentType: string,
  regions: string[],
  coverage: string,
  patternScale: string,
  sessionId: string
): Validated;
```

## Work

### The engine

- [ ] Add `'atlas'` to the `Engine` type and to the engine control. Confirm the per-engine base URL from iris-12 works for three engines without change; if it does not, fix it here rather than special-casing Atlas (decision 1). (**Maaz Ahmad**)
- [ ] Add the playground's deployed origin plus the local dev origins to Atlas's `ALLOWED_ORIGINS` in `apps/agent-atlas/wrangler.jsonc`. There is no auth on `/generate` and it spends real money, so this list is the only thing stopping any webpage billing our account. Never `*`. Regenerate types after the edit, because `wrangler types` types vars as literals. (**Maaz Ahmad**)

### The Atlas input controls

- [ ] Add the `pattern_ref` and `source_p_invoc_id` fields, shown only when the engine is Atlas. Label them so the workflow is obvious without documentation: the pattern reference is the `image_url` from an Iris run, and the run id is the `p_invoc_id` that produced it. (**Maaz Ahmad**)
- [ ] Add the `garment_ref` field, also shown only when the engine is Atlas. Unlike `pattern_ref`, this one has no upstream engine to copy from and there is no upload endpoint in this sprint: it is a plain text field for a URL to an already-hosted garment photo, which the person testing pastes in by hand. Label it clearly as "a link to a garment photo, not a file to upload" so nobody clicks it expecting a file picker. Atlas fetches the URL itself; the playground never touches the image bytes. (**Maaz Ahmad**)
- [ ] Add a garment type control rendered from `GarmentTypeSchema.options` (decision 2). (**Maaz Ahmad**)
- [ ] Add region checkboxes rendered from `GarmentRegionSchema.options`, requiring at least one (decisions 2 and 3). (**Maaz Ahmad**)
- [ ] Add coverage and pattern scale controls. Both have defaults in the schema, so the page should show the default selected rather than leaving them empty. (**Maaz Ahmad**)
- [ ] Disable regions that the selected garment does not have (decision 4). Changing the garment must clear any now-invalid region rather than silently submitting it. (**Maaz Ahmad**)
- [ ] Write `validateAtlasGenerate` in `domain/validate.ts`, importing `AtlasRequestSchema` (decision 7), validating `garment_ref` the same way `pattern_ref` is validated: required, non-empty. Omit `session_id` rather than sending it empty, matching what the other two validators do. (**Maaz Ahmad**)
- [ ] Add the copy-from-Iris action (decision 8). (**Maaz Ahmad**)

### Output and history

- [ ] Show the garment image from `image_url`, reusing the existing `ImageOutput` component. (**Maaz Ahmad**)
- [ ] Show `width` and `height` from the result, the same way iris-12 does. Seeing them is how anyone notices atlas-07's resize misbehaving. (**Maaz Ahmad**)
- [ ] Make the run history handle a one-row engine (decision 5). Find the comment iris-12 left at the two-rows assumption and resolve it rather than adding a second branch somewhere else. (**Maaz Ahmad**)
- [ ] Show `source_p_invoc_id`, `pattern_ref`, `garment_ref` and the garment and regions from `garment_regions` in the history when the engine is Atlas. Those five are what make an Atlas row traceable, and hiding them behind a shared lowest-common-denominator table defeats the point of the table. (**Maaz Ahmad**)
- [ ] Put Atlas's real cost figure in the spend confirmation (decision 6). (**Maaz Ahmad**)
- [ ] Keep the existing rules intact: no credentials, no polling, no timeout, no retry, `Content-Type` as the only header. A retry is a decision a person makes by clicking, and aborting a `/generate` does not un-bill it. (**Maaz Ahmad**)
- [ ] Do **not** add a one-click full-chain button (decision 10). (**Maaz Ahmad**)

### Tests

- [ ] Extend the existing component and domain tests to cover the Atlas path rather than starting a parallel structure. (**Maaz Ahmad**)
- [ ] Test that `validateAtlasGenerate` rejects an empty regions array, a missing `pattern_ref`, and a missing `garment_ref` **before** any request is made. That validation is what stops a paid route being called with a body it will reject. (**Maaz Ahmad**)
- [ ] Test that selecting a scarf clears a previously-checked sleeve region (decision 4). (**Maaz Ahmad**)
- [ ] Add an Atlas fixture to `apps/frontend/src/domain/rows.fixture.ts` with a single row, and test the history renders it correctly. This is the free way to build decision 5. (**Maaz Ahmad**)
- [ ] Test that switching between all three engines does not carry another engine's base URL over. (**Maaz Ahmad**)

### Review gates

- [ ] Do the whole chain yourself in a browser: Helios run, copy into Iris, Iris run, copy into Atlas, Atlas run, look at the garment, resume it. If any step needs explaining, the labels need work. (**Maaz Bin Asif**)
- [ ] Confirm the spend dialog shows Atlas's number when Atlas is selected, and Iris's and Helios's when they are. (**Maaz Bin Asif**)
- [ ] Confirm the history shows a complete Atlas run from one row, with nothing rendered as missing or empty because a second row was expected (decision 5). (**Maaz Bin Asif**)
- [ ] Confirm the garment and region controls are generated from the schema enums, not from a literal array in a component (decision 2). (**Maaz Bin Asif**)
- [ ] Confirm Helios and Iris both still work exactly as before. Helios is deployed, so this is the regression check that matters most. (**Maaz Bin Asif**)
- [ ] Confirm `ALLOWED_ORIGINS` on Atlas is a specific list and is not `*`. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: two or three Atlas runs, roughly a cent, plus whatever an upstream Iris pattern costs if you do not already have one.** Everything else is free. Specifically:

- Build the whole UI against the `rows.fixture.ts` Atlas row, with no worker running at all.
- Build the controls and the disabling logic against nothing; they are pure state.
- Reuse an existing Iris `image_url` rather than generating a fresh pattern.

1. `npm run dev --workspace=apps/frontend`. The page loads, the engine control offers three engines, and switching to Atlas shows the garment and region controls.
2. With no worker running, confirm the page reports a clear connection failure rather than looking broken. `describeFetchFailure` already writes a good message; make sure the Atlas path reaches it.
3. Click generate with no regions checked and confirm the page refuses locally without sending a request. Check the network tab.
4. Pick a scarf, confirm sleeve and neck are unavailable.
5. A real run: the garment image renders, cost is shown, one row appears in the history with `source_p_invoc_id`, `pattern_ref`, `garment_ref` and the placement all populated.
6. Resume from the page and confirm a new, different image.
7. Switch back to Helios and to Iris and confirm both still work.
8. `npm test --workspace=apps/frontend` passes.

## Two things that will waste your afternoon

**A refused CORS preflight is invisible to JavaScript, on purpose.** The browser will not tell the page that an origin was rejected, because that would leak whether the origin is allowed. So a missing entry in Atlas's `ALLOWED_ORIGINS` looks exactly like the worker being down. If a call fails and the worker is definitely up, check `ALLOWED_ORIGINS` before anything else and look for the 403 on the preflight in the network tab.

**Code that assumes two rows per invocation will not crash on an Atlas run, it will just render it wrong.** A `rows.find(r => r.modality === 'image')` returns undefined, a cost total comes out as zero or `NaN`, and the row looks like a backend failure. iris-12 left a comment at exactly that spot for exactly this reason. Find it first, before writing anything new.
