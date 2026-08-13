# Stack and contract

Reference. What the engine is built out of, which exact object does each job, and what it promises over the wire. [architecture.md](architecture.md) is the prose version of the first half.

Examples are from `apps/agent-helios`.

## One job, one object

| The job | The object | Why this one |
|---|---|---|
| Receive HTTP | Cloudflare Worker `fetch` handler, `src/index.ts` | The edge entry point. Does routing and nothing else |
| Hold session state | Durable Object via the `agents` SDK `Agent` class | The only Cloudflare primitive with a stable identity and private storage |
| Store session data | DO local SQLite, through `ctx.storage` | Lives inside the object, no network hop, private to one session |
| Store the permanent record | D1, binding `DB` | Queryable across sessions, which DO SQLite is not |
| Store image bytes | R2, binding `PATTERNS` | Large binaries do not belong in a row |
| Hold tunable config | Workers KV, binding `CONFIG` | Editable from the dashboard, no deploy needed |
| Call models | Workers AI, binding `AI` | Same account, no API key to manage |
| Route and price model calls | AI Gateway, id from `AI_GATEWAY_ID` | The only source that reports real dollars |
| Define and validate shapes | Zod 4 | One definition serves three jobs, see below |
| Talk to both databases | Drizzle ORM 0.45 | One schema compiles to both SQLite targets |
| Generate migrations | drizzle-kit, two configs | DO SQLite and D1 need different output |
| Test | Vitest 4 with `node:sqlite` | Real SQLite in tests, no native module to build |
| Build and deploy | Wrangler 4 | No bundler config, no CI yet |

**Zod's three jobs** are worth spelling out, because it is why there are no hand written interfaces for the wire types. One `HeliosParamsSchema` gives you the compile time TypeScript type through `z.infer`, the runtime check in the pipeline's validate stage, and the JSON schema handed to the planner model for structured output. Three hand written definitions would drift apart within a sprint.

## Versions

| What | Version | Why it matters |
|---|---|---|
| Node | 24 or newer | Tests use `node:sqlite`, stable from 24. Declared in the root `engines` field |
| `agents` SDK | 0.19 | Provides the `Agent` base class, `getAgentByName`, `routeAgentRequest` |
| Drizzle ORM | 0.45 | Two drivers in use: `durable-sqlite` and `d1` |
| Zod | 4 | `z.toJSONSchema` is a 4 only API and the planner depends on it |
| Vitest | 4 | No config file anywhere, defaults only |
| Wrangler | 4 | Requires Node 20 or newer independently |
| TypeScript | 5 in the app | The repo root resolves TypeScript 7, which rejects this app's `"moduleResolution": "node"` with TS5108 |

That last row is a real wart, not something you broke. **Run `npx tsc --noEmit` from inside `apps/agent-helios`, never from the repo root.**

The monorepo is plain npm workspaces (`apps/*` and `packages/*`). No Turborepo, no Nx, no `tsconfig.base.json`, and no `.github/` workflows. Packages are consumed as workspace symlinks with no build step: `main` and `types` point straight at `src/index.ts`.

## Bindings

All declared in `apps/agent-helios/wrangler.jsonc`.

| Binding | Kind | Points at | Under `wrangler dev` |
|---|---|---|---|
| `HeliosAgent` | Durable Object | class `HeliosAgent`, migration tag `v1`, `new_sqlite_classes` | Simulated in `.wrangler/state/` |
| `AI` | Workers AI | The account's Workers AI | **Calls the real API. Every call bills.** |
| `DB` | D1 | `helios-d1` | Simulated locally |
| `PATTERNS` | R2 | `helios-bucket` | Simulated locally |
| `CONFIG` | KV | namespace titled `HELIOS_CONFIG` | Simulated locally, and empty on a fresh clone |

Plus `compatibility_date: "2026-07-27"`, `compatibility_flags: ["nodejs_compat"]`, observability on, and source maps uploaded.

Three things about this file that cost people time:

- **`main` is `src/index.ts` but the class lives in `src/agent.ts`.** Wrangler resolves `class_name` through the main module, so `index.ts` must keep re-exporting `HeliosAgent`. Delete that one line and the binding breaks at deploy time, not at typecheck time.
- **KV has one namespace and no `preview_id`, deliberately.** A second store meant the same key existed twice, looked identical in the dashboard, and a value edited in the wrong one silently did nothing. The trade is that there is no staging tier for config, which is survivable only because a bad value always falls back rather than failing.
- **The ids in this file are identifiers, not credentials**, and are safe to commit. Anything that is actually a secret goes in `.dev.vars` locally and `wrangler secret put` for deploy, never in `vars`.

`wrangler types` types each var as its **literal** value rather than as `string`. Change `PLANNER_MODEL` in `wrangler.jsonc` and you must re-run `npm run cf-typegen` or TypeScript rejects the new value.

## Routes

| Method and path | What it does | Body |
|---|---|---|
| `GET /` | Liveness. Returns the string `Helios Agent is running` | none |
| `POST /generate` | Runs the full pipeline | `HeliosRequest` |
| `POST /resume` | Runs only the image half of an existing invocation | `HeliosResumeRequest` |
| `GET /images/*` | Streams an image from R2. Everything after `/images/` is the key | none |
| `POST /agents/helios-agent/<instance>` | The Agents SDK's own convention, same handler | `HeliosRequest` |
| anything else | 404 | |

The SDK's agent name is **kebab-cased**. `/agents/helios-agent/default` works, `/agents/HeliosAgent/default` does not.

`/generate` and `/resume` exist so callers do not need to know the SDK's URL convention. Both resolve `session_id` to a Durable Object and forward there. `/resume` uses the same rule on purpose: a run can only be resumed from the object holding it, so it has to land where its `/generate` did.

## Status codes

The split is between a **transport error** and a **run outcome**, and it is the thing people get wrong most often.

| Code | Body | Means |
|---|---|---|
| 200 | `HeliosResult` | An invocation happened and settled. **Including a failed one** |
| 400 | `{ "error": "..." }` | The request body did not validate. No invocation, nothing billed |
| 404 | `Not found` | Unknown path, or an image key with no object |
| 405 | `{ "error": "POST required" }` | Right path, wrong method |
| 409 | `{ "error": "..." }` | A resume was refused before doing anything. Nothing written, nothing billed |

**A failed run is a 200 carrying `"status": "failed"`.** The HTTP request succeeded even though the run did not, and the response is a full `HeliosResult` with the failing stage prefixed onto `error`: `planner:`, `validate:` or `image:`. There is a real `p_invoc_id` and there may be a real `cost_usd`, because the money can leave the account before the failure happens.

A 4xx has no `p_invoc_id`, because there was never an invocation to name.

`runPipeline` and `resumeRun` **never throw**. Every path returns a settled result, so the HTTP layer only has to deal with outcomes.

## Wire schemas

All in `packages/shared-types/src/v1/messages.ts`.

### `HeliosRequest`

```ts
{
  concept: string      // 1 to 1000 chars, trimmed
  session_id?: string  // 1 to 128 chars, picks the Durable Object
}
```

`session_id` is **not** the invocation's identity. One object accumulates many invocations, each with its own `p_invoc_id`. Omit it and you land on the shared object named `default`.

### `HeliosResumeRequest`

```ts
{
  p_invoc_id: string   // 1 to 128 chars, the run to resume
  session_id?: string  // same meaning as above
}
```

The resumed run gets a **new** `p_invoc_id`. This one is never reused.

### `HeliosParams`

The planner's output and the image stage's input. Eight fields, six of them closed enums.

| Field | Values |
|---|---|
| `motif_type` | free-form, non-empty |
| `repeat_type` | `block`, `half-drop`, `brick`, `mirror`, `toss` |
| `scale` | `small`, `medium`, `large` |
| `density` | `sparse`, `balanced`, `dense` |
| `line_weight` | `fine`, `medium`, `bold` |
| `texture_technique` | `flat`, `hatching`, `cross-hatching`, `stippling`, `solid-fill` |
| `contrast_level` | `high`, `medium`, `low` |
| `style` | free-form, non-empty |

`motif_type` and `style` are free-form because the textile vocabulary defines no closed set for them. The other six use the domain's canonical values verbatim, which is what lets the planner be given them as an enum and the image prompt map them to fixed phrases.

**There is no colour field**, and there will not be one. See [ADR-0002](adr/0002-helios-outputs-black-and-white-patterns-only.md).

This eight field list is a starting point pending validation against real textile test prompts.

### `HeliosResult`

```ts
{
  p_invoc_id: string
  status: "running" | "completed" | "failed"
  params: HeliosParams | null
  image_url: string | null
  cost_usd: number | null
  error: string | null       // "<stage>: <message>" when failed
}
```

`status` is shared with the audit table. The pipeline is synchronous, so `running` only ever exists as a persisted mid-invocation state. **A response never carries it.**

`params` is kept on a failure if the planner already produced valid ones, because partial state is more useful than none and it is what makes the run resumable.

## Runtime config

Five keys in the `CONFIG` KV namespace, each with a committed fallback in `wrangler.jsonc`. Owned by `src/config.ts`.

| KV key | Fallback var | Validation | Controls |
|---|---|---|---|
| `text_model` | `PLANNER_MODEL` | object or bare model id | Which planner model, and its temperature |
| `image_model` | `IMAGE_MODEL` | object or bare model id | Which image model, plus width, height, steps |
| `max_retries` | `MAX_RETRIES` | integer 1 to 5 | Planner attempts before giving up |
| `retention_limit` | `RETENTION_LIMIT` | integer 1 to 100 | Completed runs kept per Durable Object |
| `max_resume_attempts` | `MAX_RESUME_ATTEMPTS` | integer 1 to 20 | Times one brief may be retried |

The model keys accept **either** a JSON object or a bare model id, because the dashboard is hand-edited and a bare id is the obvious thing to type. Anything not starting with `{` is treated as the model id. Unknown fields inside the object are stripped rather than rejected, so adding a field in the dashboard ahead of the code that reads it is ignored instead of invalidating the whole value.

`max_resume_attempts` is capped at 20 rather than left open because it is the number of times one concept may spend the image model. A fat-fingered dashboard edit should not be able to authorise an unbounded bill.

**Adding a tunable is one entry.** `config.ts` is built around a `FIELDS` table with one row per key holding how to prepare the raw text, how to validate it, what to fall back to, and how to render it in the log line. `resolveConfig` and `describeConfig` both just walk that table, so a new row is the whole change.

**`AI_GATEWAY_ID` is deliberately not in KV.** An empty or misspelled gateway id makes the call fall through to direct Workers AI with no error and no log, so a dashboard typo would be a silent routing outage rather than a visible failure. It stays a committed var.

Every invocation logs one line naming every value and where it came from:

```
config: text_model=@cf/openai/gpt-oss-120b (var) image_model=@cf/black-forest-labs/flux-1-schnell (var) max_retries=2 (var) retention_limit=5 (var) max_resume_attempts=3 (var)
```

A fresh clone reads `(var)` five times, because the local KV store starts empty. That is correct, not a failure. It is what the fallbacks are for.

## Models

| Stage | Model | Notes |
|---|---|---|
| Planner | `@cf/openai/gpt-oss-120b` | Chat Completions shape, structured output, retries |
| Image | `@cf/black-forest-labs/flux-1-schnell` | One call, no retry, gateway cache skipped |

Two constraints Flux Schnell imposes that the code works around: **steps are capped at 8**, so `resolveSteps()` clamps whatever config holds and the row records what was actually sent rather than what was configured. And **there is no negative prompt**, so exclusions are folded into the prompt text as a `Do not include:` clause. The prompt is rejected before any billed call if it exceeds 2048 characters.

The gateway cache is explicitly skipped for images. It caches replies for an hour and there is no seed to vary the key, so two identical briefs would otherwise return the same picture.

Flux Schnell is a Sprint 1 substitution for Flux 1.1 Pro, driven by billing rather than quality. [ADR-0004](adr/0004-sprint-1-uses-flux-schnell-not-flux-1-1-pro.md).

**The request shape is Chat Completions, not the Responses API.** Responses works but reports zero tokens and zero neurons on a billed call, which makes cost untrackable. [ADR-0007](adr/0007-responses-api-only-for-structured-output.md) records the decision and its reversal.

## What things cost

Real figures from live runs, useful when deciding whether to press enter.

| Call | Cost |
|---|---|
| Planner, one attempt | about $0.001 |
| Image, one call | about $0.0019 |
| `POST /generate`, success | about $0.0029 |
| `POST /resume` | about $0.0019 |

Everything else is free: `GET /`, every 4xx, every 409 refusal, `GET /images/*`, and the whole test suite.

## Tests

101 tests across 8 files, colocated with the code as `*.test.ts`, run with `npm test` from the repo root.

| Workspace | Covers |
|---|---|
| `apps/agent-helios` | 67 tests. Config resolution, repository queries and pruning, the pipeline end to end, resume including every refusal, image generation |
| `packages/shared-utils` | 34 tests. Envelope unwrapping, retry behaviour, gateway option building, image decoding |

**No test makes a model call**, so the suite is free to run as often as you like. Database tests use real in-memory SQLite through Node's `node:sqlite`, driven by Drizzle's `sqlite-proxy` driver, so they exercise real SQL rather than a mock.

Two gaps worth knowing. There is no Worker-boundary harness (`@cloudflare/vitest-pool-workers`) yet, which would let a test send a real request and assert on both the result and the persisted rows. And `tests/` at the repo root is **not** the suite: it holds scratch harnesses like `run-concept.ts` for eyeballing prompt output by hand. AI evaluation material belongs in `tests/evals/`, which does not exist yet, kept separate because evals measure whether the model output is good, not whether the code is correct.

## Deployment

Each folder under `apps/` is a standalone Workers project with its own `wrangler.jsonc`. Cloudflare's Git integration supports build watch paths, so a push touching `apps/agent-helios/**` could deploy only that engine while a push touching `packages/**` deploys everything depending on it.

None of that is configured yet, and with one app there is no meaningful distinction. **Deploys are manual today**: `npm run deploy` from inside the app directory, which runs `wrangler deploy`. There are no CI workflows.
