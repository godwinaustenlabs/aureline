# Aureline — Autonomous Textile Design Intelligence Platform

## 1. What this project is

Aureline is an AI platform that turns a textile design concept (a text description like "art deco paisley with fine linework") into a production-ready design. The current build phase covers exactly one deployable component: **agent-helios**, a Cloudflare Worker that runs a two-model pipeline — a high-creativity text/planner model that distills a design concept into structured pattern parameters, and a low-creativity image model that renders those parameters faithfully.

Helios produces **black-and-white patterns only**. It has no color parameter of any kind: color is entirely the responsibility of Iris, the future Chromatic Engine (see `docs/adr/0002-*`).

Everything beyond Helios (orchestration, API gateway) is intentionally deferred and documented below.

## 2. Repo layout

```
aureline/
├── apps/                  Independently deployable Cloudflare Workers
│   └── agent-helios/      The one worker that exists today
├── packages/              Shared, non-deployable code (workspace-linked)
│   ├── shared-types/      Zod schemas + inferred types shared across apps
│   └── shared-utils/      Model-calling helpers (text, image, AI Gateway)
├── infrastructure/        Cloudflare resource definitions
│   └── d1/                migrations/ not created yet — see §8
├── docs/                  Architecture notes, research, and ADRs
│   ├── adr/               Architecture Decision Records (0001–0008)
│   ├── prompts/           Prompt structure and research notes
│   └── agents/            Conventions for AI agents working in this repo
├── tests/                 Scratch harnesses (not the test suite — see §5)
├── CONTEXT.md             Domain vocabulary (pattern terms, pipeline terms)
├── CLAUDE.md              Entry point for AI agents working in this repo
├── package.json           npm-workspaces root (apps/*, packages/*)
├── LICENSE                Apache 2.0
└── README.md              This file
```

`.scratch/` holds sprint specs and tickets as markdown (see `docs/agents/issue-tracker.md`). No `tsconfig.base.json`, `turbo.json`, or `.github` directory exists. Those may be added later if a build tool like Turborepo or a CI workflow is introduced.

**Read the ADRs before changing architecture.** `agent-helios` is the literal template for every future engine (Iris, Atlas, Orpheus, Arachne, Vulcan), so several decisions recorded there apply repo-wide rather than to Helios alone.

## 3. apps/agent-helios

**What it does.** Accepts an HTTP request carrying a design concept and runs it through the fixed-order pipeline: planner → validate → image generator. The planner is a **real model call** (GPT-OSS-120B through AI Gateway) and its result is persisted; the image stage is still a stub returning a placeholder URL.

**This matters for local dev: `POST /generate` bills real Workers AI quota, even on localhost.** See §8.

### Module shape

This structure is deliberate and is the template all future engines copy. The guiding principle is *fewer files, less indirection* — `agent.ts` is its own controller, with no separate controller layer.

| File | Responsibility |
|---|---|
| `src/index.ts` | Routing only — no request handling or orchestration |
| `src/agent.ts` | `HeliosAgent` class; request validation directly in `onRequest` |
| `src/services/pipeline.ts` | Fixed-order orchestrator (planner → validate → image) |
| `src/services/planner.ts` | Textual planner model call — real |
| `src/services/imageGenerator.ts` | Image model call — **stub** |
| `src/config.ts` | Resolves runtime config from KV, with wrangler vars as fallback |
| `src/utils.ts` | Error-message formatting and neuron-cost extraction |
| `src/tools.ts` | Thin call site for the planner's structured-output request |
| `src/prompts/` | Planner system/user prompts and the image-prompt translator |
| `src/repository/` | `do.repository.ts` (DO-local writes), `d1.repository.ts` and `r2.repository.ts` (empty) |
| `src/db/schema.ts` | The `helios_runs` table definition (Drizzle) |

### Routes

| Route | Behaviour |
|---|---|
| `GET /` | Health check — returns `Helios Agent is running` |
| `POST /generate` | Runs the pipeline. Body: `{ "concept": string, "session_id"?: string }` |
| `POST /agents/helios-agent/<instance>` | The Agents SDK's own convention — same handler, reached via `routeAgentRequest`. The agent name is **kebab-cased** (`helios-agent`, not `HeliosAgent`) |
| anything else | 404 |

`/generate` exists so callers don't need to know the SDK's URL convention. It resolves `session_id` (defaulting to `"default"`) to a Durable Object instance and forwards the request there.

### Durable Object scoping

A `HeliosAgent` instance is scoped to a **session/project**, not to a single pipeline invocation, and not to one global singleton (see `docs/adr/0005-*`). One instance accumulates many invocations over time, which is what makes the planned 5-run retention rule meaningful.

Each pipeline invocation gets its own `p_invoc_id` — a UUID minted per invocation in `pipeline.ts`. It is **not** derived from any Durable Object identifier. Two requests to the same `session_id` land on the same DO but get different `p_invoc_id`s.

### How Agents SDK / Durable Objects works here

Cloudflare's `agents` library (v0.19) wraps Durable Objects so each agent instance is a Durable Object with SQLite storage, HTTP routing, and WebSocket support built in. The worker's `fetch` handler resolves an instance with `getAgentByName` (for `/generate`) or delegates to `routeAgentRequest` (for the SDK's own paths); either way the request reaches the matching Durable Object's `onRequest` method.

The SDK manages its own internal tables (`cf_agents_*`, `__cf_*`) in the same DO SQLite database that application tables will live in. All application tables are therefore prefixed `helios_` — and every future engine prefixes with its own name (`iris_*`, `atlas_*`). See `docs/adr/0003-*`.

### What's implemented vs. stubbed

| Artifact | Status |
|---|---|
| `HeliosRequest` / `HeliosParams` / `HeliosResult` contract | **Done** — Zod schemas in `shared-types` |
| `index.ts` routing-only split, `agent.ts`, request validation | **Done** |
| `services/pipeline.ts` fixed-order orchestration + failure handling | **Done** |
| Textual planner model call (GPT-OSS-120B via AI Gateway) | **Done** — structured output, real token and neuron counts |
| `helios_runs` table, DO-local persistence | **Done** |
| Planner prompts, image-prompt translator | **Done** |
| Runtime config from KV | **Done** — see below |
| Image model call (Flux Schnell via Workers AI) | Stub — returns a placeholder URL |
| D1 export, R2 image storage, retention pruning | Not started |

### Error contract

The split is between *transport errors* and *pipeline outcomes*:

- **4xx with `{ "error": "..." }`** — the request never became a pipeline invocation, so there is no `p_invoc_id` to report. Covers a non-`POST` method (405) and a missing/blank/oversized `concept` (400).
- **200 with `"status": "failed"`** — an invocation *did* start and a stage failed. The response is a full `HeliosResult`; `error` is prefixed with the failing stage (`planner:`, `validate:`, or `image:`).

`runPipeline` never throws. Every path returns a `HeliosResult`.

### wrangler.jsonc bindings

| Binding | What it is | Behaviour under `wrangler dev` |
|---|---|---|
| `HeliosAgent` | Durable Object with SQLite storage | Simulated locally in `.wrangler/state/` |
| `AI` | Workers AI | **Always calls the real Cloudflare API.** There is no local simulator, so every call bills quota |
| `CONFIG` | KV namespace for runtime config | Simulated locally, and **empty on a fresh clone** — see below |
| `DB` | D1 database `helios-d1` | Simulated locally |
| `PATTERNS` | R2 bucket `helios-bucket` | Simulated locally, unused until the image stage is real |

- `durable_objects.bindings[0]` maps the JS class `HeliosAgent` to a binding named `HeliosAgent` so the worker can look up and call agent instances by name.
- `migrations[0]` tells Cloudflare to create SQLite storage for the `HeliosAgent` class when first deployed.
- `nodejs_compat` enables Node.js API shims (`Buffer`, `process`, etc.) inside the Workers runtime.

Note that `main` is `src/index.ts` while the class lives in `src/agent.ts`. Wrangler resolves `class_name` through the main module, so **`index.ts` must keep re-exporting `HeliosAgent`** — removing that line breaks the binding at deploy time, not at typecheck time.

The account, database and KV ids committed in `wrangler.jsonc` are identifiers, not credentials, and are safe in the repo. Anything that is a secret goes in `.dev.vars` locally and `wrangler secret put` for deploy, never in `vars`.

### Runtime config (KV)

Four values are read from the `CONFIG` KV namespace at request time rather than baked in at deploy time, so they can be changed from the Cloudflare dashboard without a redeploy. `src/config.ts` owns this, and ADR-0008 records why.

| KV key | Fallback var in `wrangler.jsonc` | Validation |
|---|---|---|
| `text_model` | `PLANNER_MODEL` | non-empty string |
| `image_model` | `IMAGE_MODEL` | non-empty string |
| `max_retries` | `MAX_RETRIES` | integer 1–5 |
| `retention_limit` | `RETENTION_LIMIT` | integer 1–100 |

KV holds the live value; the vars are the committed fallback. A missing key, an invalid value, or KV being unavailable falls back to the var and logs a warning — a dashboard typo can never take the service down. `runPipeline` resolves this once per invocation and logs one line naming every value and where it came from:

```
config: text_model=@cf/openai/gpt-oss-120b (var) image_model=@cf/black-forest-labs/flux-1-schnell (var) max_retries=2 (var) retention_limit=5 (var)
```

`AI_GATEWAY_ID` is deliberately **not** in KV. An empty or misspelled gateway id makes the call fall through to direct Workers AI with no error and no gateway log, so a dashboard typo would be a silent routing outage.

#### One namespace, and how local dev relates to it

There is exactly **one** KV namespace, titled `HELIOS_CONFIG` in the Cloudflare dashboard and bound in code as `CONFIG`. There is no preview namespace: a second store meant the same key existed twice, looked identical in the dashboard, and a value edited in the wrong one silently did nothing.

| How you run it | Store used |
|---|---|
| `wrangler dev` (default) | A local simulated store in `apps/agent-helios/.wrangler/state/v3/kv/` |
| `wrangler dev` with `remote` enabled on the binding | `HELIOS_CONFIG`, the real one |
| `wrangler deploy` | `HELIOS_CONFIG`, the real one |

A fresh clone has an empty local store, so on localhost all four values resolve from the vars and the log line reads `(var)` four times. That is correct, not a failure — it is what the fallbacks are for.

**To read the real namespace from local dev**, uncomment one line in `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "CONFIG", "id": "bc982c0d712a49b4827520477c33fab5", "remote": true }
]
```

That sends **only** this binding to the live namespace. The Durable Object, D1 and R2 stay local and simulated, and live reload still works. It needs network access and an authenticated wrangler for every dev run, which is why it ships commented out rather than on — flip it for a session, then flip it back. `npx wrangler dev --local` overrides it without editing the file.

**The trade to be aware of:** with no preview namespace, local dev in remote mode and production read the same store. There is no staging tier for config. A wrong value in the dashboard is wrong everywhere at once, and `npx wrangler kv key put --binding CONFIG --remote ...` from your terminal edits production. The safety net is that a bad value only ever produces a warning and a fallback to the var, never an outage.

**To copy the real values into your local store** instead, so you can work offline against a realistic config:

```bash
cd apps/agent-helios
for k in text_model image_model max_retries retention_limit; do
  v=$(npx wrangler kv key get --binding CONFIG --remote "$k" 2>/dev/null) \
    && npx wrangler kv key put --binding CONFIG --local "$k" "$v"
done
```

Because the binding now has a single id, the `kv key` commands no longer need `--preview` to disambiguate. `--remote` and `--local` are the only distinction.

## 4. packages/

Two packages exist. Both are declared in the root `package.json` workspaces and are resolved as symlinks under `node_modules/@aureline/*`.

### `@aureline/shared-types`

Defines the contract between Helios and its eventual callers. Single source of truth so the playground, Athena (future), and Helios all agree on request/response shapes.

Zod schemas are the source of truth; TypeScript types are inferred from them with `z.infer`. One definition therefore serves three jobs: the compile-time type, the pipeline's runtime `validate` stage, and (once ticket 05 lands) the JSON schema handed to the planner model for structured output. Hand-written interfaces would have meant three definitions drifting apart.

```ts
// packages/shared-types/src/v1/messages.ts  (abridged)
export const HeliosParamsSchema = z.object({
  motif_type: z.string().trim().min(1),          // free-form
  repeat_type: z.enum(["block", "half-drop", "brick", "mirror", "toss"]),
  scale: z.enum(["small", "medium", "large"]),
  density: z.enum(["sparse", "balanced", "dense"]),
  line_weight: z.enum(["fine", "medium", "bold"]),
  texture_technique: z.enum(["flat", "hatching", "cross-hatching", "stippling", "solid-fill"]),
  contrast_level: z.enum(["high", "medium", "low"]),
  style: z.string().trim().min(1),               // free-form
});

export const HeliosRequestSchema = z.object({
  concept: z.string().trim().min(1).max(1000),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export interface HeliosResult {
  p_invoc_id: string;
  status: "running" | "completed" | "failed";
  params: HeliosParams | null;
  image_url: string | null;
  cost_usd: number | null;
  error: string | null;
}
```

Every term is defined in `CONTEXT.md`. Fields with a settled domain vocabulary are closed enums; `motif_type` and `style` stay free-form because the domain defines no closed set for them. There is no color field — see §1.

`status` is shared with the future `helios_runs` audit table. The pipeline is synchronous, so `running` only ever exists as a persisted mid-invocation state; an HTTP response always carries a settled status.

This 8-field list is a Sprint 1 starting point, pending validation against real textile-vocabulary test prompts.

### `@aureline/shared-utils`

The model-calling layer every future engine reuses. Three modules:

| Module | What it does |
|---|---|
| `getTextualModelOutput` | Sends a Zod schema to a text model as a JSON schema, opens the reply envelope, validates, retries on schema drift, and returns `{ data, usage, model }` |
| `getImageModelOutput` | Calls an image model and decodes the base64 reply to bytes |
| `aiGateway` | Builds `ai.run`'s third argument from a gateway config (ADR-0006) |

Two things here are easy to get wrong and are worth knowing before touching it. The request shape is **Chat Completions**, not the Responses API — the Responses shape works but reports zero tokens and zero neurons on a billed call, so cost cannot be tracked (ADR-0007). And `buildAiRunOptions` returns `undefined` when the gateway id is empty, so a missing `AI_GATEWAY_ID` degrades to a direct Workers AI call with no error and no log entry; `planner.ts` warns when `env.AI.aiGatewayLogId` is null after a call, which is the only signal that this happened.

### Why shared rather than duplicated per-app

Workspace packages are symlinked at install time. A change to `shared-types` is instantly visible to every app that depends on it, without any publish step. When Helios is the only consumer there's little benefit, but once a playground, api-gateway, or Athena arrives, duplicating these interfaces across apps would create drift.

## 5. Tests

Tests live next to the code they cover, as `*.test.ts`, and run with Vitest. `npm test` from the repo root runs every workspace:

```bash
npm test          # 43 tests across agent-helios and shared-utils
```

Every test uses fakes. **No test makes a model call**, so the suite is free to run as often as you like.

| Workspace | Covers |
|---|---|
| `packages/shared-utils` | Response-envelope unwrapping, retry behaviour, gateway option building, image decoding |
| `apps/agent-helios` | `src/config.ts` — KV resolution, per-field fallback, validation, KV outage |

The root `package.json` still sets `"directories": { "test": "tests" }`, but `tests/` is **not** the suite — it holds scratch harnesses like `run-concept.ts` for eyeballing prompt output by hand.

A Worker-boundary harness (`@cloudflare/vitest-pool-workers`) — a request in, a `HeliosResult` and the matching persisted rows out, with only the AI binding stubbed — is not set up yet and is the obvious next gap. AI-evaluation material (test prompts, scorecards) belongs in `tests/evals/`, kept distinct from unit tests: evals measure whether the model output is good, not whether the code is correct.

AI-evaluation material (test prompts, scorecards, expected outputs for tuning Helios's models) belongs in `tests/evals/`, kept distinct from unit/integration tests. Evals are qualitative — they measure whether the model output is good, not whether the code is correct — and usually involve manual review or batch scoring rather than `assert` statements.

## 6. Deployment model

Each folder under `apps/` is a standalone Cloudflare Workers project with its own `wrangler.jsonc`. Cloudflare's Git integration (Workers & Pages → your repo → "build watch paths") can be configured so that:

- A push changing `apps/agent-helios/**` triggers a deploy of **only** `agent-helios`.
- A push changing `packages/shared-types/**` triggers a deploy of **every** app whose watch path includes that package.

Today there is exactly **one** app (`agent-helios`), so there isn't a meaningful distinction yet. The pattern matters once a second app appears.

No CI workflows (`.github/workflows/`) exist yet. Deployments must be run manually with `npm run deploy` inside the app directory, which calls `wrangler deploy`.

## 7. Deliberately not here yet

### api-gateway

An HTTP gateway that authenticates requests, rate-limits, and routes them to the correct agent. It is not built because there is nothing to route — Helios is the only agent, and directly exposing `wrangler dev` on port 8787 is sufficient. The api-gateway will be built as a separate app under `apps/api-gateway` as soon as there is a second consumer of Helios (a web UI, an integration partner, etc.) that justifies the indirection.

### agent-orchestrator (Athena)

An orchestrator agent that decomposes complex design briefs into sub-tasks and delegates them to specialist agents (Helios for patterns, Iris for color, others for material selection, etc.). It is not built because there are no specialist agents to orchestrate. Work on Athena will start once Helios's two-model pipeline is producing reliable results and there is a concrete need to chain agents together.

When Athena does arrive, it passes its design-session id through as `session_id`, and each engine's Durable Object accumulates that session's history. Nothing about the addressing model has to change.

## 8. How to run it locally

### Prerequisites

- **Node.js ≥ 20.** Wrangler 4 requires it. Developed on 24.16.0.
- **An authenticated Cloudflare account** with access to this project's account. Run `npx wrangler login` if `npx wrangler whoami` does not name it.

Authentication is **not** optional for local dev any more, even though everything else is simulated. The `AI` binding has no local simulator, so `wrangler dev` proxies model calls to the real Workers AI API using your credentials.

### Setup, from a fresh clone

```bash
npm install                                   # from the repo root, installs every workspace
npm test                                      # 43 tests, no model calls, should be green
cd apps/agent-helios && npx tsc --noEmit      # typecheck
npm run dev                                   # http://localhost:8787
```

That is the whole setup. There is nothing to provision, no `.dev.vars` to create, and no migration to run by hand.

Four things that would otherwise cost you time:

- **Run `npx tsc --noEmit` from inside `apps/agent-helios`, not the repo root.** At the root, `npx` resolves TypeScript 7, which rejects this project's `"moduleResolution": "node"` with TS5108. The workspace-local TypeScript 5.9 is the one that matters. This is a known wart, not something you broke.
- **`.dev.vars` is not needed today.** `apps/agent-helios/.dev.vars.example` exists and is deliberately empty of keys — it documents *why* no secret is required (the AI Gateway is called through the AI binding, which is pre-authenticated by the account). Copy it to `.dev.vars` only when a ticket adds an actual secret.
- **DO SQLite migrations apply themselves.** `onStart` runs the Drizzle migrations in `apps/agent-helios/drizzle/` on every Durable Object wake-up, and Drizzle tracks what is already applied. After editing `src/db/schema.ts`, run `npm run db:generate` to produce a new migration file.
- **`infrastructure/d1/migrations/` does not exist yet.** `wrangler.jsonc` points at it, and the D1 table has not been created. Nothing in the current code path reads or writes D1, so this does not block local dev.

### The one thing that costs money

**`POST /generate` makes a real, billed Workers AI call**, on localhost exactly as in production. The planner stage is no longer a stub. The retry loop multiplies that by `max_retries` (default 2) when the model returns something that fails schema validation.

So: use the free checks below for wiring, keep `/generate` calls deliberate, and never put one in a loop or a watch script. `GET /` is free.

### Available scripts

```
# repo root
test       → npm test --workspaces --if-present

# apps/agent-helios
dev         → wrangler dev        # Local dev server with live reload
start       → wrangler dev        # Alias for dev
test        → vitest run
deploy      → wrangler deploy     # Push to Cloudflare Workers
cf-typegen  → wrangler types      # Regenerate worker-configuration.d.ts after binding changes
db:generate → drizzle-kit generate # New DO SQLite migration after a schema.ts change
```

Note that `wrangler types` types each var as its **literal** value, not as `string`. Changing `PLANNER_MODEL` in `wrangler.jsonc` therefore also means re-running `npm run cf-typegen`, or TypeScript rejects the new value.

### Inspecting local state

```bash
cd apps/agent-helios

npx wrangler kv key list --binding CONFIG --local        # [] on a fresh clone
npx wrangler kv key put --binding CONFIG --local max_retries 4
```

Local state lives in `apps/agent-helios/.wrangler/state/` and is gitignored. Deleting that directory resets KV, D1, R2 and every Durable Object to empty, which is the fastest way out of a confusing local state.

## 9. How to verify a local setup

Run `npm test` first (§5) — it is free and covers the config layer and the model helpers. Everything below exercises the running Worker, which the unit tests deliberately do not.

**Free vs billed:** every request here is free except the happy path and the session-scoping loop, both of which call the planner model. Those two are marked.

### Typecheck

```bash
cd apps/agent-helios
npx tsc --noEmit          # covers both packages via the workspace symlinks
```

### Start the server

```bash
npm run dev --workspace=apps/agent-helios
# wait for: [wrangler:info] Ready on http://localhost:8787
```

Leave it running; issue the requests below from a second terminal.

### Happy path — **one billed model call**

```bash
curl localhost:8787/
# Helios Agent is running

curl -s -X POST localhost:8787/generate \
  -H 'content-type: application/json' \
  -d '{"concept":"art deco paisley"}'
```

Expect **200** and a `HeliosResult` whose `p_invoc_id` is a UUID, `status` is `"completed"`, `error` is `null`, and `params` carries all eight fields with values inside their allowed sets:

```json
{
  "p_invoc_id": "60c2e14f-2af6-4918-88f0-a7e7c61e6199",
  "status": "completed",
  "params": {
    "motif_type": "floral", "repeat_type": "half-drop", "scale": "medium",
    "density": "balanced", "line_weight": "medium",
    "texture_technique": "hatching", "contrast_level": "high", "style": "traditional"
  },
  "image_url": "https://placeholder.invalid/helios-stub-pattern.png",
  "cost_usd": null,
  "error": null
}
```

The params are now genuinely produced by the model, so they vary between calls and between concepts — a repeated call returning identical params means something is cached, not that the wiring is broken. The image URL is still a placeholder because that stage remains a stub, and `cost_usd` in the response reflects the image stage, so it is `null` for the same reason.

In the dev server's own output you should see, in this order:

```
config: text_model=... (var) image_model=... (var) max_retries=2 (var) retention_limit=5 (var)
STUB: generateImage @cf/black-forest-labs/flux-1-schnell A flat seamless repeating textile pattern swatch, ...
```

There should be **no** line reading `planner: call for <id> did not route through AI Gateway`. That warning means `AI_GATEWAY_ID` was empty or wrong and the call went straight to Workers AI, unlogged. It is the only signal that this happened, since token counts come back either way.

To confirm the call really reached the Gateway, open the Cloudflare dashboard under AI > AI Gateway > `helios`; the request appears in the log carrying its `p_invoc_id` as metadata.

### Request validation (4xx, no `p_invoc_id`)

```bash
curl -s -X POST localhost:8787/generate -H 'content-type: application/json' -d '{}'
# 400  {"error":"concept: Invalid input: expected string, received undefined"}

curl -s -X POST localhost:8787/generate -H 'content-type: application/json' -d '{"concept":"   "}'
# 400  {"error":"concept: Too small: expected string to have >=1 characters"}

curl -s localhost:8787/generate
# 405  {"error":"POST required"}

curl -s localhost:8787/nope
# 404  Not found
```

### The SDK's own route

```bash
curl -s -X POST localhost:8787/agents/helios-agent/default \
  -H 'content-type: application/json' -d '{"concept":"paisley"}'
```

Equivalent to `/generate`, and billed the same way. Note the agent name is kebab-cased — `/agents/HeliosAgent/default` returns 400.

### Config resolution — free

Prove the KV path without touching the model:

```bash
cd apps/agent-helios
npx wrangler kv key put --binding CONFIG --local max_retries 4
```

Restart the dev server, then send any request that reaches the pipeline. The config log line should now read `max_retries=4 (kv)` while the other three still read `(var)`. Delete the key and it goes back to `2 (var)`. Put an invalid value in it (`max_retries abc`) and you should get a warning plus the fallback, never a 500.

### Session scoping — **three billed model calls**

```bash
for s in alpha beta alpha; do
  curl -s -X POST localhost:8787/generate -H 'content-type: application/json' \
    -d "{\"concept\":\"x\",\"session_id\":\"$s\"}" | grep -o '"p_invoc_id":"[^"]*"'
done
```

All three `p_invoc_id`s must differ — including the two `alpha` calls, which share a Durable Object instance. IDs belong to the invocation, not the object.

### Pipeline failure handling — free, with a temporary source edit

Add `throw new Error("model call failed");` as the first line of `planConcept` in `src/services/planner.ts`, save, wait for the reload, then POST a concept. Throwing before the model call keeps this free:

```json
{ "p_invoc_id": "...", "status": "failed", "params": null,
  "image_url": null, "cost_usd": null, "error": "planner: model call failed" }
```

Move the throw to the `validate` stage instead (throw from `HeliosParamsSchema.parse`'s line in `pipeline.ts`, or return an out-of-enum value from the planner) and the prefix becomes `validate:`.

Both must return HTTP **200** — a failed run is a pipeline outcome, not a transport error — with the stage named in the `error` prefix. Revert the edit when done.

### Reading the persisted rows

Each invocation writes to the Durable Object's own SQLite storage, under `.wrangler/state/v3/do/`. The application tables are prefixed `helios_` to stay clear of the Agents SDK's own `cf_agents_*` tables (ADR-0003). A completed run has two rows sharing one `p_invoc_id`: the `text` row carries the planner's params, the model name, real token counts, and the neuron count in `cost_usd`; the `image` row is still stub data.

Note that `cost_usd` currently holds the raw **neuron** count, not dollars. The column is named for what it will hold once the rate is settled. A text row showing roughly 100 there is correct.
