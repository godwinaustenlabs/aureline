# What is in each file

Every file, what it holds, and why it exists as its own file. Grouped by layer and ordered so that reading top to bottom is a tour rather than an alphabetical list.

Examples are from `apps/agent-helios`, which is the template every future engine copies.

## The repo

```
aureline/
├── apps/                  Independently deployable Cloudflare Workers
│   └── agent-helios/      The one engine that exists today
├── packages/              Shared, non-deployable code, symlinked by npm workspaces
│   ├── shared-types/      Zod schemas and the types inferred from them
│   └── shared-utils/      Model-calling helpers
├── infrastructure/        Cloudflare resource definitions
│   └── d1/migrations/     Generated D1 migrations for the audit table
├── docs/                  These docs, plus the ADRs
├── tests/                 Scratch harnesses. Not the test suite
├── .scratch/              Sprint tickets as markdown
├── package.json           npm workspaces root
├── LICENSE                Apache 2.0
└── README.md              Landing page
```

There is no `tsconfig.base.json`, no `turbo.json` and no `.github/`. Each workspace carries its own TypeScript config, and deploys are manual.

| File | What it is |
|---|---|
| `package.json` | Workspaces (`apps/*`, `packages/*`), and only two scripts: `test` and `config:pull:helios`. Declares **no dependencies of its own**. Pins Node 24 or newer in `engines`, because the database tests use `node:sqlite` |
| `package-lock.json` | The lockfile. To add a dependency run `npm install --package-lock-only`, never a bare `npm i` |
| `infrastructure/d1/migrations/` | **Generated.** The D1 copy of the `helios_runs` schema, produced by `npm run db:generate:d1` |
| `tests/run-concept.ts` | A scratch harness that prints what `buildImagePrompt` produces for hand-typed params, for eyeballing prompt changes. Not a test |

## `packages/shared-types`

The contract. One package so that Helios, a future playground, and eventually Athena all agree on the same shapes.

| File | What is in it |
|---|---|
| `src/index.ts` | Barrel. A single `export *` |
| `src/v1/messages.ts` | Everything. `HeliosParamsSchema`, `HeliosStatusSchema`, `HeliosRequestSchema`, `HeliosResumeRequestSchema`, `HeliosResult`, and the types inferred from each |

**Why the schemas rather than interfaces.** One Zod definition serves three jobs: the compile time type through `z.infer`, the runtime check in the pipeline's validate stage, and the JSON schema handed to the planner model. Three hand written definitions would drift.

The `v1/` folder is versioning by directory, so a breaking change to the contract can land as `v2/` beside it rather than as an edit that silently breaks a caller.

Full field list in [spec.md](spec.md#wire-schemas).

## `packages/shared-utils`

The model calling layer, shared because every future engine calls models the same way even though each has its own schema.

| File | What it does |
|---|---|
| `src/aiGateway.ts` | `buildAiRunOptions` builds `ai.run`'s third argument from a gateway config. **Returns `undefined` when there is no gateway id**, which silently degrades to a direct Workers AI call. That is the trap `planner.ts` warns about |
| `src/getTextualModelOutput.ts` | Takes a Zod schema and a prompt, converts the schema with `z.toJSONSchema`, sends a Chat Completions request with `response_format: json_schema`, unwraps the reply envelope, validates, and retries on failure. Returns `{ data, usage, model }` |
| `src/getImageModelOutput.ts` | Calls an image model and decodes the base64 reply to bytes |
| `src/index.ts` | Barrel |
| `src/*.test.ts` | 34 tests |

Two things in here are easy to get wrong. The envelope unwrapping handles three reply shapes because Workers AI models are inconsistent about it. And the retry loop distinguishes a **schema** failure from a **call** failure in the error it throws, so a run that failed after two bad JSON replies reads differently from one where the model was unreachable.

The request shape is Chat Completions rather than the Responses API on purpose. Responses works but reports zero tokens and zero neurons on a billed call, which makes cost untrackable. [ADR-0007](adr/0007-responses-api-only-for-structured-output.md).

## `apps/agent-helios/src`

The dependency direction, which is what the layering actually means:

```
index.ts ──────────────────────► agent.ts
   │                                │
   │                                ├──► services/pipeline.ts
   │                                │        ├──► services/planner.ts ──► tools.ts ──► shared-utils
   │                                │        ├──► services/imageGenerator.ts ──► shared-utils
   │                                │        ├──► services/gatewayCost.ts
   │                                │        └──► repository/{do,d1,r2}
   │                                │
   │                                └──► services/resume.ts
   │                                         └──► pipeline.ts (runImageStage, exportAndPrune)
   │
   └──► repository/r2.repository.ts

config.ts and utils.ts are leaves. They import only zod.
repository/* is the only thing that touches storage.
```

### Entry and the object

| File | What is in it, and why it is its own file |
|---|---|
| `src/index.ts` | The Worker `fetch` handler. **Routing only**, no orchestration: pathname matching, `scopeKey` to pick the Durable Object, the `/images/*` R2 read, and the re-export of `HeliosAgent` that wrangler's binding resolves through. Keeping it routing-only is what makes the DO independently testable |
| `src/agent.ts` | The `HeliosAgent` Durable Object. `onStart` applies migrations on every wake-up, `onRequest` validates the body and calls a service. **It is its own controller**: there is no controller layer, because with two routes one would be indirection for its own sake. The `json` and `error` helpers live privately at the bottom |

### Config

| File | What is in it |
|---|---|
| `src/config.ts` | The only thing in the app that reads KV. Owns the `FIELDS` table (one row per tunable), `resolveConfig`, and `describeConfig`. Never throws: every failure path falls back to a `wrangler.jsonc` var and warns |
| `src/config.test.ts` | 12-plus cases covering every fallback path, including KV throwing outright and a broken var |

### Services, where the work happens

| File | What is in it |
|---|---|
| `src/services/pipeline.ts` | The orchestrator. `runPipeline` runs planner then validate then image in fixed order and never throws. `runImageStage` is the image half **extracted so `/resume` can enter the pipeline there**, which keeps one copy of the image path instead of two. `exportAndPrune` copies settled rows to D1 and then prunes, in that order |
| `src/services/resume.ts` | `resumeRun`: the six refusals, the spend cap counted over `root`, the resumed text row, and then `runImageStage`. Its own file because it is a second entry point into the pipeline rather than a step within it |
| `src/services/planner.ts` | `planConcept`. Builds the prompts, calls the model through the gateway, and warns when `aiGatewayLogId` comes back empty. Does **not** validate: that is the pipeline's own validate stage, kept separate so a schema failure is attributable to the right stage |
| `src/services/imageGenerator.ts` | `generateImage` and `resolveSteps`. Builds the Flux prompt, clamps steps to Flux Schnell's cap of 8, skips the gateway cache, rejects an over-long prompt **before** billing. Returns raw bytes only. It does not know R2 exists |
| `src/services/gatewayCost.ts` | `readGatewayCost`. Reads real dollars from the AI Gateway log. Its own file because **both** stages need it, and because it has one rule easy to break: call it immediately after the call it belongs to, since `aiGatewayLogId` only holds the most recent one. Returns null on anything failing, because a missing cost must never fail a run |
| `src/services/*.test.ts` | `pipeline.test.ts`, `resume.test.ts`, `imageGenerator.test.ts` |

### Repositories, the only code that touches storage

| File | What is in it |
|---|---|
| `src/repository/do.repository.ts` | Every read and write against `helios_runs` in DO SQLite, one function per moment the pipeline records: `startTextRun`, `completeTextRun`, `insertResumedTextRun`, `startImageRun`, `insertFailedImageRun`, `completeImageRun`, `failRunningRuns`, `countResumeAttempts`, `getRunRows`, `getSettledRows`, `pruneCompletedRuns` |
| `src/repository/d1.repository.ts` | `exportRuns` (chunked at 9 rows, because D1 caps a statement at 100 bound parameters and the table has 11 columns) and `readRun` |
| `src/repository/r2.repository.ts` | `savePatternImage` and `readPatternImage`. All R2 access, both directions |
| `src/repository/test-db.ts` | `createTestDb` and `insertRow`. **Real in-memory SQLite** through Node's `node:sqlite` driven by Drizzle's `sqlite-proxy` driver, so tests run real SQL with no native module and no Worker runtime. Stands in for both the DO and D1 clients |
| `src/repository/do.repository.test.ts` | Pruning boundaries, the settled-rows filter, export idempotency and chunking |

### Database

| File | What is in it |
|---|---|
| `src/db/schema.ts` | The `helios_runs` table, defined **once** and compiled to both stores |
| `src/db/client.ts` | `getDb(storage)` and `getD1Db(env.DB)`, two Drizzle factories over that one schema. They return different types so it is hard to mix them up |

### Prompts

| File | What is in it |
|---|---|
| `src/prompts/planner.prompt.ts` | `buildPlannerSystemPrompt` and `buildPlannerUserPrompt`, plus the textile glossaries behind them. **The only component in Helios that reasons about textiles.** Each glossary is typed against the matching schema field, so adding an enum value without writing its gloss is a compile error |
| `src/prompts/image.prompt.ts` | `buildImagePrompt`. A deterministic translator from the eight params to one Flux sentence, with no design judgement in it. Clause order matters because Flux weights early clauses more heavily |
| `src/prompts/index.ts` | Barrel |

Both files export a version id (`helios-planner-v1`, `helios-image-v1`). **Prompts are versioned, not edited in place**, so a run's output stays attributable to the prompt that produced it.

### Small shared pieces

| File | What is in it |
|---|---|
| `src/tools.ts` | `callPlannerModel`. A thin call site binding `HeliosParamsSchema` to `getTextualModelOutput`. Owns no schema of its own |
| `src/utils.ts` | `firstIssueMessage` (a Zod error as `field: message`) and `describeError` (anything thrown as one line) |
| `src/types.ts` | **Empty, zero bytes, nothing imports it.** A leftover placeholder. Mentioned here so you do not go looking for what is in it |

## `apps/agent-helios`, everything outside `src`

| File | What it is |
|---|---|
| `wrangler.jsonc` | Bindings, vars, DO migrations, compatibility date. See [spec.md](spec.md#bindings) |
| `package.json` | The app's scripts and dependencies. See [running-locally.md](running-locally.md#scripts) |
| `tsconfig.json` | `moduleResolution: node`, strict, `noEmit`. The reason typechecking has to run from inside this directory |
| `drizzle.config.ts` | Generates DO SQLite migrations into `drizzle/` |
| `drizzle.d1.config.ts` | Generates D1 migrations into `infrastructure/d1/migrations/`. Same schema file, different target |
| `.dev.vars.example` | Deliberately **has no keys**. It is a written record that no secret is needed today, because the AI Gateway is reached through the pre-authenticated `AI` binding |
| `.prettierrc`, `.editorconfig` | Tabs, 140 columns |
| `.gitignore` | Includes `.dev.vars*` and `.wrangler/` |

## Generated files, do not hand edit

Four things in the tree are produced by a tool. Editing them by hand works right up until the next regeneration silently discards your change.

| Path | Regenerate with |
|---|---|
| `apps/agent-helios/worker-configuration.d.ts` | `npm run cf-typegen` |
| `apps/agent-helios/drizzle/` | `npm run db:generate` |
| `infrastructure/d1/migrations/` | `npm run db:generate:d1` |
| `package-lock.json` | `npm install --package-lock-only` |

`worker-configuration.d.ts` is worth one extra note: `wrangler types` types each var as its **literal** value, not as `string`. Change a var in `wrangler.jsonc` and you must regenerate, or TypeScript rejects the new value.

## Where a new file goes

Work down this list and stop at the first match.

1. Does it decide where a request goes? It belongs in `index.ts`, and probably as a branch rather than a new file.
2. Does it read or write DO SQLite, D1 or R2? `repository/`. Nothing else may touch storage.
3. Does it read KV? `config.ts`. Add a row to `FIELDS` rather than a new read.
4. Does it call a model? `services/`, with anything reusable across engines going to `packages/shared-utils`.
5. Is it text sent to a model? `prompts/`, versioned.
6. Is it a shape crossing the wire? `packages/shared-types`.

If two of those match, the file is doing two jobs.
