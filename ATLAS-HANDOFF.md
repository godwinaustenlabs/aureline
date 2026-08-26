# Atlas: what is built, and how to wire Iris in

**For whoever picks this up next, human or model.** Read this before touching `apps/agent-atlas`. It has two halves: what exists today, and what to do when Iris arrives.

Written 2026-08-26, on branch `dev-atlas`, at commit `0c393c9`.

---

## 1. Where Atlas sits

Aureline turns a textile concept into a production-ready design, using **engines** — small, independently deployable Cloudflare Workers that each own one part of the problem.

```
Helios  ──▶  Iris  ──▶  Atlas
pattern      colour      placement
(built,      (built on   (built here,
 deployed)    dev-iris)   image call faked)
```

- **Helios** turns a concept into a black-and-white pattern. Deployed.
- **Iris** colours that pattern. It is still a flat repeating pattern — *not* a garment.
- **Atlas** takes Iris's coloured pattern plus a garment image, and prints the pattern onto the garment.

**Atlas's output is the thing the whole sprint exists to show.** It is also the only part with no cheap iteration loop, which is why almost everything about it is built to avoid spending money by accident.

---

## 2. What is built

Everything except the one billable model call. `POST /generate` runs real validation, writes a real row, saves real bytes to R2, exports to D1, prunes, and returns a real `AtlasResult`. `services/placer.ts` returns a fixture image and spends nothing.

| Ticket | What it covers | State |
|---|---|---|
| `shared-04` | Per-engine ADR directories, `docs/adr/{iris,atlas,shared}/` | Done |
| `iris-01` | `packages/shared-types/src/v1/iris.ts` | Taken verbatim from `dev-iris` |
| `atlas-01` | The Zod contract | Done |
| `atlas-02` | Workspace, `wrangler.jsonc`, `config.ts`, CORS, routing | Done |
| `atlas-04` | `atlas_runs` schema, repository, ADR-ATLAS-0001 | Done |
| `atlas-05` | Garment glossary, `buildPlacementPrompt` | Done (final wording pends atlas-03) |
| `atlas-06` | The pipeline, image call faked | Done |
| `atlas-09` | D1 export and pruning | Done |
| `atlas-03` | The probe: can the model do this at all? | **NOT RUN** |
| `atlas-07` | The real image call | **Blocked on atlas-03 only** — iris-07's helper has landed |
| `atlas-08` | `POST /resume` behaviour | **Route + validation only, returns 501** |
| `atlas-10` | Playground Atlas tab | **Not started** |

**116 tests, typecheck clean, zero model calls, nothing deployed.**

### Layout

```
apps/agent-atlas/src/
├── index.ts                  routing ONLY — no orchestration
├── agent.ts                  AtlasAgent DO, its own inline controller
├── config.ts                 the ONLY file that reads KV
├── cors.ts                   copied verbatim from Helios
├── utils.ts                  firstIssueMessage, describeError
├── test-env.ts               the ONE place a test double is typed as Env
├── db/
│   ├── schema.ts             atlas_runs, 12 columns, ONE row per invocation
│   └── client.ts             getDb (DO) / getD1Db, distinct types on purpose
├── repository/               the ONLY code allowed to touch storage
│   ├── do.repository.ts      nine functions
│   ├── d1.repository.ts      exportRuns, chunked at 8
│   ├── r2.repository.ts      saveGarmentImage / readGarmentImage
│   └── test-db.ts            real in-memory SQLite + the ONE asDb cast
├── services/
│   ├── pipeline.ts           runPipeline, runImageStage, exportAndPrune
│   └── placer.ts             placePattern — FAKED, atlas-07 replaces the body
├── prompts/
│   ├── garment.glossary.ts   typed Record — a missing entry is a compile error
│   └── placement.prompt.ts   buildPlacementPrompt, validRegionsFor
└── fixtures/
    ├── sample-iris-result.ts         a real IrisResult, schema-validated by a test
    ├── sample-images.ts              base64 of the two JPEGs below
    ├── sample-garment-reference.jpg  a plain tee (currently UNUSED — see section 5)
    └── sample-garment-output.jpg     a patterned tee, what the fake returns
```

---

## 3. The rules that are load-bearing

Break any of these and something expensive or invisible goes wrong.

**Two ids, and they are not interchangeable.** See `AGENTS.md` section 3 on `dev-iris`.

- `pipeline_id` — **one run of one engine.** Fresh per invocation. Atlas mints its own.
- `design_session_id` — **the design, across every engine.** Minted upstream, carried through Helios to Iris to Atlas **unchanged**. Required, no default, no auto-generation. A request without it is a 400.
- `session_id` — neither. It only picks which Durable Object serves the request (ADR-0005).

**A failed run is HTTP 200** carrying `status: "failed"`. Non-200 means the request never became a run. Branch on `status`, never on `response.ok` — this is a contract with the playground, and `agent.test.ts` asserts it at the HTTP level.

**One row per invocation, not two.** Helios and Iris write two rows (one per modality); Atlas has a single billable call and no partial-success case, so it writes one. `ADR-ATLAS-0001` argues the departure. Code assuming a pair will not crash — it renders `NaN` and looks like a backend bug.

**`runPipeline` never throws.** Every path returns a settled `AtlasResult`, including DO storage being unavailable. The cleanup inside the `catch` is itself wrapped, because a throw from inside a catch escapes.

**The image-cost variable lives outside the `try`.** The model bills *before* the R2 save and the row update, so a failure in either must still report what was spent.

**`runImageStage` is exported separately from `runPipeline`.** Atlas has one stage and inlining it reads better — and would make atlas-08's resume impossible without refactoring the only code path in the engine. Do not inline it.

**`GET /runs` is free and read-only, permanently.** It is the route a page calls on load and on every refresh. If it ever reaches a model, that is a bug.

**Nothing auto-retries.** Atlas's one call is expensive and one-shot; an automatic retry doubles the cost of every failure. A person retries via `POST /resume`, capped by `max_resume_attempts` counted over the **root** brief (never `resumed_from`, which would let a chain spend without limit).

**Four config keys, not five.** `image_model`, `max_retries`, `retention_limit`, `max_resume_attempts`. **There is no `text_model`** — Atlas has no text call. `max_retries` governs nothing here; it exists so all four resolve through the same code path.

**Timestamps are milliseconds, not seconds.** `pruneCompletedRuns` orders by `created_at`; at one-second resolution two runs in the same second sort arbitrarily and the prune deletes the wrong one. Atlas is *more* exposed than Iris — one row per invocation means no second timestamp breaks the tie.

---

## 4. The four-problem audit

The Iris squad found four bugs in a DB review. Atlas was audited against all four (commit `0c393c9`).

| | Found | Fixed |
|---|---|---|
| 1. Banned casts (`as never`, `as unknown as`) | 14 | Down to 5, each a documented platform boundary |
| 2. Adjacent same-type positional params | `startRun`, `insertFailedRun`, `runImageStage` — 4 strings each | All take one object (`RowSeed` / `PlacementRun`) |
| 3. Two ids sharing one name | — | Already renamed |
| 4. Silent fall-through on a missing row | `completeRun` UPDATEd blindly | Reads first, throws naming the id |

**A correction to the guidance, worth carrying forward:** it claims the object form makes a swap a *compile* error. **It does not.** `{ patternRef: req.garment_ref }` still typechecks — both are strings. What the object form removes is the *positional* hazard: arguments can no longer be silently reordered, and a swap must be written as a wrong field name, which is visible in review. **The behavioural test is the real net** (`do.repository.test.ts`, "records each seed field in its own column"), verified failing against a deliberately swapped call.

**A deliberate asymmetry, do not "fix" it:** `completeRun` throws on a missing row; `failRunningRuns` does not. The second runs inside a `catch` on the failure path, where the row may legitimately have settled or never opened — throwing would replace the real failure with a symptom of it.

**Atlas never had Iris's worst version of problem 4.** The infinite-loop incident lived in `resume.ts`, and Atlas's resume is still a 501 stub. That is exactly the file where the `?.` fall-through would reappear — **whoever builds atlas-08 must read that incident first.**

---

## 5. The open question: where does the garment come from?

**Today: the caller supplies it.** `AtlasRequestSchema.garment_ref` is a required `.url()` pointing at a garment photo the caller hosts. Atlas ships no garment images.

The model receives **two** images and invents neither:

- `input_image_0` — Iris's coloured pattern
- `input_image_1` — the garment

Order is not negotiable: `buildPlacementPrompt` says "the FIRST image" and "the SECOND image". This was a deliberate reversal — the original plan had the model generate the garment from words alone, and it was overturned because a real anchor image gives it something concrete to render onto.

**The gap:** `sample-garment-reference.jpg` exists but **nothing uses it**. Only the test touches it, to assert the two fixtures differ. The repo owner was considering shipping five stencils of our own (one per `garment_type`) so callers stop pasting URLs. **That change was not made.** It would mean dropping `garment_ref`, deriving the stencil from `garment_type`, and a schema migration.

**Do not start that work before `atlas-03` runs.** Its whole job is to confirm the model respects `input_image_1` rather than ignoring it and drawing its own garment. Its findings table is blank. If it ignores the second image, stencils are wasted effort and the approach needs rethinking. Cost: about a cent.

---

# FUTURE IMPLEMENTATION: wiring Iris in when it arrives

## Step 0 — know where Iris actually is

**`dev-iris` is well ahead of `dev` and `dev-atlas`.** As of 2026-08-26:

- `apps/agent-iris` is fully built. iris-08 (real planner) and iris-09 (real image call) are **merged**.
- It carries an `AGENTS.md` that `dev-atlas` does not have. **Read it first** — section 3 (the three ids) and section 4 (no `as never`, no `any`, no `as unknown as T`) are repo-wide rules.
- It has `docs/iris-runs-conventions.md`.

```bash
git fetch origin 'refs/heads/dev-iris:refs/remotes/origin/dev-iris'
git log --oneline -5 origin/dev-iris
```

**First action: merge `dev-iris` into `dev-atlas`.** Rehearse it first, per `.scratch/shared-sprint-2/sprint-2-3-conventions.md`:

```bash
git merge-tree --write-tree --name-only HEAD origin/dev-iris
```

**The Iris contract has already moved once.** The `.scratch` tickets still say `source_p_invoc_id` and `p_invoc_id`; the real contract uses `design_session_id` and `pipeline_id`, and Iris **rejects the old name with a 400**. Atlas is already rebased onto the new names. **Trust `packages/shared-types/src/v1/iris.ts` over any ticket text.**

## Step 1 — swap the fixture for real Iris output

This is `shared-02`, and it was designed to be a **data change, not a code change**.

`apps/agent-atlas/src/fixtures/sample-iris-result.ts` holds a complete `IrisResult`. `fixtures.test.ts` runs `IrisResultSchema.parse` over it — **not** merely a type annotation, because an annotation is checked against a schema that may have moved.

**If that test goes red after the merge, the contract moved and the fixture is what to fix** — not the schema, unless the schema is genuinely wrong.

**There is exactly one path from an Iris result into an Atlas request:**

```ts
import { atlasInputFromIrisResult } from "@aureline/shared-types";

const input = atlasInputFromIrisResult(irisResult);
// -> { pattern_ref, design_session_id }
```

Never reconstruct those two fields by hand. The helper:

- maps Iris's `image_url` to Atlas's `pattern_ref`
- passes `design_session_id` through **unchanged**
- deliberately does **not** carry Iris's `pipeline_id` — that names Iris's run; Atlas mints its own
- **throws** when `image_url` is null (a failed Iris run produced no pattern, and a request built from it would reach a billed call with a reference to nothing)

## Step 2 — reading Iris's image

`pattern_ref` may be **either** a URL or an R2 key. Iris and Atlas **share one bucket**, `images-bucket`, with engine key prefixes:

- Iris writes `iris/{pipeline_id}.jpg`
- Atlas writes `atlas/{pipeline_id}.jpg`

So an R2 key just needs the `iris/` prefix to be readable through Atlas's own `PATTERNS` binding. **No cross-bucket access is involved.** `readGarmentImage` already reads any key in the bucket, deliberately.

**Both reads go through `repository/`**, even a URL that never touches R2. `repository/` is the only code allowed to touch storage — that rule does not bend for `fetch`.

## Step 3 — the real model call (atlas-07)

**Blocked on one thing: `atlas-03` has not run.** It answers whether the model can do this at all — whether it respects `input_image_1` or ignores it and draws its own garment. A negative result invalidates atlas-05, 06 and 07. That is a successful ticket, not a failed one.

**The helper you need already exists**, on `dev-iris`, built by iris-07 and exported from the `shared-utils` barrel:

```ts
import { getImageToImageOutput, type InputImage } from "@aureline/shared-utils";

export async function getImageToImageOutput(
  prompt: string,
  images: InputImage[],   // up to four, sent as input_image_0 .. input_image_3
  ...
): Promise<ImageToImageOutput>
```

It posts multipart form data, not the plain JSON body `getImageModelOutput` assumes — which is exactly why a second helper would be wrong. **It is not on `dev-atlas` yet**; it arrives with the `dev-iris` merge in Step 0.

**Use it unchanged. Do not write a second one.** If it cannot express something Atlas needs, that is a group discussion, not a patch — a shared package changing mid-sprint is the likeliest cross-squad conflict.

Then replace **only the body** of `placePattern` in `services/placer.ts`. Its signature is already final:

```ts
export async function placePattern(
  patternRef: string, garmentRef: string, placement: AtlasPlacement,
  config: AtlasConfig, env: Env, pipelineId: string,
): Promise<PlacementOutput>
```

The body must:

- fetch both images **through `repository/`**
- resize each **independently**, preserving each one's own aspect ratio (they do not share a source size; stretching either to a square reads as a model problem when it is really the resize)
- pass pattern as `input_image_0`, garment as `input_image_1` — **never swapped**
- **skip the gateway cache**, or a resume returns the first attempt while still billing
- read the real cost with `readGatewayCost(env, "image")` **immediately** after the call — an image model's gateway log row appears before its `cost` field is filled in, and a read on the next line finds the row present and the cost absent. That happened to a real Helios production run.
- return bytes and dimensions only. **`placePattern` must not know R2 exists** — the pipeline saves.

`pipeline.test.ts` uses a fake `AI` binding that **throws if called**. When atlas-07 lands, that fake must stay throwing in every test that is not explicitly testing the real call.

## Step 4 — resume (atlas-08)

**Read the `resume.ts` incident first** (described in section 4 above). It is the single most expensive bug this project has had: a swapped argument corrupted a row, the code read `imageRow?.status` with optional chaining, the corrupted row matched neither settled branch, and execution fell straight through into generating another image — repeatedly, with nothing thrown.

- Re-enter at `runImageStage`, **never** at `runPipeline`. That is why it is exported separately.
- A resumed run writes **one** row, not two — the markers `root`, `resumed_from`, `attempt` go on the only row there is, via `runImageStage`'s `metadataExtras`.
- The cap counts by **`root`**, never `resumed_from`. `countResumeAttempts` already does this.
- **Re-validate the stored placement** with `AtlasPlacementSchema` before spending. `garment_regions` is a JSON column that reads back `unknown`, and rows outlive the code that wrote them.
- A refusal is **409**, not a failed result — nothing was written, nothing was billed.
- **No optional chaining that lets a missing row fall through.** Check the row first and fail loudly.
- Decide, and write down, what an unfetchable `pattern_ref` or `garment_ref` means. Both are Atlas's likeliest real failures. They need **two distinct messages** — a caller told "the reference is unfetchable" with no indication of which one has no way to fix it.

## Step 5 — the playground tab (atlas-10)

`apps/frontend` **is already merged into `dev-atlas`** (commit `499aea5`). But:

**`iris-12` never landed, so there is no `Engine` type.** `src/state/settings.ts` is still single-engine — one `helios-playground.baseUrl`, Helios only. atlas-10 assumes iris-12 "already did most of the structural work". It did not. That work comes first: `Engine` type, per-engine base URL, engine selector.

Three files will break on an Atlas run, and none of them will crash — they will render wrong and look like a backend bug:

- **`domain/outcome.ts`** — `isHeliosResult` checks `p_invoc_id`. Atlas has `pipeline_id`. This is the file where getting it wrong makes every failed run render as a blank success.
- **`domain/runView.ts`** — `groupRows` assumes two rows per invocation and does `rows.find(r => r.modality === 'image')`. Atlas rows have no `modality`. Cost comes out `NaN`.
- **`api/runs.ts`** — `RunRow` mirrors `helios_runs`. Atlas's row has different columns.

Render controls from the schema enums (`GarmentTypeSchema.options`, `GarmentRegionSchema.options`), never a hand-written list. Add an Atlas row to `domain/rows.fixture.ts` and build the whole panel against it — **no worker needed, nothing billed.**

---

## Environment gotchas that will waste your afternoon

**Run `npx tsc --noEmit` from INSIDE `apps/agent-atlas`**, never the repo root. The root resolves TypeScript 7, which rejects this project's `"moduleResolution": "node"` with TS5108. The app carries its own TypeScript 5.

**`@rolldown/binding-win32-x64-msvc` gets dropped on every `npm install`** (a known npm optional-dependency bug). Vitest then fails to start with a `MODULE_NOT_FOUND` that looks unrelated. Fix:

```bash
npm install --no-save @rolldown/binding-win32-x64-msvc@1.2.0
```

**Node 22 works despite `engines: >=24`.** `node:sqlite` runs with an experimental warning. Tests pass.

**Reach local KV only through the npm scripts** — `npm run kv:put --workspace=apps/agent-atlas`. A bare `wrangler` from the repo root finds no `wrangler.jsonc`, silently does nothing, and you conclude config is broken when it is working. This has cost real money once.

**`wrangler kv key put --local` does not reach a running `wrangler dev`.** They hold separate state; restart the dev server to see a new key. Note also that `CONFIG_CACHE_TTL` is 60 seconds.

**Never hand-fix a `package-lock.json` conflict.** Delete it and `npm install`. That rule is in `sprint-2-3-conventions.md` and it exists because two new apps landed in one week.

**A repeating `d1 export failed` line is not cosmetic.** The swallow is deliberate (ADR-0010) — an audit failure must not cost a caller the result they already waited for, and a transient one is picked up by the next run's export. But prune only runs *after* a successful export, so a **persistent** failure (a misconfigured D1 binding, an unapplied migration) means the Durable Object grows without bound, and failed runs are never pruned at all. The log line names the unexported row count for exactly this reason: **if it repeats with a rising count, fix D1 before anything else.**

**Cloudflare resources are placeholders.** `database_id` and the KV `id` in `apps/agent-atlas/wrangler.jsonc` are zeros. Local dev simulates both. A real deploy needs: D1 `atlas-d1`, KV namespace titled `ATLAS_CONFIG` (put its **id**, not its title — a title passes `--dry-run` and local dev and fails only against the real API), R2 `images-bucket`, and an AI Gateway named `atlas`.

---

## Verification, end to end

Budget: **$0**. The image call is faked and the test `AI` binding throws if touched. A charge means something is wired wrong, and that is the bug.

```bash
npm install
cd apps/agent-atlas && ./node_modules/.bin/tsc --noEmit   # clean
npm test --workspace=apps/agent-atlas                      # 116 pass
npx wrangler deploy --dry-run                              # bindings resolve
npm run dev --workspace=apps/agent-atlas

curl localhost:8787/            # Atlas Agent is running
```

A full generate:

```bash
curl -s -X POST localhost:8787/generate -H 'Content-Type: application/json' \
  -d '{"pattern_ref":"iris/x.jpg","garment_ref":"https://example.com/s.jpg",
       "design_session_id":"design-1","garment_type":"tshirt","regions":["back","hem"]}' | jq
```

Expect `status: "completed"`, a non-null `image_url`, `width` and `height` of 512, `cost_usd: null`, and a `placement` carrying `prompt_version`.

**Then open `image_url` in a browser and look at it.** Not a curl returning 200 — actually look. That is the only step proving the bytes survive R2 and render, and it is the whole point of the fixture.

Two failure paths worth checking by hand:

```bash
# a sleeve on a scarf -> HTTP 200, status failed, error prefixed "validate:"
curl -s -X POST localhost:8787/generate -H 'Content-Type: application/json' \
  -d '{"pattern_ref":"iris/x.jpg","garment_ref":"https://example.com/s.jpg",
       "design_session_id":"design-1","garment_type":"scarf","regions":["sleeve"]}' | jq

# a missing design_session_id -> HTTP 400, no pipeline_id in the body
curl -s -X POST localhost:8787/generate -H 'Content-Type: application/json' \
  -d '{"pattern_ref":"iris/x.jpg","garment_ref":"https://example.com/s.jpg",
       "garment_type":"tshirt","regions":["back"]}' | jq
```

---

## Read these, in this order

1. `AGENTS.md` — **on `dev-iris`.** Section 3 (three ids) and section 4 (no casts) are repo-wide.
2. `docs/engines/atlas.md` — only what Atlas does differently.
3. `docs/adr/atlas/0001-atlas-has-one-image-call-and-one-audit-row.md` — why one row, and what would change the answer.
4. `docs/adr/0009` and `0010` — retry policy, and export-before-prune.
5. `.scratch/atlas-sprint-2/issues/` — the tickets. **Treat their id names as stale**; the code is right.
6. `.scratch/shared-sprint-2/sprint-2-3-conventions.md` — branches, lockfiles, Cloudflare.

**Where a doc and the code disagree, the code is right and the doc is a bug. Please fix it.**
