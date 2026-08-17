# iris-02: Cloudflare scaffolding and runtime config

**What to build:** the `apps/agent-iris` workspace, its `wrangler.jsonc` with every binding Iris needs, its `config.ts` (the only file allowed to read KV), and the two drizzle configs. Also the two integration branches the whole sprint depends on: `dev-iris` and `dev-atlas`.

**Objective:** Iris needs a real Durable Object, a real D1 database, a real R2 bucket, a real KV namespace and a real AI Gateway before any other ticket can run against it. Every one of these is a Cloudflare dashboard action plus a config line, and getting them wrong is quiet: a wrong KV id passes `deploy --dry-run` and only fails against the real API, and a wrong gateway id does not fail at all, it just stops logging and stops tracking cost. That is why this is one infrastructure ticket owned by one person rather than spread across the tickets that need each binding.

**Final result:** `npm run dev --workspace=apps/agent-iris` starts a worker that answers `GET /` with "Iris Agent is running", has every binding resolved, and prints a resolved-config log line on a request. Nothing else works yet, and that is correct.

**Blocked by:** nothing. Start immediately, in parallel with iris-01 and iris-04.

**Status:** ready-for-human.

**Owner:** Maaz Bin Asif. **Reviewer:** Saad Naik.

## Read this first

- `apps/agent-helios/wrangler.jsonc`, all 138 lines including the comments. The comments are the reasoning and they are the most valuable part of that file. This ticket is largely "do that again, for Iris", so read it rather than re-deriving it.
- `docs/sprint-2-3-conventions.md`, the "Cloudflare side" section. It has a table listing every resource, how it is set up, and where the rule comes from. That table is the specification for this ticket.
- `apps/agent-helios/src/config.ts`, especially the `FIELDS` array and the `prepareModelValue` and `numberFromVar` helpers.
- ADR-0008 for why there is one KV namespace and no `preview_id`, and ADR-0006 for why `AI_GATEWAY_ID` is not in KV.

## Decisions

1. **The KV binding name is exactly `CONFIG`, for every engine.** Not `IRIS_CONFIG`. The binding name is deliberately unprefixed so that every engine's `config.ts` is identical code (ADR-0008). The engines are told apart only by the namespace's dashboard title, which is `IRIS_CONFIG`.
2. **Put the namespace id in `wrangler.jsonc`, not the title.** A title in the `id` field is accepted by `deploy --dry-run` and by local dev, and fails only against the real API. Helios's file carries a comment saying exactly this at `wrangler.jsonc:72`. Copy that comment across.
3. **No `preview_id`.** One store, shared by local dev and production. A second store only ever meant a value edited in one place silently did nothing in the other. Local dev therefore reads a simulated empty store and falls back to `vars` on a fresh clone, which is the intended behaviour, not a bug.
4. **`AI_GATEWAY_ID` and `ALLOWED_ORIGINS` are plain `vars` and never go in KV.** Both fail silently rather than loudly. An empty or misspelled gateway id makes `buildAiRunOptions` return `undefined`, which sends the call straight to Workers AI with no error, no gateway log entry and no cost tracking. An `ALLOWED_ORIGINS` typo opens or closes the only thing stopping a random webpage from spending our money. Both belong where a human reviews them.
5. **Iris shares one R2 bucket with Atlas, `images-bucket`, rather than getting its own.** Decided after this ticket was first written, when Atlas's equivalent ticket was updated the same way: unlike D1 (kept separate per engine during the sprint, per `docs/sprint-2-3-conventions.md`, because a schema migration against a shared live database can't be rehearsed the way a bucket write can), R2 has no migrations and no schema to collide on, so there is nothing two squads writing to the same bucket in parallel can actually break. Iris still uses the same binding name, `PATTERNS`, matching Helios's, so `r2.repository.ts` reads the same in all three engines. What is new is that Atlas's `bucket_name` in `wrangler.jsonc` points at this same bucket rather than a second one. Every key still gets an engine folder prefix, `iris/{p_invoc_id}.jpg` and `atlas/{p_invoc_id}.jpg` (this ticket and atlas-06), so nothing collides on the key either. Helios's own bucket is unaffected: this sprint does not touch Helios.
6. **Iris gets its own D1 database, not Helios's.** `iris-d1`, with `migrations_dir` pointing at `../../infrastructure/d1/migrations/iris/`. The reasoning, and the joint consolidation ticket planned for the end of the sprint, are both in `docs/sprint-2-3-conventions.md`. Do not put Iris's tables in `helios-d1`.
7. **Cut `dev-iris` and `dev-atlas` from `dev`, and turn on branch protection on `main`, as part of this ticket.** Neither branch exists yet and every other ticket's branch is supposed to come off `dev-iris`. Branch protection on `main` was the sprint 1 retro's single highest-value fix and was never applied. Doing it here means it is done before any Iris code exists to protect.
8. **Iris's config fields are the same five Helios has, plus nothing yet.** `text_model`, `image_model`, `max_retries`, `retention_limit`, `max_resume_attempts`. Do not add speculative keys. iris-09 adds a resize-related key if it turns out to need one.

## Agreed shapes, do not invent your own

`apps/agent-iris/wrangler.jsonc`, the parts that differ from Helios's:

```jsonc
{
  "name": "agent-iris",
  "main": "src/index.ts",
  "migrations": [{ "new_sqlite_classes": ["IrisAgent"], "tag": "v1" }],
  "durable_objects": { "bindings": [{ "class_name": "IrisAgent", "name": "IrisAgent" }] },
  "ai": { "binding": "AI" },
  "r2_buckets": [{ "binding": "PATTERNS", "bucket_name": "images-bucket" }],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "iris-d1",
    "database_id": "<fill in from the dashboard>",
    "migrations_dir": "../../infrastructure/d1/migrations/iris"
  }],
  "kv_namespaces": [{ "binding": "CONFIG", "id": "<the namespace ID, not the title IRIS_CONFIG>" }],
  "vars": {
    "PLANNER_MODEL": "@cf/openai/gpt-oss-120b",
    "IMAGE_MODEL": "@cf/black-forest-labs/flux-2-klein-9b",
    "AI_GATEWAY_ID": "iris",
    "RETENTION_LIMIT": "5",
    "MAX_RETRIES": "2",
    "MAX_RESUME_ATTEMPTS": "3",
    "ALLOWED_ORIGINS": "http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173"
  },
  "observability": { "enabled": true },
  "upload_source_maps": true,
  "compatibility_flags": ["nodejs_compat"]
}
```

`IRIS_CONFIG` KV keys, matching Helios's five:

| Key | Shape | Fallback var |
|---|---|---|
| `text_model` | a bare model id, or `{ "model": ..., "temperature": ... }` | `PLANNER_MODEL` |
| `image_model` | a bare model id, or `{ "model": ..., "steps": ... }` | `IMAGE_MODEL` |
| `max_retries` | a number as text | `MAX_RETRIES` |
| `retention_limit` | a number as text | `RETENTION_LIMIT` |
| `max_resume_attempts` | a number as text | `MAX_RESUME_ATTEMPTS` |

## Work

### Branches and protection, do these first

- [ ] Cut `dev-iris` and `dev-atlas` from `dev`, and push both. Every per-ticket branch in this sprint is supposed to branch from one of these, so they have to exist before anyone starts. (**Maaz Bin Asif**)
- [ ] Turn on branch protection on `main`: no direct pushes, PR required. The repo is already public specifically so this is available on a free plan, so it costs nothing to enable. (**Maaz Bin Asif**)
- [ ] Confirm nobody's local `dev` is behind before cutting, so the two branches do not start from a stale base. This is the ghost-delete failure mode from sprint 1 in its earliest form. (**Maaz Bin Asif**)

### Cloudflare resources

- [ ] Create the D1 database `iris-d1` and put its real `database_id` in `wrangler.jsonc`. (**Maaz Bin Asif**)
- [ ] Create the R2 bucket `images-bucket`, shared with Atlas (decision 5). Named for the platform rather than for Iris, the same naming reasoning shared-03 uses for the eventual consolidated D1 database, so Atlas's ticket does not need to create a second one. Tell the Atlas squad once it exists. (**Maaz Bin Asif**)
- [ ] Create the KV namespace titled `IRIS_CONFIG`, and put its **id** in `wrangler.jsonc`, not its title (decision 2). (**Maaz Bin Asif**)
- [ ] Create the AI Gateway named `iris` under AI > AI Gateway. A gateway that does not exist does not error, it just silently stops logging, which means iris-08 and iris-09 record null costs and nobody knows why. (**Maaz Bin Asif**)
- [ ] Seed all five keys in `IRIS_CONFIG` with the same values as the `vars` fallbacks, so the KV path is exercised from the first request rather than only the fallback path. (**Maaz Bin Asif**)
- [ ] Create `infrastructure/d1/migrations/iris/` (a `.gitkeep` is enough for now). iris-03 generates the actual migration into it. (**Maaz Bin Asif**)

### The workspace

- [ ] Create `apps/agent-iris/` with `package.json`, `tsconfig.json`, `wrangler.jsonc`, `drizzle.config.ts`, `drizzle.d1.config.ts`, `.dev.vars.example`, `.prettierrc`, `.editorconfig`, `.gitignore`. Copy each from `apps/agent-helios` and change only what has to change. Do not write any of them from scratch. (**Maaz Bin Asif**)
- [ ] `package.json` carries the same scripts Helios has, with `config:pull` looping over the same five keys. Read the `"//kv"` comment in `apps/agent-helios/package.json` before touching the kv scripts: it explains why they must be npm scripts and not bare `wrangler` commands. Reproduce that comment. (**Maaz Bin Asif**)
- [ ] `.dev.vars.example` has **no keys in it**, same as Helios's. It is a written record that no secret is needed, because the AI Gateway is reached through the pre-authenticated `AI` binding. Do not put an API token in it. (**Maaz Bin Asif**)
- [ ] `.gitignore` covers `.dev.vars*` and `.wrangler/`. (**Maaz Bin Asif**)
- [ ] Add `config:pull:iris` to the **root** `package.json`, matching the existing `config:pull:helios`. This is the only root-level edit this ticket makes. (**Maaz Bin Asif**)

### `index.ts`, `agent.ts` and `cors.ts`, minimal versions

- [ ] `src/index.ts`: routing only, and it exports `IrisAgent` from `./agent` because wrangler's `class_name` binding resolves through the main module. Route `/generate`, `/resume` and `/runs` to the DO through `getAgentByName` with the same `scopeKey` rule Helios uses, route `/images/*` to R2, and answer `/` with `"Iris Agent is running"`. Copy `apps/agent-helios/src/index.ts` including its `scopeKey` and `normaliseSession` helpers and the comment explaining why a GET reads the query string. No orchestration in this file. (**Maaz Bin Asif**)
- [ ] `src/cors.ts`: copy `apps/agent-helios/src/cors.ts` and its test as-is. Do not write a new one, and do not simplify it. Preflight has to be handled ahead of routing, because `/generate` would reject a preflight's empty body long before CORS got a say. The existing file already gets this right. (**Maaz Bin Asif**)
- [ ] `src/agent.ts`: the `IrisAgent` Durable Object with `onStart` running migrations and `onRequest` as its own inline controller. Stub the three routes to return a clearly-marked not-implemented response for now. iris-05 fills them in. Do not add a controller layer. (**Maaz Bin Asif**)
- [ ] `src/utils.ts`: copy `firstIssueMessage` and `describeError` from `apps/agent-helios/src/utils.ts`. Nineteen lines, and every later ticket uses both. (**Maaz Bin Asif**)
- [ ] Do **not** create `src/types.ts`. Helios has one and it is zero bytes and nothing imports it. `docs/directory-structure.md` calls it out as a leftover. Do not copy the leftover. (**Maaz Bin Asif**)

### `config.ts`

- [ ] `src/config.ts` is the only file in the app that reads KV. Port Helios's `FIELDS` table, `resolveConfig` and `describeConfig`, with the five keys above. (**Maaz Bin Asif**)
- [ ] It **never throws**. Every failure path falls back to a `wrangler.jsonc` var and warns. Read the comment on `numberFromVar` in Helios's version: `resolveConfig` runs outside the pipeline's try block, so a throw here escapes as an opaque 500 instead of a settled result. (**Maaz Bin Asif**)
- [ ] Config is read **once per invocation**, not at DO wake-up and not cached at module level (ADR-0008). Two reads straddling a KV edit produce one audit row that is half old model and half new. (**Maaz Bin Asif**)
- [ ] `AI_GATEWAY_ID` is deliberately absent from `FIELDS`. Reproduce the comment in Helios's version saying why. (**Maaz Bin Asif**)
- [ ] Port `config.test.ts` too, covering every fallback path including KV throwing outright and a broken var. Helios's has 12-plus cases; adapt them rather than writing new ones. (**Maaz Bin Asif**)
- [ ] Run `npm run cf-typegen` and commit `worker-configuration.d.ts`. `wrangler types` types each var as its **literal** value, not as `string`, so anyone who later changes a var must regenerate or TypeScript rejects the new value. Say this in a comment near the vars. (**Maaz Bin Asif**)

### Review gates

- [ ] Open the Cloudflare dashboard and confirm the KV `id` in `wrangler.jsonc` is the namespace's id and not its title. This is the one mistake local dev cannot catch. (**Saad Naik**)
- [ ] Confirm the AI Gateway named in `AI_GATEWAY_ID` actually exists, by making one request in iris-06 and seeing a log row appear. Until something has appeared in that gateway's log, treat the gateway as unproven. (**Saad Naik**)
- [ ] Confirm `migrations_dir` points at the `iris/` subdirectory and not at Helios's migrations directory. Pointing at Helios's would apply Helios's migration to Iris's database. (**Saad Naik**)
- [ ] Confirm nothing secret landed in `vars`. Ids and database names are fine; anything that authenticates is not. (**Saad Naik**)
- [ ] Confirm `bucket_name` is `images-bucket`, matching what Atlas's `wrangler.jsonc` will point at (decision 5). A typo silently creates a second bucket instead of erroring. (**Saad Naik**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** No model call happens in this ticket. If you find yourself making one, you are in iris-06's territory.

1. `npx wrangler deploy --dry-run` from inside `apps/agent-iris`. This catches malformed config but **not** a KV title used as an id, so it is necessary and not sufficient.
2. `npm run dev --workspace=apps/agent-iris`, then `curl http://localhost:8787/` returns `Iris Agent is running`.
3. `curl -i -X OPTIONS http://localhost:8787/generate -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST"` returns a preflight that allows the origin, and the same with a junk origin does not.
4. `curl -X POST http://localhost:8787/generate -d '{}'` reaches the DO and returns the not-implemented stub, proving routing and the DO binding resolve.
5. Config: `npm run kv:put --workspace=apps/agent-iris max_retries 7`, make a request, and confirm the log line reports `max_retries` sourced from `kv`. Then delete the key and confirm it reports `var`. **Put it back afterwards:** `npm run config:pull:iris`.
6. From inside `apps/agent-iris`, `npx tsc --noEmit` is clean. Typechecking has to run from inside the app directory because of its `moduleResolution` setting.

## Two things that will waste your afternoon

**The dev server holds the local D1 and KV files open.** If a `wrangler` command against the local store seems to do nothing, or a migration will not apply, stop the dev server first. This trapped two people in sprint 1, in tickets 07 and 08 both.

**A bare `wrangler` command from the repo root finds no `wrangler.jsonc`.** It does not error. It silently leaves this app's KV untouched, and the next request quietly uses the old value, so you conclude the config system is broken when it is working perfectly. Always reach local KV through the npm scripts, which run with the package's own directory as the working directory. The comment in Helios's `package.json` says this too, and it is there because someone lost time to it.
