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
│   └── shared-utils/      Placeholder — no source yet
├── infrastructure/        Cloudflare resource definitions
│   └── d1/                Placeholder — no D1 databases configured yet
├── docs/                  Architecture notes, research, and ADRs
│   ├── adr/               Architecture Decision Records (0001–0005)
│   └── agents/            Conventions for AI agents working in this repo
├── tests/                 Test suites
│   └── .gitkeep           No tests written yet
├── CONTEXT.md             Domain vocabulary (pattern terms, pipeline terms)
├── CLAUDE.md              Entry point for AI agents working in this repo
├── package.json           npm-workspaces root (apps/*, packages/*)
├── LICENSE                Apache 2.0
└── README.md              This file
```

`.scratch/` holds sprint specs and tickets as markdown (see `docs/agents/issue-tracker.md`). No `tsconfig.base.json`, `turbo.json`, or `.github` directory exists. Those may be added later if a build tool like Turborepo or a CI workflow is introduced.

**Read the ADRs before changing architecture.** `agent-helios` is the literal template for every future engine (Iris, Atlas, Orpheus, Arachne, Vulcan), so several decisions recorded there apply repo-wide rather than to Helios alone.

## 3. apps/agent-helios

**What it does.** Accepts an HTTP request carrying a design concept and runs it through the fixed-order pipeline: planner → validate → image generator. The module wiring is real and works end-to-end; the two model calls themselves are still stubs returning canned data.

### Module shape

This structure is deliberate and is the template all future engines copy. The guiding principle is *fewer files, less indirection* — `agent.ts` is its own controller, with no separate controller layer.

| File | Responsibility |
|---|---|
| `src/index.ts` | Routing only — no request handling or orchestration |
| `src/agent.ts` | `HeliosAgent` class; request validation directly in `onRequest` |
| `src/services/pipeline.ts` | Fixed-order orchestrator (planner → validate → image) |
| `src/services/planner.ts` | Textual planner model call — **stub** |
| `src/services/imageGenerator.ts` | Image model call — **stub** |
| `src/utils.ts` | Error-message formatting shared by the agent and pipeline |
| `src/tools.ts` | Empty — will hold the planner's JSON schema |
| `src/repository/` | Empty — D1 and R2 repositories |
| `src/db/schema.ts` | Empty — will hold the `helios_runs` table definition |

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
| Textual planner model call (GPT-OSS-120B via Workers AI) | Stub — returns canned schema-valid params |
| Image model call (Flux Schnell via Workers AI) | Stub — returns a placeholder URL |
| `helios_runs` table, DO-local persistence | Not started |
| D1 export, R2 image storage, retention pruning | Not started |
| Planner prompts, image-prompt translator | Not started |

### Error contract

The split is between *transport errors* and *pipeline outcomes*:

- **4xx with `{ "error": "..." }`** — the request never became a pipeline invocation, so there is no `p_invoc_id` to report. Covers a non-`POST` method (405) and a missing/blank/oversized `concept` (400).
- **200 with `"status": "failed"`** — an invocation *did* start and a stage failed. The response is a full `HeliosResult`; `error` is prefixed with the failing stage (`planner:`, `validate:`, or `image:`).

`runPipeline` never throws. Every path returns a `HeliosResult`.

### wrangler.jsonc bindings

```jsonc
{
  "name": "agent-helios",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-27",
  "migrations": [{ "new_sqlite_classes": ["HeliosAgent"], "tag": "v1" }],
  "durable_objects": {
    "bindings": [{ "class_name": "HeliosAgent", "name": "HeliosAgent" }]
  },
  "observability": { "enabled": true },
  "upload_source_maps": true,
  "compatibility_flags": ["nodejs_compat"]
}
```

- `durable_objects.bindings[0]` maps the JS class `HeliosAgent` to a binding named `HeliosAgent` so the worker can look up and call agent instances by name.
- `migrations[0]` tells Cloudflare to create SQLite storage for the `HeliosAgent` class when first deployed.
- `nodejs_compat` enables Node.js API shims (`Buffer`, `process`, etc.) inside the Workers runtime.

Note that `main` is `src/index.ts` while the class now lives in `src/agent.ts`. Wrangler resolves `class_name` through the main module, so **`index.ts` must keep re-exporting `HeliosAgent`** — removing that line breaks the binding at deploy time, not at typecheck time.

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

Placeholder. `package.json` exists but `"main": ""` and no source files except `src/.gitkeep`. Intended for a generic `callWithStructuredOutput(schema, prompt, model)` helper that every future engine's planner can reuse, plus other cross-app utilities.

### Why shared rather than duplicated per-app

Workspace packages are symlinked at install time. A change to `shared-types` is instantly visible to every app that depends on it, without any publish step. When Helios is the only consumer there's little benefit, but once a playground, api-gateway, or Athena arrives, duplicating these interfaces across apps would create drift.

## 5. tests/

The root `package.json` sets `"directories": { "test": "tests" }`, which reserves `tests/` for the project. Today it contains only `.gitkeep`.

There is no test runner configured yet — verification is manual (see §9). The intended harness is `@cloudflare/vitest-pool-workers`, exercising the Worker's HTTP boundary as the primary seam: a request in, a `HeliosResult` and the matching persisted rows out, with only the external Workers AI bindings stubbed. That lands alongside the persistence work.

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

- Node.js ≥ 18 (for `wrangler`)
- A Cloudflare account (for `wrangler deploy` — not needed for local dev)

### Commands

```bash
# Install all workspace dependencies from the repo root
npm install

# Start the agent-helios dev server (defaults to port 8787)
npm run dev --workspace=apps/agent-helios

# Or, from inside apps/agent-helios:
cd apps/agent-helios
npm run dev
```

The `dev` script calls `wrangler dev`, which compiles TypeScript on the fly, starts Miniflare (the local Cloudflare Workers simulator), and watches for file changes. Saving a source file reloads the worker in about a second.

### Available scripts per app

```
deploy     → wrangler deploy     # Push to Cloudflare Workers
dev        → wrangler dev        # Local dev server with live reload
start      → wrangler dev        # Alias for dev
cf-typegen → wrangler types      # Regenerate worker-configuration.d.ts after binding changes
```

## 9. How to test the current implementation

There is no automated test suite yet (§5). Verify manually against a running dev server.

### Typecheck

```bash
cd apps/agent-helios
npx tsc --noEmit          # covers shared-types too, via the workspace symlink
```

### Start the server

```bash
npm run dev --workspace=apps/agent-helios
# wait for: [wrangler:info] Ready on http://localhost:8787
```

Leave it running; issue the requests below from a second terminal.

### Happy path

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

The params are the same on every call and the image URL is not real — both stages are still stubs. What this verifies is the **wiring**: routing, validation, orchestration order, and response shape.

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

Equivalent to `/generate`. Note the agent name is kebab-cased — `/agents/HeliosAgent/default` returns 400.

### Session scoping

```bash
for s in alpha beta alpha; do
  curl -s -X POST localhost:8787/generate -H 'content-type: application/json' \
    -d "{\"concept\":\"x\",\"session_id\":\"$s\"}" | grep -o '"p_invoc_id":"[^"]*"'
done
```

All three `p_invoc_id`s must differ — including the two `alpha` calls, which share a Durable Object instance. IDs belong to the invocation, not the object.

### Pipeline failure handling (200 with `status: "failed"`)

Both cases need a temporary source edit; revert afterwards.

**Planner failure** — add `throw new Error("model call failed");` as the first line of `planConcept` in `src/services/planner.ts`, save, wait for the reload, then POST a concept:

```json
{ "p_invoc_id": "...", "status": "failed", "params": null,
  "image_url": null, "cost_usd": null, "error": "planner: model call failed" }
```

**Validation failure** — instead change the canned `repeat_type` in `planConcept` to a value outside the enum, e.g. `"spiral" as HeliosParams["repeat_type"]`:

```json
{ "status": "failed", "params": null,
  "error": "validate: repeat_type: Invalid option: expected one of \"block\"|\"half-drop\"|..." }
```

Both must return HTTP **200** — a failed run is a pipeline outcome, not a transport error — with the stage named in the `error` prefix. Restore `planner.ts` when done and re-run the happy path to confirm you're back to `"completed"`.
