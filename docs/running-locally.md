# Running it locally

Setup, the scripts, and a runbook for proving a fresh clone actually works.

Commands are for `apps/agent-helios`. Every future engine works the same way.

## The one thing that costs money

**`wrangler dev` bills your real Cloudflare account.**

The `AI` binding has no local simulator. Everything else (the Durable Object, D1, R2, KV) is simulated on your machine, but every model call goes to the real Workers AI API using your credentials, on localhost exactly as in production.

| Request | Cost |
|---|---|
| `POST /generate` | about **$0.0029** |
| `POST /resume` | about **$0.0019** |
| Everything else | free |

The planner's retry loop multiplies its share by `max_retries`, so a run where the model keeps returning bad JSON costs more than a clean one.

So: use the free checks for wiring, keep `/generate` deliberate, and **never put one in a loop or a watch script**. The test suite makes no model calls at all and is free to run as often as you like.

## Prerequisites

- **Node 24 or newer.** The database tests use `node:sqlite`, which is stable from 24. Wrangler needs 20 or newer independently.
- **An authenticated Cloudflare account** with access to this project. Run `npx wrangler whoami`, and `npx wrangler login` if it does not name it.

Authentication is not optional for local dev, for the `AI` binding reason above.

## From a fresh clone

```bash
npm install                                   # from the repo root, installs every workspace
npm test                                      # 101 tests, no model calls, should be green
cd apps/agent-helios && npx tsc --noEmit      # typecheck
npm run dev                                   # http://localhost:8787
```

That is the whole setup. Nothing to provision, no `.dev.vars` to create, no migration to run by hand.

Four things that would otherwise cost you an hour:

- **Run `npx tsc --noEmit` from inside `apps/agent-helios`, not the repo root.** At the root, `npx` resolves TypeScript 7, which rejects this project's `"moduleResolution": "node"` with TS5108. The workspace-local TypeScript 5 is the one that matters. Known wart, not something you broke.
- **`.dev.vars` is not needed today.** `.dev.vars.example` exists and is deliberately empty of keys: it documents *why* no secret is required, which is that AI Gateway is reached through the pre-authenticated `AI` binding. Copy it only when a ticket adds a real secret.
- **DO SQLite migrations apply themselves.** `onStart` runs them on every Durable Object wake-up and Drizzle tracks what is already applied. After editing `src/db/schema.ts`, run **both** `npm run db:generate` and `npm run db:generate:d1`. Forget the second and the export to D1 starts failing quietly.
- **Regenerating an existing migration needs the old table gone first.** Drizzle generates a bare `CREATE TABLE` with no `IF NOT EXISTS`, so anything that already applied the previous version throws "table already exists" — and for a Durable Object that happens inside `onStart`, which breaks the session rather than just losing its history. Locally, delete `.wrangler/state/v3/do/` and `.wrangler/state/v3/d1/` and let the next request rebuild them. On the deployed worker this is a human step and is written down in [ADR-HELIOS-0001](adr/helios/0001-pipeline-id-and-design-session-id.md); do not improvise it.
- **Local KV starts empty**, so config resolves entirely from the `wrangler.jsonc` vars and the log line reads `(var)` five times. That is correct. It is what the fallbacks are for.

## Scripts

```
# repo root
test               → npm test --workspaces --if-present
config:pull:helios → runs config:pull in apps/agent-helios

# apps/agent-helios
dev            → wrangler dev              Local dev server with live reload
start          → wrangler dev              Alias for dev
test           → vitest run
deploy         → wrangler deploy           Push to Cloudflare Workers
cf-typegen     → wrangler types            Regenerate worker-configuration.d.ts after a binding change
db:generate    → drizzle-kit generate      New DO SQLite migration after a schema.ts change
db:generate:d1 → drizzle-kit generate      The same change, for D1
config:pull    → copy all five config keys from the real KV namespace into your local one
kv:get         → wrangler kv key get --binding CONFIG --local
kv:put         → wrangler kv key put --binding CONFIG --local
```

`wrangler types` types each var as its **literal** value, not as `string`. Change `PLANNER_MODEL` in `wrangler.jsonc` and you must re-run `npm run cf-typegen` or TypeScript rejects the new value.

### Always reach local KV through `kv:get` and `kv:put`

This one has already cost real money once, so it is worth the paragraph.

Run a bare `npx wrangler kv key put ...` from the **repo root** and there is no `wrangler.jsonc` there for wrangler to find. It does not error. It finds no binding, touches nothing, and exits quietly. If you were setting a bad model name to force a failure, your next `/generate` is a perfectly normal billed success instead, and you have paid for a run you did not want and learned nothing.

npm runs a script with its own package as the working directory, so `npm run kv:put --workspace=apps/agent-helios ...` cannot land in the wrong place. Use the scripts.

## Config in local dev

There is exactly **one** KV namespace, titled `HELIOS_CONFIG` in the dashboard and bound as `CONFIG`. There is no preview namespace, on purpose: a second store meant the same key existed twice, looked identical in the dashboard, and a value edited in the wrong one silently did nothing.

| How you run it | Store used |
|---|---|
| `wrangler dev` (default) | A simulated store in `apps/agent-helios/.wrangler/state/v3/kv/` |
| `wrangler dev` with `remote` on the binding | `HELIOS_CONFIG`, the real one |
| `wrangler deploy` | `HELIOS_CONFIG`, the real one |

**To read the real namespace from local dev**, uncomment one field in `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "CONFIG", "id": "bc982c0d712a49b4827520477c33fab5", "remote": true }
]
```

That sends **only** this binding live. The Durable Object, D1 and R2 stay local and simulated, and live reload still works. It needs network access and an authenticated wrangler on every dev run, which is why it ships commented out. Flip it for a session, then flip it back.

**To copy the real values into your local store** instead, so you can work offline against a realistic config:

```bash
npm run config:pull --workspace=apps/agent-helios
```

**The trade to be aware of.** With no preview namespace, local dev in remote mode and production read the same store. There is no staging tier for config, and `wrangler kv key put --binding CONFIG --remote ...` from your terminal edits production. The safety net is that a bad value only ever produces a warning and a fallback to the var, never an outage.

## Inspecting local state

```bash
cd apps/agent-helios

npm run kv:get -- max_retries          # read one key
npm run kv:put -- max_retries 4        # set one
npx wrangler kv key list --binding CONFIG --local
```

Everything local lives in `apps/agent-helios/.wrangler/state/` and is gitignored: KV, D1, R2 and every Durable Object's SQLite. **Deleting that directory resets all of it to empty**, which is the fastest way out of a confusing local state.

---

# Verifying a setup

Run `npm test` first. It is free and covers config, the repositories, the pipeline and resume. Everything below exercises the running Worker, which the unit tests deliberately do not.

**Two steps below are billed and are marked.** Everything else is free.

### 1. Typecheck

```bash
cd apps/agent-helios
npx tsc --noEmit          # covers both packages through the workspace symlinks
```

### 2. Start the server

```bash
npm run dev --workspace=apps/agent-helios
# wait for: [wrangler:info] Ready on http://localhost:8787
```

Leave it running and use a second terminal below.

### 3. Liveness, free

```bash
curl localhost:8787/
# Helios Agent is running
```

### 4. Request validation, free

```bash
curl -s -X POST localhost:8787/generate -H 'content-type: application/json' -d '{}'
# 400  {"error":"concept: Invalid input: expected string, received undefined"}

curl -s -X POST localhost:8787/generate -H 'content-type: application/json' \
  -d '{"concept":"   ","design_session_id":"design-1"}'
# 400  {"error":"concept: Too small: expected string to have >=1 characters"}

curl -s -X POST localhost:8787/generate -H 'content-type: application/json' \
  -d '{"concept":"art deco paisley"}'
# 400  {"error":"design_session_id: Invalid input: expected string, received undefined"}

curl -s -X POST localhost:8787/resume -H 'content-type: application/json' -d '{}'
# 400  {"error":"pipeline_id: Invalid input: expected string, received undefined"}

curl -s localhost:8787/generate
# 405  {"error":"POST required"}

curl -s localhost:8787/nope
# 404  Not found
```

These all cost nothing and never reach a model. A 4xx carries no `pipeline_id`, because no invocation ever existed.

`design_session_id` is **required and has no fallback**. Helios will not mint one, and it will not accept the old `p_invoc_id` name in its place (ADR-HELIOS-0001). A run that cannot be traced back to a design still spends money and still lands in the audit table, so it is refused before the pipeline starts.

### 5. Config resolution, free

```bash
npm run kv:put -- max_retries 4
```

Restart the dev server, then send any request that reaches the pipeline. The config line should now read `max_retries=4 (kv)` while the other four still read `(var)`. Delete the key and it goes back to `2 (var)`.

Now put an invalid value in it:

```bash
npm run kv:put -- max_retries abc
```

You should get a warning and the fallback, **never a 500**. That is the whole point of the config layer.

### 6. Resume refusals, free

Every refusal is a 409 that writes nothing and bills nothing, so they are all free to exercise.

```bash
curl -s -X POST localhost:8787/resume -H 'content-type: application/json' \
  -d '{"pipeline_id":"does-not-exist"}'
# 409  {"error":"no run does-not-exist in this session"}
```

Resume a `pipeline_id` that already succeeded and you should get the refusal about it already having an image. That one is the guard standing between you and paying for the same picture twice, so it is worth confirming it works.

### 7. Happy path, **billed, about $0.0029**

```bash
curl -s -X POST localhost:8787/generate \
  -H 'content-type: application/json' \
  -d '{"concept":"art deco paisley","design_session_id":"design-1"}'
```

Expect **200** and a `HeliosResult` whose `pipeline_id` is a UUID, `design_session_id` is the one you sent back unchanged, `status` is `"completed"`, `error` is `null`, `params` carries all eight fields with values inside their allowed sets, and `image_url` points at a real object:

```json
{
  "pipeline_id": "60c2e14f-2af6-4918-88f0-a7e7c61e6199",
  "design_session_id": "design-1",
  "status": "completed",
  "params": {
    "motif_type": "paisley", "repeat_type": "half-drop", "scale": "medium",
    "density": "balanced", "line_weight": "fine",
    "texture_technique": "hatching", "contrast_level": "high", "style": "art deco"
  },
  "image_url": "http://localhost:8787/images/patterns/60c2e14f-2af6-4918-88f0-a7e7c61e6199.jpg",
  "cost_usd": 0.0019008,
  "error": null
}
```

The params come from the model, so they vary between calls and between concepts. **Identical params on a repeated call means something is cached, not that the wiring is right.**

The dev server logs one config line first. There should be **no** line reading `planner: call for <id> did not route through AI Gateway`. That warning means `AI_GATEWAY_ID` was empty or wrong and the call went straight to Workers AI, unlogged, which also means `cost_usd` will be null. It is the only signal this happened, since token counts come back either way.

To confirm the call really reached the Gateway, open the Cloudflare dashboard under AI > AI Gateway > `helios`. The request appears in the log carrying its `pipeline_id` as metadata.

### 8. Fetch the image, free

```bash
curl -s -o /tmp/pattern.jpg -w '%{http_code} %{content_type}\n' \
  "http://localhost:8787/images/patterns/<pipeline_id>.jpg"
# 200 image/jpeg
```

A key with no object behind it returns 404.

### 9. The SDK's own route, **billed**

```bash
curl -s -X POST localhost:8787/agents/helios-agent/default \
  -H 'content-type: application/json' -d '{"concept":"paisley","design_session_id":"design-1"}'
```

Equivalent to `/generate` and billed the same way, so skip it unless you are specifically checking the SDK path. The agent name is **kebab-cased**: `/agents/HeliosAgent/default` returns 400.

### 10. Session scoping, **billed, one call per session**

Two requests to the same `session_id` land on the same Durable Object and still get different `pipeline_id`s, because ids belong to the invocation and not the object. Send the same `design_session_id` on both and they stay grouped as one design while remaining separately identifiable — that is the whole reason there are two ids (AGENTS.md §3).

You can prove the routing half of this **for free**, because an empty concept is rejected before the pipeline starts and so never reaches a model:

```bash
for s in alpha beta alpha; do
  curl -s -X POST localhost:8787/generate -H 'content-type: application/json' \
    -d "{\"concept\":\"\",\"design_session_id\":\"design-1\",\"session_id\":\"$s\"}" \
    -o /dev/null -w "%{http_code}\n"
done
# 400 three times, and three Durable Objects were reached without billing anything
```

`.wrangler/state/v3/do/` will now hold two objects, one per distinct session name. Send the same request with `Alpha` capitalised and you get a **third**, because the name is hashed exactly.

### 11. Failure handling, free with a temporary source edit

Add `throw new Error("model call failed");` as the first line of `planConcept` in `src/services/planner.ts`, save, wait for the reload, then POST a concept. Throwing before the model call keeps this free:

```json
{ "pipeline_id": "...", "design_session_id": "design-1", "status": "failed",
  "params": null, "image_url": null, "cost_usd": null,
  "error": "planner: model call failed" }
```

Move the throw into the validate stage instead and the prefix becomes `validate:`. Both must return HTTP **200**, because a failed run is a pipeline outcome and not a transport error.

**Revert the edit when you are done**, and never commit it.

### 12. Reading the persisted rows

Each invocation writes to the Durable Object's own SQLite under `.wrangler/state/v3/do/`, then exports to the local D1 under `.wrangler/state/v3/d1/`. The `readRun` function in `repository/d1.repository.ts` is the intended read path, so prefer it over a hand-typed query.

A completed run is **two rows sharing one `pipeline_id`**: the `text` row carries the planner's params, model, token counts and dollar cost; the `image` row carries the R2 key and the image's cost. Both also carry the `design_session_id` from the request, so `where design_session_id = ?` reads back every attempt at one design. A failed image run has the same two rows with the image one marked `failed`, and that is the state `POST /resume` recovers.

What each column means, and where the traps are, is in [helios-runs-conventions.md](helios-runs-conventions.md).

## Where to go next

- What each of those steps is doing internally: [flows.md](flows.md)
- The bindings and routes in full: [spec.md](spec.md)
- Which file to open: [directory-structure.md](directory-structure.md)
