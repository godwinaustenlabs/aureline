# How an engine works

The high level view. Read this first, then [flows.md](flows.md) for the step by step detail.

## What Aureline is

Aureline turns a textile design concept, something like "art deco paisley with fine linework", into a production ready design. It does that with **engines**: small, independently deployable specialists that each own one part of the problem.

Only one engine exists today.

| Engine | Owns | Status |
|---|---|---|
| **Helios** | Pattern. Motif, repeat, scale, density, linework. Black and white only. | Built |
| Iris | Colour, entirely | Named, not built |
| Atlas, Orpheus, Arachne, Vulcan | Materials and production concerns | Named, not built |
| Athena | Orchestration. Splits a brief and delegates to the specialists. | Named, not built |

Helios has no colour parameter of any kind, on purpose. Colour is Iris's whole job, and a pattern engine that also guessed at colour would make Iris's job harder rather than easier. See [ADR-0002](adr/0002-helios-outputs-black-and-white-patterns-only.md).

The two things deliberately missing are an **api-gateway** (there is nothing to route yet, Helios is the only engine) and **Athena**. Both are waiting on a second consumer to justify the indirection.

## What one engine is made of

An engine is a Cloudflare Worker with a Durable Object inside it, and four layers:

```
  HTTP request
       |
  [1]  index.ts            Worker entry. Routing only.
       |                   Picks which Durable Object handles this.
       v
  [2]  agent.ts            The Durable Object. Validates the body,
       |                   calls a service, returns JSON.
       v
  [3]  services/           The actual work. Orchestration, model calls,
       |                   prompt building, cost reading.
       v
  [4]  repository/         Storage. Every read and write to
                           DO SQLite, D1, and R2 lives here.
```

The layers are only worth having if they hold, so three rules do the enforcing:

- **Routing lives only in `index.ts`.** Nothing else looks at a URL or decides where a request goes.
- **Storage access lives only in `repository/`.** No service builds SQL or touches a bucket.
- **KV reads live only in `config.ts`.** One read per invocation, one place that knows the keys exist.

If you are adding a file and cannot tell which layer it belongs to, that usually means it is doing two jobs.

## Why there is a Durable Object at all

This is the load bearing idea, and it is the one thing worth understanding properly.

A design session is **stateful and long lived**. Someone works on a brief, generates a pattern, does not like it, tries again, comes back the next day. A plain Worker cannot hold any of that: it spins up per request, has no memory, and there is no "the same worker" to come back to.

A Durable Object can. It is a single object with a stable address and its own private SQLite database, and Cloudflare guarantees there is only ever **one** of it for a given name, anywhere in the world.

**How the address works.** The Worker calls `getAgentByName(env.HeliosAgent, key)` where the key comes from `scopeKey()` in `src/index.ts`, which reads `session_id` off the request body and falls back to the literal string `"default"`. Underneath, that name is put through a deterministic hash. Same string in, same object out. Always, globally, no matter how much time has passed between requests.

Two consequences that surprise people:

- **It is case sensitive and exact.** `"my-session"` and `"My-Session"` are two different objects with two different databases. There is no fuzzy matching and no normalisation.
- **The object can be evicted while its storage survives.** Cloudflare shuts down an idle Durable Object's running code. When the next request arrives it starts fresh and `onStart()` runs again, which is exactly why migrations live there. But `ctx.storage` is on disk and comes back untouched. So "the object went away" and "the data went away" are completely different things, and only the first one happens.

**One object per session, not per request and not one global one.** One global object would be a bottleneck and would grow forever. One per invocation would be useless, because Durable Objects cannot be listed or enumerated, so you could never find yesterday's run again. Per session is the middle that works, and it is what makes a retention rule meaningful: one object accumulates a session's history, so there is something to retain. [ADR-0005](adr/0005-helios-do-instance-scoped-to-session.md) has the full argument.

**The invocation id is not the object id.** Every call to `/generate` mints its own `pipeline_id` in `pipeline.ts`. Two requests with the same `session_id` land on the same object and still get different invocation ids. The object is *where* the work happened, the invocation id is *which* work it was.

## Four stores, and why four

An engine writes to four different places, and each exists because the others cannot do its job.

| Store | Binding | Holds | Lifetime |
|---|---|---|---|
| **DO SQLite** | `HeliosAgent` | This session's recent runs | Pruned to the newest few |
| **D1** | `DB` | The permanent audit copy of every run | Forever |
| **R2** | `PATTERNS` | The generated image bytes | Until deleted by hand |
| **KV** | `CONFIG` | Runtime config you can retune | Until edited |

**DO SQLite is fast and private and small.** It sits inside the object, so reads are local with no network hop. But it belongs to one session, and you cannot query across sessions or even list which sessions exist. So it is the hot working set, not the record.

**D1 is the record.** It is a normal queryable database, so "what did we spend last month across every session" is one SQL statement. Runs are copied there as they settle, and it is never pruned.

Those two use **the same schema definition**, in `src/db/schema.ts`, compiled to two sets of migrations. See [database.md](database.md) for how that works and why export always runs before pruning ([ADR-0010](adr/0010-export-the-whole-do-before-pruning-any-of-it.md)).

**R2 holds the bytes.** Images are large and binary and do not belong in a row. The database stores the key, `patterns/{pipeline_id}.jpg`, and the key is derived from the invocation id rather than random, so you can always find an object again without a lookup.

**KV holds config.** Which model, how many retries, how many runs to keep. These are policy, not code, and putting them in KV means changing one from the Cloudflare dashboard takes effect in about a minute with no deploy. `resolveConfig()` reads all of them in one batched call per invocation and **never throws**: a missing key, a bad value, or KV itself being down all fall back to the committed value in `wrangler.jsonc` and log a warning. A typo in a dashboard must not be able to take the service down. [ADR-0008](adr/0008-runtime-config-resolved-from-kv.md).

## Every model call goes through AI Gateway

No service calls Workers AI directly. Every call passes a gateway config as `ai.run`'s third argument, built by `buildAiRunOptions` in `packages/shared-utils`.

The reason is money. **The Gateway is the only source that reports dollars.** A model's own reply gives you either nothing at all (Flux returns no usage) or provider side neuron counts (the planner). Converting neurons to dollars ourselves would mean hardcoding a Cloudflare price that goes quietly wrong the day they change it. So `readGatewayCost()` in `src/services/gatewayCost.ts` asks the Gateway what the call actually cost, and that is what lands in `cost_usd`.

You also get request logging and caching out of it, but cost is the reason it is not optional. [ADR-0006](adr/0006-all-model-calls-route-through-ai-gateway.md).

One trap worth knowing now: if the gateway id is empty or misspelled, `buildAiRunOptions` returns `undefined` and the call goes **straight to Workers AI and succeeds**, with no error and no log entry. That is why `AI_GATEWAY_ID` is a committed var rather than a dashboard tunable, and why `planner.ts` warns when `env.AI.aiGatewayLogId` comes back empty. That warning is the only signal it happened.

## Retry is decided per stage, not per pipeline

An engine has two model calls and they fail in completely different shapes, so they get completely different policies.

**The planner retries itself.** It is asked for structured output and sometimes returns prose, or nearly right JSON, or good JSON with one enum value the schema rejects. Asking again usually works, because the model wandered rather than the request being wrong, and each attempt costs about a tenth of a cent. The loop lives in `getTextualModelOutput` and is bounded by `max_retries`.

**The image stage never retries automatically.** A Flux call that failed usually fails again for the same reason, and each attempt is the expensive half of the invocation. An automatic retry there is a loop spending real money on a request there is no reason to think will behave differently.

So the image stage's retry is **a person**, and `POST /resume` is the mechanism. It reuses the params the planner already produced and runs only the image half, which is cheaper than starting over and gives the caller the same params they already saw. Because a person can also be a loop, `max_resume_attempts` caps how many times one brief may be retried. [ADR-0009](adr/0009-retry-policy-is-per-stage-not-per-pipeline.md), and the walkthrough is in [flows.md](flows.md).

## A failed run is kept, not cleaned up

This is a deliberate stance and it explains several things that otherwise look odd.

When an invocation fails, the rows describing the failure are written and kept. `pruneCompletedRuns` will delete old *successful* runs but never touches a failed one. The failed run is the thing you came back for: it is what you inspect, and if the planner half succeeded, it is what you resume from.

That is also why the image stage goes out of its way to leave a row behind even when it could not open one. Without that rescue, a failed invocation would look like a lone completed text row and get pruned like a success, and the audit trail would quietly say everything was fine.

## Engines stay isolated from each other

Each engine gets its own Worker, its own Durable Object class, its own D1 database and its own R2 bucket. Nothing is shared except the two `packages/`, which are types and model helpers with no state in them.

That is a blast radius decision. A bad migration, a runaway loop or a bad deploy in one engine cannot reach another. The cost is some duplication, and it is worth it.

Within a single Durable Object there is one more piece of housekeeping. The Agents SDK keeps its own tables (`cf_agents_*`, `__cf_*`) in the same SQLite database as ours, so every application table is prefixed with the engine name: `helios_runs`, and `iris_*` or `atlas_*` when those arrive. [ADR-0003](adr/0003-helios-tables-prefixed-to-avoid-agents-sdk-collision.md).

**How engines will connect, when there is more than one.** Athena holds the design session and passes the same `session_id` to each engine it calls. Each engine hashes that same string inside its **own** Durable Object namespace, so the names line up while the storage stays separate. D1 is the shared read path, because every engine exports there. Nothing about today's addressing has to change for that to work.

## Where to go next

- The exact primitives, bindings, routes and schemas: [spec.md](spec.md)
- How the data is laid out: [database.md](database.md)
- What a request actually does, step by step: [flows.md](flows.md)
- What lives in which file: [directory-structure.md](directory-structure.md)
