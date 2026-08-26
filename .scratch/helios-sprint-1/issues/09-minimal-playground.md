# 09 — Playground

**What to build:** An internal debug console. One page where you type a concept, spend the money once, and see as much of what happened as the engine is capable of telling you. It replaces curling the API by hand.

**It lives in `apps/frontend`, deploys as a worker named `frontend`, and is built on its own branch off `dev`,** `feature/09-frontend`. Nothing in it goes onto a branch shared with backend work: this is a new app and it will churn, and `agent-helios` should stay reviewable on its own.

It is **its own app, deployed separately** from `agent-helios`. A static frontend talking to the worker over HTTP and nothing else. There is no shared runtime, no service binding, no same-origin anything.

**Blocked by:** nothing. 01, 06 and 08 are all merged into `dev`.

**Status:** ready-for-agent. Both backend pieces are built and merged, `GET /runs` and CORS, so nothing blocks the frontend. The frontend is unstarted.

**Team:** Frontend Team. The two backend boxes are worker code and are assigned separately.

**Stack is the frontend team's choice.** This ticket says what the page must do and what the API gives it. Pick whatever you want to build it in.

## Read this first

Three things about this API will each produce a shipped bug if you assume the usual conventions.

**A failed run is HTTP 200.** `HeliosResult` is a settled-outcome envelope and the real answer is in `status`. The worker returns non-200 only for transport errors that never became a run. If you branch on `response.ok`, every failed run renders as a success with a blank image. Check `status`, not the HTTP code. This is deliberate and settled, see ticket 08 decision 4.

**A resume refusal is HTTP 409 and cost nothing.** It is a third outcome class, not an error and not a run. The body is `{ "error": "<human readable reason>" }` and that sentence is written to be shown to a person verbatim. Do not replace it with your own copy.

**`cost_usd` in the response is the image cost only.** The planner cost is recorded on the text row and never returned in the result. A field labelled "cost" reading `0.0019` when the run actually cost `0.0029` is worse than showing nothing. Either label it "image cost" or get the real total from `GET /runs`.

## What the page needs

Four regions on one page.

### 1. Input

| Field | Notes |
|---|---|
| Concept | Textarea. Required, trimmed, 1 to 1000 characters. Validate before submitting, a 400 round trip is pointless |
| Session id | Text, free-form, plus a **Randomise** button and a picker of sessions used before. **First class, not hidden in settings.** It picks which Durable Object serves the request, so it decides which runs the history shows and which runs can be resumed. See below |
| Reference image | File input. Rendered, accepted, previewed locally, **never sent**. Carries a visible label saying it is not wired to the planner yet |
| API base URL | Text, defaults to `http://localhost:8787`. Lets the same build point at local dev or the deployed worker |
| Generate | Disabled while a run is in flight. Confirms the spend before the first call |

The reference image field is in scope purely so the shape exists for a later sprint. Discard it client-side. If it silently vanished with no label, the next person to test the page reports it as a bug.

#### Sessions

The session id **is** the Durable Object name (ADR-0005). Send the same string and you land in the same DO, with the same history and the same runs available to resume. Send a different one and you get a different store that shares nothing with it. Since this page is for testing, that is how testers keep their runs apart, so make it easy to work with rather than a text box people paste into.

Three ways to set it:

- **Type one.** Any non-empty string. It is trimmed, and it is used exactly as typed, so `Test`, `test` and `test ` are two different DOs and one of them is not the one you meant. Trim and lowercase before sending if you want to spare people that.
- **Randomise.** A button that generates a fresh readable id, something like `test-quiet-harbor-4f2a`. Use it when you want a clean store rather than adding to an existing one. Random ids are what stop two people testing at once from pruning each other's history out.
- **Pick a previous one.** A list of sessions this browser has used, most recent first. Selecting one puts it in the field, and the next `GET /runs` and the next Generate both go to that DO. Nothing else needs to happen: the id in the field is the whole mechanism.

**The list of previous sessions has to live in `localStorage`.** There is no route that lists sessions and there cannot easily be one. Durable Objects are addressed by name and cannot be enumerated, and `helios_runs` carries no session column in either the DO or D1, so even the permanent D1 copy cannot say which sessions exist. A session id that this browser never used is unreachable through the picker and has to be typed in.

Two consequences worth showing in the UI rather than discovering:

- **An empty session id is not "no session".** The worker falls back to a shared DO literally named `default`, which is where every run made without an id has ever gone. It is a real store with a real history, not a blank slate.
- **Resume is session-bound.** A `p_invoc_id` from one session 409s in another with "no run with that id in this session". If the user switches sessions with a run on screen, its Resume button no longer applies.

### 2. Scratchpad

The debugging surface, and the reason this ticket exists. It fills in **once, after the response arrives**, from a follow-up `GET /runs` call. There is no streaming: the pipeline is one synchronous request and nothing exists until everything is done. While waiting, show a spinner and the elapsed wall clock. **Do not fake a stage-by-stage animation.**

What it shows, and where each value comes from:

| Row | Source |
|---|---|
| Status per stage | `status` on the text row and the image row |
| Which stage failed | the `stage:` prefix on `error`, one of `persist`, `planner`, `validate`, `image` |
| Planner model, token usage | `modelMetadata` on the text row |
| Image model, resolved steps | `modelMetadata` on the image row |
| Planner cost, image cost, **real total** | `costUsd` on both rows, added up |
| True per-stage duration | `completedAt` minus `createdAt`, per row |
| Params the planner produced | `plannerParams`, or `params` on the result |
| R2 key | `imageR2Key` on the image row |
| Resume lineage | `root`, `resumed_from`, `attempt` inside `modelMetadata`, when present |
| Client wall clock | measured in the browser |

**It must also name what is missing, rather than leaving a gap.** These are not captured anywhere in the engine, and each gets a visible row saying so with the reason. An empty box reads as a page bug. A labelled gap reads as an engine gap, which is what it is, and gives us a list if we later decide to capture them.

| Not available | Why |
|---|---|
| The model's reasoning or thinking | `getTextualModelOutput` returns only `{ data, usage, model }` and drops the rest of the reply (`packages/shared-utils/src/getTextualModelOutput.ts:246`). Nothing stores it |
| The planner prompt | Built per call in `prompts/planner.prompt.ts`, never stored or returned |
| The image prompt sent to Flux | Built per call by `buildImagePrompt`, never stored or returned |
| Retry attempts inside the planner | The retry loop is internal to `getTextualModelOutput` and reports only the final outcome |
| Which sessions exist | Durable Objects are addressed by name, not enumerated, and no run row records its session. The picker shows what this browser has used, nothing more |

### 3. Image output

The generated image from `image_url`, plus the raw `HeliosResult` JSON.

**The raw JSON is always visible.** Any prettified or labelled view is in addition to the raw response body, never instead of it. This is a debugging tool and the exact bytes are the point.

`image_url` comes back as an absolute URL built from the worker's own origin, so it already points at the right host when the two are deployed apart. Use it as-is, do not reassemble it from the base URL field.

### 4. Run history

A table of runs in the current session, from `GET /runs`. Per run: `p_invoc_id`, when, status of each modality, total cost, and a **Resume** button on any run that is resumable.

A run is resumable when its text row is `completed` and its image row is `failed` or absent. You can compute that client-side from the rows, but do not have to be exact: the backend refuses with a 409 and a reason, and showing that reason is a perfectly good outcome.

**History is short by design and this is not a bug.** The Durable Object keeps only the newest `retention_limit` fully completed runs, default 5, and prunes on every invocation. Failed runs are never pruned, so they accumulate. Everything ever run is in D1 permanently, but there is no route that lists D1 and this ticket does not add one.

## How it talks to the backend

Everything is JSON over HTTP against the base URL. There is no auth today.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/` | none | `Helios Agent is running`, plain text. Use it for a connection check |
| `POST` | `/generate` | `{ concept, session_id? }` | `HeliosResult`, 200 |
| `POST` | `/resume` | `{ p_invoc_id, session_id? }` | `HeliosResult` 200, or 409 refusal |
| `GET` | `/runs?session_id=` | none | run rows. **New, see backend work** |
| `GET` | `/images/{key}` | none | the image bytes |

### `POST /generate`

```
{ "concept": "art deco paisley with fine linework", "session_id": "playground" }
```

Costs about **$0.0029** of real money, on localhost exactly as in production. Roughly $0.001 planner plus $0.0019008 image.

```
{
  "p_invoc_id": "…",
  "status": "completed" | "failed",
  "params": { … } | null,
  "image_url": "http://…/images/patterns/{p_invoc_id}.jpg" | null,
  "cost_usd": 0.0019008,          // image only
  "error": "image: …" | null
}
```

`params` is non-null even on a failure, whenever the planner already succeeded. That is the resumable case and the page should show the params it got.

**400** for a bad body, shaped `{ "error": "concept: Too small: …" }`. Never a `p_invoc_id`, because it never became a run.

### `POST /resume`

```
{ "p_invoc_id": "…", "session_id": "playground" }
```

Costs about **$0.0019**. Runs the image half again from the stored params. The planner is never called, so the params come back identical.

Returns a `HeliosResult` with a **new** `p_invoc_id`. The original run is left exactly as it was. Do not overwrite the original row in your UI, show the resume as a separate run linked to it.

**409** with one of six reasons, all human readable:

- no run with that id in this session
- the planner never succeeded, so there are no params to reuse
- this run already has an image, and resuming would charge for a second one
- this run's image is still being generated
- the stored params are no longer valid
- this brief has already been resumed N times, the limit is M

Nothing was written and nothing was billed on any of these.

### `GET /images/{key}`

The key is everything after `/images/`, e.g. `patterns/{p_invoc_id}.jpg`. Returns the bytes with the right content type, or 404. Free.

A plain `<img src>` loads this cross-origin without any CORS involvement. Only fetching it from JavaScript needs the headers.

## Because the two deploy separately

**CORS is done, and your origin has to be on the list.** The worker answers preflight and grants exactly the origins in the `ALLOWED_ORIGINS` var in `wrangler.jsonc`. It ships with `localhost:5173`, `:4173`, `:3000`, `127.0.0.1:5173` and the deployed `https://frontend.aureline.workers.dev`. If your dev server picks a different port, add it there, or every `fetch` fails at preflight with a 403 that names the origin it refused.

**The base URL is configuration, not a constant.** Local dev is `http://localhost:8787`, production is the deployed worker's hostname. Make it a field in the UI as well as a build-time default, so nobody has to rebuild to point at the other one.

**Types come from the workspace, not by hand.** Add `@aureline/shared-types` as a dependency and use `HeliosResult`, `HeliosParams` and `HeliosRequestSchema` from it. It is a build-time import, so separate deployment does not change anything. A hand-copied interface drifts the moment the contract moves, and validating the concept with `HeliosRequestSchema` before submitting means a 400 never costs a round trip.

**No auth, no cookies, no credentials.** Do not send `credentials: "include"`. There is nothing to authenticate against, and it makes the CORS config strictly harder for no benefit.

**Deploy target for the playground** is a static-assets Worker. It is a static build with no server side.

**The worker must be named `frontend`.** Put `"name": "frontend"` in `apps/frontend/wrangler.jsonc`, so it deploys to `https://frontend.aureline.workers.dev`. That exact origin is already in the worker's `ALLOWED_ORIGINS`, so a deploy under any other name is refused at preflight by a backend nobody thought to change. If the name has to move, the allow-list moves with it in the same commit.

## Backend work

Two pieces, both small, both worker code rather than the Frontend Team's.

### `GET /runs`

Read-only, free, and it **must never be able to trigger a model call.**

```
GET /runs?session_id=playground                 -> every run in that DO
GET /runs?session_id=playground&p_invoc_id=abc  -> just that invocation's rows
```

Returns the rows as Drizzle hands them back, so the field names are camelCase (`pInvocId`, `costUsd`, `imageR2Key`, `plannerParams`, `modelMetadata`, `createdAt`, `completedAt`) and the two timestamps serialise as ISO strings. Do not reshape them. The point of this route is to show what is actually stored.

Two gotchas that will otherwise silently route to the wrong place:

- **`scopeKey` returns `"default"` for any non-POST request** (`apps/agent-helios/src/index.ts:51`). It reads `session_id` out of the JSON body, and a GET has none. It needs to read the query string for GET, or `/runs` always hits the `default` Durable Object and reports an empty history for every session.
- **`agent.ts` returns 405 for every non-POST** (`apps/agent-helios/src/agent.ts:26`). It needs a GET branch ahead of that check.

The single-invocation form is `getRunRows(db, pInvocId)`, which already exists. The list form needs one new repository function, because `getSettledRows` excludes `running` rows and has no ordering. One `select` ordered by `createdAt` desc, in `do.repository.ts` with the rest of them. Nothing else may touch storage.

### CORS

Built, in `src/cors.ts`, wired in `src/index.ts` ahead of routing.

`OPTIONS` is answered before any path dispatch, and every response the worker returns carries the headers, not just the three the playground posts to. `/` is a connection check, `/images/*` becomes a `fetch` the moment anyone wants the bytes rather than an `<img>`, and a 404 that fails at CORS instead of reporting itself is a 404 nobody can debug.

The allow-list is `ALLOWED_ORIGINS` in `wrangler.jsonc` vars, exact origins, comma separated, never `*` and deliberately not in KV. There is no auth on `/generate` and it spends real money on every call, so the origin list is the only thing standing between us and any webpage being able to bill our account, which makes it something that should be reviewed rather than editable from a dashboard.

Two behaviours worth knowing:

- **A refused preflight is a 403 naming the origin**, not a silent 204. JavaScript cannot read that body but you can, in the network tab.
- **No credentials, ever.** Do not send `credentials: "include"`. Nothing authenticates, and the worker never answers `Access-Control-Allow-Credentials`.

## Decisions

1. **Stack is the frontend team's choice.** The one constraint is importing `@aureline/shared-types` rather than hand-copying the contract.

2. **Every submit is real money.** Submit disables while in flight, a confirm step names the cost before the first call, and a visible counter tracks calls and dollars spent since page load. `wrangler dev` bills the real account: there is no local simulator for the `AI` binding.

3. **No auto-retry and no polling loop anywhere.** Not on a failed generate, not on a timeout, not on a network error. A retry is a decision a person makes by clicking. This is the same rule as ADR-0009 and ticket 08 decision 1, and it exists because the expensive call usually fails again for the same reason.

4. **Resume gets its own separate confirm**, because it is pure additional spend on a run already paid for.

5. **The scratchpad is reconstructed, not streamed.** Decision 4 in the page section above. If we ever want live progress it means broadcasting state from the Durable Object, which is a pipeline change and a different ticket.

6. **The scratchpad names what it cannot show.** The "not available" table above, verbatim, not silently omitted.

7. **Raw JSON is always visible**, alongside any prettified view.

8. **The reference image is discarded client-side and labelled as such.**

9. **Session id is a visible field**, not a hidden constant, with a randomiser and a picker of ids this browser has used. A run generated under one session cannot be resumed under another, and the page should make that legible rather than surprising.

10. **`GET /runs` is free and read-only forever.** If it ever gains a side effect, that is a bug.

11. **The session picker is `localStorage`, and that is a limitation, not a design.** Sessions cannot be listed from the server: Durable Objects are not enumerable and no run row records which session it came from. If we ever want a real session list it means a column on `helios_runs` and a route over D1, which is its own ticket.

## Work

### Backend, needed before the frontend can call anything

- [x] CORS: preflight plus allow-list from a var. **This blocks everything else** — `src/cors.ts`, allow-list in `ALLOWED_ORIGINS`
- [x] `GET /runs`, both forms, including the `scopeKey` and 405 fixes above — commit `a495098`
- [x] One new repository function for the list form, ordered newest first — `listRuns` in `do.repository.ts`
- [x] Tests for both, using the existing `createTestDb`. No live model call — `src/cors.test.ts`, `src/repository/do.repository.test.ts`

### Frontend

- [x] Branch `feature/09-frontend` cut from `dev` — **Maaz Ahmad**
- [x] `apps/frontend` scaffolded in the workspace, depending on `@aureline/shared-types`, deploying as a worker named `frontend` — **Maaz Ahmad**
- [x] Input region: concept, session id, reference image, base URL — `components/InputPanel.tsx` — **Maaz Ahmad**
- [x] Session id: free text, a randomiser, and a picker of ids from `localStorage`, with switching one reloading the history from that DO — `state/sessions.ts` — **Maaz Ahmad**
- [x] Concept validated with `HeliosRequestSchema` before submitting — `domain/validate.ts` — **Maaz Ahmad**
- [x] `POST /generate` wired, with the spend confirm, the in-flight disable and the running tally — **Maaz Ahmad**
- [x] **`status` drives success or failure, not the HTTP code.** The one that catches the trap at the top — settled once in `domain/outcome.ts` as a three-way `CallOutcome`; nothing downstream ever sees a `Response` — **Maaz Ahmad**
- [x] Image output plus always-visible raw JSON — `components/ImageOutput.tsx` — **Maaz Ahmad**
- [x] Scratchpad built from `GET /runs`, including the real total cost across both rows — `domain/scratchpad.ts` — **Maaz Ahmad**
- [x] Scratchpad shows the "not captured" rows with their reasons — all five from the table above, `domain/notCaptured.ts` — **Maaz Ahmad**
- [x] Run history table from `GET /runs` — `components/RunHistory.tsx` — **Maaz Ahmad**
- [x] Resume wired from the history table, with its own confirm — **Maaz Ahmad**
- [x] A 409 renders as a refusal showing the backend's reason verbatim, not as an error and not as a failed run — **Maaz Ahmad**
- [x] The reference image is discarded and carries its label — **Ali Amir** — *implemented on the frontend branch rather than by Ali. The file is held inside `InputPanel` and never lifted into app state, so it has nowhere to be sent from; the label is permanent, not conditional on a file being picked.*
- [x] Raw `HeliosResult` and the image both render — **Ali Amir** — *implemented on the frontend branch rather than by Ali. The raw body is kept as the string from `response.text()` and rendered unmodified; `image_url` is used as-is rather than rebuilt. Both covered by `components/ImageOutput.test.tsx`.*

### Review gates

**Left open deliberately. Everything below has been exercised at least partly, and the evidence is recorded here so a reviewer can check rather than repeat — but no gate is ticked by the person who wrote the code.**

- [ ] One real `POST /generate` through the page, about $0.0029, and the scratchpad's numbers checked against the stored rows rather than assumed — **TBD**
  - **Partly done.** Session `test-plain-cinder-b210`. The generate itself **failed** — `c6e43fb4-cd45-4b2e-a721-6ec5a011ef73`, $0.001274, killed at the image stage by a production KV bug (see below). A later resume produced a real image, so the happy path is proven, but **no successful `POST /generate` has completed through the page**. That is what is still owed.
  - The cost arithmetic **was** checked against `GET /runs` rather than assumed: planner $0.001274, image null, real total $0.001274 on the failed run; planner null, image $0.0019008, real total $0.0019008 on the resume. The response's `cost_usd` matched the image row alone in both.

- [ ] One forced failure and one resume through the page, showing a failed run renders as failed and a second resume renders the 409 reason — **TBD**
  - **Failure: done.** `c6e43fb4…` rendered as `failed` on an HTTP 200, with non-null `params`, a `completed` text row beside a `failed` image row, and a Resume offered. The trap at the top of this ticket is caught.
  - **Resume: done, twice.** `849778fa…` and `0714644d…`, both new `p_invoc_id`s with `root`/`resumed_from` pointing at the original, both `attempt 2` (siblings, not a chain), original left untouched.
  - **409: not seen on screen.** No refusal has been rendered live. It is covered by tests at both the classifier and the render level (`domain/outcome.test.ts`, `components/ImageOutput.test.tsx`), but that is not the same as watching it. The reachable route is the resume cap: 2 of 3 attempts are used on `c6e43fb4…`, so one more resume (~$0.0019) makes the next one a free refusal.

- [ ] Nobody ticks a gate on their own work. Tickets 03 and 07 both had gates ticked by their implementer and both got unticked at review — **both**

### Found while testing, not this ticket's work

**Production image generation was broken** and every `POST /generate` failed with `5006: Additional or unevaluated properties '/width, /height' at '/' not allowed`. The `image_model` key in the `HELIOS_CONFIG` KV namespace carried `width` and `height`, which `@cf/black-forest-labs/flux-1-schnell` does not accept, and `imageGenerator.ts:68-69` forwards whatever config defines. Patched in KV; **the code guard is still missing.** `resolveSteps` clamps `steps` for exactly this reason and the dimensions have no equivalent, so the next dashboard edit re-breaks it. Belongs to `agent-helios`, ticket 06 territory.

## Verification without burning budget

The whole ticket needs about **$0.005** if you sequence it properly.

**Build against a failure first, it is nearly free.** Break the image model in local KV and every `POST /generate` costs one planner call, about $0.001, instead of $0.0029. It also gives you exactly the shapes hardest to get right: a 200 carrying `status: "failed"`, non-null `params`, a `completed` text row next to a `failed` image row, and a run the history table should offer a Resume button on.

```
npm run kv:put -- image_model "@cf/does/not-exist"
npm run kv:get -- image_model
```

**Use `npm run kv:put` and `kv:get`, never bare `wrangler`.** Run from the repo root there is no `wrangler.jsonc`, so a bare command silently leaves this app's KV untouched and your next request is a full billed success instead of the failure you wanted. This has already cost real money once, which is why the scripts exist.

Then restore with `npm run config:pull`, do one real generate to prove the image and the happy path, and one resume off the earlier failure to prove that flow. That is one planner call plus two image calls.

**`GET /runs` is free**, so build and iterate the scratchpad and the history table against runs that already exist. You only need to spend once to have data to work with.

## Two things that will waste your afternoon

**The image field being ignored looks exactly like a bug.** Label it. Every person testing this page will otherwise upload something, see it have no effect, and report it.

**A green page against mocked JSON proves nothing about this API.** The three traps at the top are all shapes a hand-written mock will get wrong, because they are all cases where this API does not do the conventional thing. Point it at a real `wrangler dev` early.
