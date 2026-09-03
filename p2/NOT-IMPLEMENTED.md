# What is not implemented, and why

Everything in Phase 2 is built **for Helios**. The Iris half is not, and this file is why.

Short version: Iris's research stage depends on Iris knowing the classification Helios decided. **There is no way for Iris to learn it, and the mechanism the plan names does not exist.** That is not a missing afternoon of work — it is a new route, a new query, a new binding and an ADR.

---

## 1. Not built

| | Status |
|---|---|
| `apps/agent-iris/src/services/research.ts` | not built |
| `apps/agent-iris/src/prompts/research.prompt.ts` | not built |
| `iris_research` prompt slot | not added |
| `ai_search` binding on Iris | not added |
| `iris-planner-v3` (a `constraints` parameter) | not built |
| `iris-color-v4` (mode clauses) | not built |
| Helios → Iris classification transport | **does not exist, and is the blocker** |

Iris **did** get the six research config keys (`77e1a3a`), so its config surface matches Helios's. They are inert.

---

## 2. Why: the transport does not exist

`P2.md` T3 and `phase-2-plan.md` §3 both say Iris "reads the classification from Helios's runs via the shared `design_session_id`". A colleague's summary of the phase puts it as *"make Iris parse and get this classification result from Helios `/runs`"*.

That reads like a parse. It is not. Four things are missing, and each is independently blocking.

### a. Helios's `/runs` cannot be queried by `design_session_id`

```ts
// apps/agent-helios/src/agent.ts:37
const pipelineId = url.searchParams.get("pipeline_id")?.trim();
return json({ runs: pipelineId ? await getRunRows(db, pipelineId) : await listRuns(db) });
```

It takes **`pipeline_id` only**. Iris never sees Helios's pipeline id — it receives a `design_session_id`, which is a different identifier for a different thing (AGENTS.md §3). The repository has no query by design session either: `do.repository.ts` exposes `getRunRows(db, pipelineId)` and `listRuns(db)`, and nothing else.

**Needs:** a new route parameter and a new repository function.

### b. `/runs` is Durable-Object scoped, and Iris does not know the scope

```ts
// apps/agent-helios/src/index.ts:42-49
const agent = await getAgentByName(env.HeliosAgent, await scopeKey(request));
```

`/runs` reads one Durable Object's own SQLite. Which DO answers depends on the caller's `session_id`. Iris is never told Helios's `session_id` — `IrisRequestSchema` carries Iris's own, for routing Iris's DO.

So even with a working query, Iris would be asking the wrong Durable Object and getting an empty list — a silent wrong answer, not an error.

**Needs:** either the Helios `session_id` threaded to Iris, or the read moved to D1, which every settled run is exported to and which is not DO-scoped.

### c. Iris has no way to call Helios at all

Checked across `apps/agent-iris`:

- no `services` block in `wrangler.jsonc` — no service binding
- no `HELIOS_DB` — each engine keeps its own D1 for the sprint, stated in `wrangler.jsonc:54-60`
- no outbound `fetch` to any origin anywhere in the app
- no `HELIOS_URL` var

Iris's only shared surface with Helios is the R2 bucket, which carries image bytes and nothing else.

**Needs:** a new binding, plus regenerated `worker-configuration.d.ts`, plus a fake for it in `services/test-env.ts`.

### d. It contradicts an ADR, so it needs one of its own

Cross-engine reads are a new architectural shape for this repo. AGENTS.md §1: a change that contradicts an ADR needs the contradiction argued out loud, not slipped in. `wrangler.jsonc:54-60` records the current decision — one database per engine, consolidation deferred to a joint ticket.

---

## 3. What was decided instead

**Iris does nothing this phase.** Iris runs exactly as it did before Phase 2. Nothing was half-built and left for someone to trip over.

Two things follow from that, and are the reason `iris-planner-v3` and `iris-color-v4` are also absent:

- `iris-planner-v3` only adds a `constraints` parameter. With no Iris research, nothing would ever fill it.
- `iris-color-v4` adds mode clauses. With no classification reaching Iris, there is no mode to select on.

Both would have been dead code — the same argument that removed the dead `helios_image` prompt slot and left `classifier_model` off Iris's config.

**The one thing that was deliberately *not* done:** make `classification` optional on Iris with a `{ mode: "tile" }` default. That produces a run that looks entirely normal, grounded on a guess, with an audit row recording a classification nobody made. It is the exact failure class AGENTS.md §7 exists to prevent, and it would be undetectable from the outside.

---

## 4. If you pick this up

Three transports, cheapest first.

### Option 1 — the playground passes it *(recommended)*

The frontend already holds the `design_session_id`, already reads Helios's runs, and already parses `classification` off them (`domain/runView.ts`, `readClassification`). Add `classification` as an optional field on `IrisRequestSchema` and send it.

- **Cost:** one schema field, one form field, no new infrastructure.
- **Blocker:** `phase-2-plan.md` §6.3 says "no request-schema change". That was written about Helios's *classifier input* — the concept text carries the mode signal — and is not obviously about Iris's *classification input*. Relaxing it needs saying out loud, not assuming.
- **Weakness:** the classification is client-supplied, so it is only as trustworthy as the caller. Validate with `ClassificationSchema` on arrival.

### Option 2 — a read-only D1 binding

Bind Helios's D1 to Iris as `HELIOS_DB`, read-only, and query by `design_session_id`. The frontend already proves both databases can be bound to one worker (`apps/frontend/wrangler.jsonc` binds `IRIS_DB` and `HELIOS_DB`).

- **Solves (b) for free** — D1 is not DO-scoped and holds every exported run, where a DO holds only the last `retention_limit`.
- **Cost:** a binding, a repository query, an ADR superseding the one-database-per-engine decision.
- **Weakness:** a run is only in D1 after `exportAndPrune` has run, so a very fresh Helios run may not be there yet.

### Option 3 — a service binding Iris → Helios

A new `GET /classification?design_session_id=…` route on Helios, plus a service binding.

- **Cost:** the most work — a route, a repository query, a binding, an ADR, and it still has to solve (b).
- **Strength:** the only option where Helios stays the authority on its own data.

Whichever is chosen, `apps/agent-iris/src/services/research.ts` should take `classification: Classification` as a **required** parameter. It is fully testable that way, and a required parameter is what stops a default creeping back in.

---

## 5. Other things not done, and why

**Iris's dead `iris_color` prompt slot was not removed.** `phase-2-plan.md` §9.1 removes it as dead, and it is. But removing it is Iris work, and Iris is out of scope — doing it here would have meant touching Iris's schema for a reason unrelated to anything else in the change. Helios's equally dead `helios_image` slot *was* removed, in the same commit that added Helios's new slots.

**No billed run has happened.** Everything is proved by tests, which make no model calls and touch no network. The vision + tools combination — the research model receiving `tools` and an `image_url` part in the same request — is the one genuinely unverified thing in the phase, and only a real call answers it. `phase-2-plan.md` §18 flags it too.

**The migrations are generated but not applied.** `wrangler d1 migrations apply helios-d1 --remote`, with the dev server stopped. The `classification` column exists in code, in both migration directories, and in no live database.

**HelioKB has no documents.** Retrieval is switched off (`research_model: ""`) for exactly that reason: with an empty index every run would make a billed research call, retrieve nothing, warn, and proceed.
