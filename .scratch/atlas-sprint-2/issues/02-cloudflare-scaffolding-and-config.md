# atlas-02: Cloudflare scaffolding and runtime config

**What to build:** the `apps/agent-atlas` workspace, its `wrangler.jsonc` with every binding Atlas needs, its `config.ts` (the only file allowed to read KV), and the two drizzle configs.

**Objective:** Atlas needs a real Durable Object, a real D1 database, a real R2 bucket, a real KV namespace and a real AI Gateway before any other Atlas ticket can run against it. Every one of those is a dashboard action plus a config line, and getting one wrong fails quietly: a KV title used as an id passes `deploy --dry-run` and only fails against the real API, and a wrong gateway id does not fail at all, it just stops logging and stops tracking cost. That is why this is one infrastructure ticket owned by one person rather than spread across the tickets that need each binding.

**Final result:** `npm run dev --workspace=apps/agent-atlas` starts a worker that answers `GET /` with "Atlas Agent is running", has every binding resolved, and prints a resolved-config log line on a request. Nothing else works yet, and that is correct.

**Blocked by:** nothing. Start immediately. iris-02 cuts the `dev-atlas` branch as part of its own work; if that has not landed yet, cut it here rather than waiting.

**Status:** ready-for-human.

**Owner:** Saad Naik. **Reviewer:** Maaz Ahmad.

**Duration:** 1 day. **Scheduled:** Wed Aug 19 to Wed Aug 19.

## Read this first

- `.scratch/iris-sprint-2/issues/02-cloudflare-scaffolding-and-config.md` in full, because this ticket is the same job for the other engine and its decisions apply here unchanged unless this file says otherwise. Doing Iris's first and then this one is much faster than doing them independently.
- `apps/agent-helios/wrangler.jsonc`, all 138 lines including the comments. The comments are the reasoning and are the most valuable part of the file.
- `docs/sprint-2-3-conventions.md`, "Cloudflare side". Its table is the specification for this ticket.
- `apps/agent-helios/src/config.ts`, especially the `FIELDS` array and the `prepareModelValue` and `numberFromVar` helpers.
- ADR-0008 for why there is one KV namespace and no `preview_id`, ADR-0006 for why `AI_GATEWAY_ID` is not in KV.

## Decisions

1. **The KV binding name is exactly `CONFIG`.** Not `ATLAS_CONFIG`. The binding is deliberately unprefixed so every engine's `config.ts` is identical code (ADR-0008). The engines are told apart only by the namespace's dashboard title, which here is `ATLAS_CONFIG`.
2. **Put the namespace id in `wrangler.jsonc`, not the title.** A title in the `id` field is accepted by `deploy --dry-run` and by local dev and fails only against the real API. Helios's file carries a comment saying exactly this at `wrangler.jsonc:72`. Copy it across.
3. **No `preview_id`.** One store shared by local dev and production, per ADR-0008.
4. **`AI_GATEWAY_ID` and `ALLOWED_ORIGINS` are plain `vars` and never go in KV.** Both fail silently rather than loudly. An empty or misspelled gateway id makes `buildAiRunOptions` return `undefined`, sending the call straight to Workers AI with no error, no log entry and no cost. An `ALLOWED_ORIGINS` typo opens or closes the only thing stopping a random webpage spending our money. Both belong where a human reviews them.
5. **Atlas shares one R2 bucket with Iris, `images-bucket`, rather than getting its own.** Decided after this ticket was first written: unlike D1 (kept separate per engine during the sprint, per `docs/sprint-2-3-conventions.md`, because a schema migration against a shared live database can't be rehearsed the way a bucket write can), R2 has no migrations and no schema to collide on, so there is nothing two squads writing to the same bucket in parallel can actually break. Both engines still use the same binding name, `PATTERNS`, matching Helios's, so `r2.repository.ts` reads the same in all three. What changes is `bucket_name` in `wrangler.jsonc`: Iris's and Atlas's now point at the identical bucket, not two separate ones. Every key still gets an engine folder prefix, `iris/{p_invoc_id}.jpg` and `atlas/{p_invoc_id}.jpg` (iris-05, atlas-06), so nothing collides on the key either. Helios's own bucket is unaffected: this sprint does not touch Helios.
6. **Atlas gets its own D1 database.** `atlas-d1`, with `migrations_dir` pointing at `../../infrastructure/d1/migrations/atlas/`. Do not put Atlas's tables in `helios-d1` or `iris-d1`. The reasoning, and the consolidation ticket at the end of the sprint, are both in `docs/sprint-2-3-conventions.md` and in `.scratch/shared-sprint-2/issues/03-d1-consolidation.md`.
7. **Atlas's config fields are four, not Iris's five.** `image_model`, `max_retries`, `retention_limit`, `max_resume_attempts`. There is **no `text_model`**, because Atlas has no text call. Do not copy the key across for symmetry: a config key with no reader is a key someone will eventually set and wonder why nothing changed.
8. **`max_retries` still exists even though nothing retries.** It is read by shared helpers and keeping the field means the four config keys resolve through the same code path Helios and Iris use. atlas-08 records what it actually governs, which for Atlas is nothing on the image path.
9. **Do not create `src/types.ts`.** Helios has one, it is zero bytes, nothing imports it, and `docs/directory-structure.md` calls it out as a leftover. Do not copy a leftover twice.

## Agreed shapes, do not invent your own

`apps/agent-atlas/wrangler.jsonc`, the parts that differ from Helios's:

```jsonc
{
  "name": "agent-atlas",
  "main": "src/index.ts",
  "migrations": [{ "new_sqlite_classes": ["AtlasAgent"], "tag": "v1" }],
  "durable_objects": { "bindings": [{ "class_name": "AtlasAgent", "name": "AtlasAgent" }] },
  "ai": { "binding": "AI" },
  "r2_buckets": [{ "binding": "PATTERNS", "bucket_name": "images-bucket" }],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "atlas-d1",
    "database_id": "<fill in from the dashboard>",
    "migrations_dir": "../../infrastructure/d1/migrations/atlas"
  }],
  "kv_namespaces": [{ "binding": "CONFIG", "id": "<the namespace ID, not the title ATLAS_CONFIG>" }],
  "vars": {
    "IMAGE_MODEL": "@cf/black-forest-labs/flux-2-klein-9b",
    "AI_GATEWAY_ID": "atlas",
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

`ATLAS_CONFIG` KV keys, four rather than Helios's and Iris's five:

| Key | Shape | Fallback var |
|---|---|---|
| `image_model` | a bare model id, or `{ "model": ..., "steps": ... }` | `IMAGE_MODEL` |
| `max_retries` | a number as text | `MAX_RETRIES` |
| `retention_limit` | a number as text | `RETENTION_LIMIT` |
| `max_resume_attempts` | a number as text | `MAX_RESUME_ATTEMPTS` |

## Work

### Branch

- [ ] Confirm `dev-atlas` exists and was cut from an up-to-date `dev`. iris-02 creates it. If it does not exist yet, cut and push it here rather than blocking, and tell the Iris squad you did so their ticket does not do it twice. (**Saad Naik**)

### Cloudflare resources

- [ ] Create the D1 database `atlas-d1` and put its real `database_id` in `wrangler.jsonc`. (**Saad Naik**)
- [ ] Confirm `images-bucket` exists. iris-02 creates it. If it does not exist yet, create it here rather than blocking, and tell the Iris squad so their ticket does not create it twice (decision 5). Put its name, not an id, in `wrangler.jsonc`'s `bucket_name`; R2 bindings use the name directly, unlike the KV namespace's id-not-title rule in decision 2. (**Saad Naik**)
- [ ] Create the KV namespace titled `ATLAS_CONFIG` and put its **id** in `wrangler.jsonc`, not its title (decision 2). (**Saad Naik**)
- [ ] Create the AI Gateway named `atlas` under AI > AI Gateway. A gateway that does not exist does not error, it silently stops logging, and atlas-07 then records null costs with no clue why. (**Saad Naik**)
- [ ] Seed all four keys in `ATLAS_CONFIG` with the same values as the `vars` fallbacks, so the KV path is exercised from the first request rather than only the fallback path. (**Saad Naik**)
- [ ] Create `infrastructure/d1/migrations/atlas/` with a `.gitkeep`. atlas-04 generates the real migration into it. (**Saad Naik**)

### The workspace

- [ ] Create `apps/agent-atlas/` with `package.json`, `tsconfig.json`, `wrangler.jsonc`, `drizzle.config.ts`, `drizzle.d1.config.ts`, `.dev.vars.example`, `.prettierrc`, `.editorconfig`, `.gitignore`. Copy each from `apps/agent-helios` (or from `apps/agent-iris` if iris-02 has landed) and change only what has to change. Write none of them from scratch. (**Saad Naik**)
- [ ] `package.json` carries the same scripts, with `config:pull` looping over Atlas's **four** keys, not five. Read the `"//kv"` comment in `apps/agent-helios/package.json` before touching the kv scripts and reproduce it: it explains why they must be npm scripts and not bare `wrangler` commands. (**Saad Naik**)
- [ ] `.dev.vars.example` has **no keys in it**, same as Helios's. It is a written record that no secret is needed, because the AI Gateway is reached through the pre-authenticated `AI` binding. Do not put an API token in it. (**Saad Naik**)
- [ ] `.gitignore` covers `.dev.vars*` and `.wrangler/`. (**Saad Naik**)
- [ ] Add `config:pull:atlas` to the **root** `package.json`, matching `config:pull:helios` and `config:pull:iris`. This is the only root-level edit this ticket makes. (**Saad Naik**)
- [ ] If adding a dependency changes `package-lock.json` and it conflicts with the Iris squad's, **delete the file and regenerate it**, never hand-resolve it. Two new apps landing in the same week is exactly the sprint 1 break, and the rule is in `docs/sprint-2-3-conventions.md`. Use `npm install --package-lock-only`, never a bare `npm i`. (**Saad Naik**)

### `index.ts`, `agent.ts`, `cors.ts`, `utils.ts`

- [ ] `src/index.ts`: routing only, exporting `AtlasAgent` from `./agent` because wrangler's `class_name` binding resolves through the main module. Route `/generate`, `/resume` and `/runs` to the DO through `getAgentByName` with the same `scopeKey` rule Helios uses, route `/images/*` to R2, and answer `/` with `"Atlas Agent is running"`. Copy `apps/agent-helios/src/index.ts` including its `scopeKey` and `normaliseSession` helpers and the comment about why a GET reads the query string. No orchestration here. (**Saad Naik**)
- [ ] The entry route is `/generate`, matching Helios and Iris. Not `/place`, not `/repeat`. The playground switches engines by base URL, so identical route names mean it needs no per-engine code (iris-05, decision 9). (**Saad Naik**)
- [ ] `src/cors.ts`: copy `apps/agent-helios/src/cors.ts` and its test as-is. Do not rewrite it and do not simplify it. Preflight has to be handled ahead of routing, because `/generate` would reject a preflight's empty body long before CORS got a say. (**Saad Naik**)
- [ ] `src/utils.ts`: copy `firstIssueMessage` and `describeError` from `apps/agent-helios/src/utils.ts`. Nineteen lines, and every later ticket uses both. (**Saad Naik**)
- [ ] `src/agent.ts`: the `AtlasAgent` Durable Object with `onStart` running migrations and `onRequest` as its own inline controller. Stub the three routes with a clearly-marked not-implemented response; atlas-06 fills them in. Do not add a controller layer. (**Saad Naik**)
- [ ] Do **not** create `src/types.ts` (decision 9). (**Saad Naik**)

### `config.ts`

- [ ] `src/config.ts` is the only file in the app that reads KV. Port Helios's `FIELDS` table, `resolveConfig` and `describeConfig`, with the four keys above and **no `text_model`** (decision 7). (**Saad Naik**)
- [ ] It **never throws.** Every failure path falls back to a `wrangler.jsonc` var and warns. Read the comment on `numberFromVar` in Helios's version: `resolveConfig` runs outside the pipeline's try block, so a throw here escapes as an opaque 500 instead of a settled result. (**Saad Naik**)
- [ ] Config is read **once per invocation**, not at DO wake-up and not cached at module level (ADR-0008). (**Saad Naik**)
- [ ] `AI_GATEWAY_ID` is deliberately absent from `FIELDS`. Reproduce the comment in Helios's version saying why. (**Saad Naik**)
- [ ] Port `config.test.ts`, covering every fallback path including KV throwing outright and a broken var. Adapt Helios's dozen-plus cases rather than writing new ones, and delete the `text_model` cases rather than leaving them testing a key that does not exist. (**Saad Naik**)
- [ ] Run `npm run cf-typegen` and commit `worker-configuration.d.ts`. `wrangler types` types each var as its **literal** value, not as `string`, so anyone changing a var later must regenerate or TypeScript rejects the new value. Say this in a comment near the vars. (**Saad Naik**)

### Review gates

- [ ] Open the Cloudflare dashboard and confirm the KV `id` in `wrangler.jsonc` is the namespace's id and not its title. This is the one mistake local dev cannot catch. (**Maaz Ahmad**)
- [ ] Confirm `migrations_dir` points at `atlas/` and not at Helios's or Iris's directory. Pointing at another engine's would apply that engine's migration to Atlas's database. (**Maaz Ahmad**)
- [ ] Confirm there is no `text_model` key anywhere: not in `FIELDS`, not in `vars`, not in the KV namespace, not in `config:pull` (decision 7). (**Maaz Ahmad**)
- [ ] Confirm nothing secret landed in `vars`. Ids and database names are fine; anything that authenticates is not. (**Maaz Ahmad**)
- [ ] Confirm the AI Gateway named in `AI_GATEWAY_ID` actually exists, by seeing a log row appear from atlas-03's call. Until something has appeared in that gateway's log, treat the gateway as unproven. (**Maaz Ahmad**)
- [ ] Confirm `bucket_name` in Atlas's `wrangler.jsonc` is the exact same string as Iris's, `images-bucket` (decision 5). A typo here silently creates a second bucket instead of erroring, and the mistake is invisible until someone goes looking for an image that was written to the wrong one. (**Maaz Ahmad**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** No model call happens in this ticket. If you find yourself making one, you are in atlas-03's territory.

1. `npx wrangler deploy --dry-run` from inside `apps/agent-atlas`. This catches malformed config but **not** a KV title used as an id, so it is necessary and not sufficient.
2. `npm run dev --workspace=apps/agent-atlas`, then `curl http://localhost:8787/` returns `Atlas Agent is running`.
3. `curl -i -X OPTIONS http://localhost:8787/generate -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST"` allows the origin, and the same with a junk origin does not.
4. `curl -X POST http://localhost:8787/generate -d '{}'` reaches the DO and returns the not-implemented stub, proving routing and the DO binding resolve.
5. `npm run kv:put --workspace=apps/agent-atlas max_retries 7`, make a request, confirm the log line reports `max_retries` sourced from `kv`. Delete the key, confirm it reports `var`. **Put it back:** `npm run config:pull:atlas`.
6. From inside `apps/agent-atlas`, `npx tsc --noEmit` is clean. It has to run from inside the app directory because of its `moduleResolution` setting.

## Two things that will waste your afternoon

**Copying Iris's config wholesale brings `text_model` with it, and nothing complains.** The key resolves, the log line prints it, and it governs a call that does not exist. Six weeks later someone changes it to fix an Atlas output and nothing happens. Delete it deliberately, and delete its test cases too, because a passing test for a dead key is what makes it look intentional.

**A bare `wrangler` command from the repo root finds no `wrangler.jsonc`.** It does not error. It silently leaves this app's KV untouched, and the next request quietly uses the old value, so you conclude the config system is broken when it is working perfectly. Always reach local KV through the npm scripts, which run with the package's own directory as the working directory.
