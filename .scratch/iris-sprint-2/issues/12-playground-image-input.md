# iris-12: Playground support for Iris

**What to build:** teach the existing playground at `apps/frontend` to drive Iris as well as Helios. That means a way to pick which engine you are talking to, and two extra input fields, because Iris needs a motif reference and the Helios run it came from. Not a second app.

**Objective:** everything in Iris is verifiable with curl, and nobody wants to verify a colored image with curl. The playground already exists, already handles base URL switching, already has a run history, a scratchpad and a spend confirmation dialog. What it cannot do is send an input image reference, because Helios never needed one. That single gap is this ticket.

**Final result:** open the playground, switch it to Iris, paste a concept and a motif reference from a Helios run, click generate, and see the colored result with its cost and its two audit rows. Resuming works from the same page.

**Blocked by:** iris-05 for the real response shape. **Also blocked by a merge:** `apps/frontend` currently only exists on the `playground` branch and is not in `dev`. That branch has to land in `dev` before this ticket can start.

**Neither blocker clears on the scheduled day.** iris-05 runs Wed Aug 26 to Thu Aug 27, and the `playground` merge has no owner and no date at all. The date below is therefore aspirational, not a plan. Two things have to happen before it becomes real: someone takes the `playground`-into-`dev` merge as named work, and iris-05 merges. Chase the first now — it is the one nobody is currently driving, and it is not Iris work, so it will not surface on its own.

**Status:** blocked, waiting on the `playground` branch reaching `dev` **and** on iris-05.

**Owner:** Maaz Ahmad. **Reviewer:** Maaz Bin Asif.

**Duration:** 1 day. **Scheduled:** Mon Aug 24 to Mon Aug 24.

## Read this first

- `apps/frontend/src/state/settings.ts` (30 lines). The base URL is already configuration, not a constant: a build-time default, overridable by a field in the UI, persisted in `localStorage`. Read the doc comment at the top; it explains the reasoning you are extending.
- `apps/frontend/src/api/client.ts` (128 lines). Every request the page makes. Read the three rules in its header comment, because all three still hold for Iris: no credentials, no retry or polling or timeout, and `Content-Type` as the only header.
- `apps/frontend/src/domain/validate.ts` (44 lines). It imports the worker's own schema and validates before sending, so a 400 round trip is avoided and the error message is better. Iris gets the same treatment with `IrisRequestSchema`.
- `.scratch/helios-sprint-1/issues/09-minimal-playground.md`, for the decisions this page already made and should keep.

## Decisions

1. **One playground, two engines. Not a second app.** The page already switches backends by base URL, which is most of the work. A second app would duplicate the run history, the scratchpad, the spend confirmation and the CORS handling, and the duplicate would drift.
2. **The engine choice is explicit, not inferred from the URL.** A dropdown or a pair of radio buttons, persisted alongside the base URL. Guessing the engine from the hostname breaks the moment both workers are on `*.workers.dev`, and it breaks silently by sending the wrong request shape.
3. **Iris's routes are the same names as Helios's**, deliberately: `POST /generate`, `POST /resume`, `GET /runs`, `GET /`. So `client.ts` needs no new functions, only a wider request type. This is why iris-05 named the entry route `/generate` rather than `/colorize`.
4. **`motif_ref` is a reference the user pastes, not a file they upload.** A URL or an R2 key. Uploading a file would mean base64 in the request body, a bigger `ALLOWED_HEADERS` surface, and Iris accepting bytes it does not want. The realistic workflow is: run Helios, copy the `image_url` from its result, paste it into Iris. Support exactly that.
5. **`source_p_invoc_id` is a required field on the form**, because it is required by `IrisRequestSchema`. Make it obvious where to get it: it is the `p_invoc_id` from the Helios run whose image you just pasted.
6. **Validate with `IrisRequestSchema` before sending**, imported from `@aureline/shared-types`, the same way `validateGenerate` already imports Helios's. Do not hand-copy the rules. A hand-copied `max(512)` on `motif_ref` drifts the moment the contract moves.
7. **The spend confirmation stays, with Iris's real number.** `client.ts` carries `GENERATE_COST_USD = 0.0029` as a literal for Helios. Iris's generate is a text call plus an image call, so it needs its own figure, from iris-08 and iris-09's measured costs. A confirmation dialog showing the wrong engine's price is worse than none.
8. **`GET /runs` is free and must stay free.** It is the route the page calls on load, on every session switch, and after every run. Nothing on that path may reach a model. This was already a rule for Helios and it carries over unchanged.
9. **The run-history table needs Iris's extra columns.** `iris_runs` has `source_p_invoc_id` and `motif_ref` that `helios_runs` does not. Show them when the engine is Iris, rather than a shared lowest-common-denominator table that hides exactly the two columns that make an Iris row traceable.
10. **Note the Atlas shape now, but do not build it.** Atlas has one image call and no text call, so its run rows have no `text` modality at all and any code assuming two rows per invocation will misread them. Leave a comment where that assumption lives. Atlas's own panel is its own ticket in the Atlas backlog.

## Agreed shapes, do not invent your own

```ts
// apps/frontend/src/state/settings.ts
export type Engine = 'helios' | 'iris';
export function loadEngine(): Engine;
export function saveEngine(engine: Engine): void;
// Base URL is stored per engine, so switching engines does not make you retype
// the other one's URL every time.
export function loadBaseUrl(engine: Engine): string;
export function saveBaseUrl(engine: Engine, baseUrl: string): void;
```

```ts
// apps/frontend/src/api/client.ts
// One function, a wider request type. No new endpoints.
export async function generate(baseUrl: string, request: HeliosRequest | IrisRequest): Promise<CallOutcome>;

export const IRIS_GENERATE_COST_USD = /* from iris-08 + iris-09 */;
export const IRIS_RESUME_COST_USD = /* from iris-09 */;
```

```ts
// apps/frontend/src/domain/validate.ts
export function validateIrisGenerate(
  concept: string, motifRef: string, sourcePInvocId: string, sessionId: string
): Validated;
```

## Work

### The prerequisite

- [ ] Get the `playground` branch merged into `dev` first. Rehearse it with `git merge-tree dev playground` before the real merge, per `docs/sprint-2-3-conventions.md`. Nothing else in this ticket can start until `apps/frontend` is on `dev`. (**Maaz Ahmad**)
- [ ] Add the playground's deployed origin to Iris's `ALLOWED_ORIGINS` in `apps/agent-iris/wrangler.jsonc`, plus the local dev origins. There is no auth on `/generate` and it spends real money, so this list is the only thing stopping any webpage from billing our account. Never `*`. Regenerate types after the edit, because `wrangler types` types vars as literals. (**Maaz Ahmad**)

### The engine switch

- [ ] Extend `settings.ts` with the engine choice and a per-engine base URL, per the shapes above. Keep the existing `try`/`catch` around `localStorage`: losing the persisted value should cost a retype, not break the page. (**Maaz Ahmad**)
- [ ] Add the engine control to the input panel. Switching it changes which fields are shown and which base URL is in the field. (**Maaz Ahmad**)
- [ ] Do **not** infer the engine from the base URL (decision 2). (**Maaz Ahmad**)

### The Iris input fields

- [ ] Add `motif_ref` and `source_p_invoc_id` inputs, shown only when the engine is Iris. (**Maaz Ahmad**)
- [ ] Label them so the workflow is obvious without documentation. Something like "Motif image URL (paste the `image_url` from a Helios run)" and "Helios run id (the `p_invoc_id` that produced it)". A field called `motif_ref` with no explanation will be filled in wrong. (**Maaz Ahmad**)
- [ ] Add a convenience action: when a Helios run is selected in the history, offer to copy its `image_url` and `p_invoc_id` straight into Iris's fields. The two engines are used together and there is no coordinator engine yet, so a human is doing this hand-off on every single run. (**Maaz Ahmad**)
- [ ] Write `validateIrisGenerate` in `domain/validate.ts`, importing `IrisRequestSchema` (decision 6). Omit `session_id` rather than sending it empty, matching what `validateGenerate` already does and why. (**Maaz Ahmad**)
- [ ] Do **not** add a file upload (decision 4). (**Maaz Ahmad**)

### Output and history

- [ ] Show the colored image from `image_url`, reusing the existing `ImageOutput` component. (**Maaz Ahmad**)
- [ ] Show `width` and `height` from the result. They are on `IrisResult` specifically so a consumer does not have to decode the image, and seeing them on screen is how anyone notices the resize step from iris-09 misbehaving. (**Maaz Ahmad**)
- [ ] Add `source_p_invoc_id` and `motif_ref` columns to the run history when the engine is Iris (decision 9). (**Maaz Ahmad**)
- [ ] Put Iris's real cost figures in the spend confirmation (decision 7). Take them from iris-08 and iris-09's measured numbers, not from Helios's. (**Maaz Ahmad**)
- [ ] Leave a comment where the two-rows-per-invocation assumption lives, noting that Atlas has one row and no `text` modality (decision 10). Do not build Atlas's panel here. (**Maaz Ahmad**)
- [ ] Keep the existing rules from ticket 09 intact: no credentials, no polling, no timeout, no retry, `Content-Type` as the only header. A retry is a decision a person makes by clicking, and aborting a `/generate` does not un-bill it. (**Maaz Ahmad**)

### Tests

- [ ] Extend the existing component and domain tests to cover the Iris path. The existing suite has tests for `App`, `ImageOutput`, `RunHistory`, `Scratchpad`, `outcome`, `runView`, `scratchpad`, `sessions` and `spend`; add to them rather than starting a parallel structure. (**Maaz Ahmad**)
- [ ] Test that `validateIrisGenerate` rejects a missing `motif_ref` and a missing `source_p_invoc_id` **before** any request is made. That validation is what stops a paid route being called with a body it will reject. (**Maaz Ahmad**)
- [ ] Test that switching engines does not carry the other engine's base URL over. (**Maaz Ahmad**)

### Review gates

- [ ] Do the whole flow yourself, end to end, in a browser: Helios run, copy its output into Iris, Iris run, look at the colored image, resume it. If any step needs explaining, the labels need work. (**Maaz Bin Asif**)
- [ ] Confirm the spend dialog shows Iris's number when Iris is selected, not Helios's. (**Maaz Bin Asif**)
- [ ] Confirm `GET /runs` is still the only thing called on page load, and that it reaches no model (decision 8). Check the network tab, not the code. (**Maaz Bin Asif**)
- [ ] Confirm `validate.ts` imports `IrisRequestSchema` rather than restating its rules. (**Maaz Bin Asif**)
- [ ] Confirm `ALLOWED_ORIGINS` on Iris is a specific list and is not `*`. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: two or three Iris runs, roughly a cent, plus one Helios run to produce a motif.** Everything else is free. Specifically:

- Build and check the whole UI against a **failed** or already-completed run first, using `GET /runs`, which costs nothing.
- The `rows.fixture.ts` file already exists in `apps/frontend/src/domain/` for exactly this. Add an Iris fixture to it and build the history table against that, with no worker running at all.
- Spend a real call only for the final end-to-end pass.

1. `npm run dev --workspace=apps/frontend`. The page loads, the engine control is there, and switching to Iris shows the two extra fields.
2. With no worker running, confirm the page reports a clear connection failure rather than looking broken. `describeFetchFailure` already writes a good message naming both likely causes; make sure the Iris path reaches it too.
3. Point at a running Iris worker, click generate with an empty `motif_ref`, and confirm the page refuses locally without sending a request. Check the network tab.
4. A real run: colored image renders, cost shown, two rows in the history with `source_p_invoc_id` and `motif_ref` populated.
5. Resume from the page and confirm a new, different image.
6. Switch back to Helios and confirm it still works exactly as before. This is the regression check that matters most, since Helios is deployed.
7. `npm test --workspace=apps/frontend` passes.

## Two things that will waste your afternoon

**A refused CORS preflight is invisible to JavaScript, on purpose.** The browser will not tell the page that an origin was rejected, because that would leak whether the origin is allowed. So a missing entry in Iris's `ALLOWED_ORIGINS` looks exactly like the worker being down. `describeFetchFailure` in `client.ts` already names both causes in its message for this reason. If a call fails and the worker is definitely up, check `ALLOWED_ORIGINS` before anything else, and look for the 403 on the preflight in the network tab.

**Sharing one base URL between the two engines seems simpler and will cost you a wrong-engine call.** You switch to Iris, the field still holds Helios's URL, you click generate, and Helios receives a body with `motif_ref` in it. Zod strips unknown keys by default, so it does not error: it just runs a normal Helios generate and bills you for it. Per-engine base URLs, per the shape above, is not a nicety.
