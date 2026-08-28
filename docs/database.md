# How data is stored

The design of persistence: which store holds what, how the schema reaches both of them, and what the rules are.

This is **not** a guide to querying the table. If you are writing SQL against `helios_runs` and want to know what the columns mean and where the traps are, go to [helios-runs-conventions.md](helios-runs-conventions.md). This file explains why the table has the shape it does; that one explains how to read it.

Examples are from `apps/agent-helios`.

## Three stores hold state

| Store | What is in it | Pruned? |
|---|---|---|
| DO SQLite | This session's recent runs | Yes, to `retention_limit` |
| D1 | Every run ever, permanently | Never |
| R2 | The generated image bytes | Never automatically |

KV holds config and no state, so it is not in this list. See [spec.md](spec.md#runtime-config).

## One schema, two databases

`src/db/schema.ts` defines the `helios_runs` table exactly once. Two drizzle-kit configs compile it to two different places:

| Config | Target | Output |
|---|---|---|
| `drizzle.config.ts` | DO SQLite, driver `durable-sqlite` | `apps/agent-helios/drizzle/` |
| `drizzle.d1.config.ts` | D1 | `infrastructure/d1/migrations/` |

So after editing `schema.ts` you run **both**:

```bash
npm run db:generate      # DO SQLite migration
npm run db:generate:d1   # D1 migration
```

Forget the second one and the DO writes columns D1 has never heard of, and the export starts failing silently in the logs.

Two Drizzle client factories sit over the same schema, both in `src/db/client.ts`: `getDb(storage)` for the Durable Object and `getD1Db(env.DB)` for D1. They return different types (`HeliosDb` and `HeliosD1Db`) so it is hard to hand one to code expecting the other.

### The two stores apply migrations differently

This catches people out, so it is worth being explicit.

**DO SQLite migrates itself.** `onStart()` in `agent.ts` calls Drizzle's migrator every time the object wakes up. Durable Objects get evicted when idle and restarted on the next request, so this runs often, and Drizzle tracks what is already applied so repeats are harmless. **There is nothing to run by hand.** A brand new session gets its tables the moment its first request arrives.

**D1 migrates through wrangler**, the normal way, using the `migrations_dir` in `wrangler.jsonc`.

### Table names carry the engine's name

Every application table is prefixed: `helios_runs`, and `iris_*` or `atlas_*` when those engines exist.

That is not tidiness. The Agents SDK keeps its **own** tables (`cf_agents_*`, `__cf_*`) in the same SQLite database inside the same Durable Object. An unprefixed `runs` table is a collision waiting to happen with a library that can add tables in a minor version. [ADR-0003](adr/0003-helios-tables-prefixed-to-avoid-agents-sdk-collision.md).

## The audit model: one invocation is two rows

Every `POST /generate` and every `POST /resume` writes **two rows sharing a `pipeline_id`**, one `modality: "text"` and one `modality: "image"`. Every row also carries the `design_session_id` those runs belong to, which is what lets a whole design be read back across engines rather than one run of one of them (AGENTS.md §3).

Not one wide row per invocation. The two model calls are genuinely different events: they happen at different times, cost different amounts, succeed and fail independently, and carry completely different metadata. One wide row would mean half its columns were null on every row and a schema change every time a stage gained a field. One row per call means "what did the image model cost this month" is a filter, not a sum over nullable columns. [ADR-0001](adr/0001-helios-audit-table-per-modality-row.md).

**The image row duplicates `planner_params`** from its text sibling rather than joining to it. The duplication is on purpose: it means a failed image row is fully inspectable on its own, and the resume path can read everything it needs from one row.

**This holds on failure too.** There is one exception, and it is the only legal single-row invocation: a run that failed before the planner produced anything has a lone `failed` text row and no image row, because there was never any image work to record.

## The columns

| Column | Holds |
|---|---|
| `id` | UUID primary key, minted in the Durable Object |
| `pipeline_id` | This run of Helios. Two rows share it. A re-run gets a new one |
| `design_session_id` | The design, minted upstream and carried unchanged through every engine. Required on the request |
| `modality` | `text` or `image` |
| `status` | `running`, `completed` or `failed` |
| `user_prompt` | The caller's concept, copied onto both rows |
| `planner_params` | The validated `HeliosParams`, JSON. On both rows |
| `image_r2_key` | Set on a successful image row only. Always `patterns/{pipeline_id}.jpg` |
| `cost_usd` | Real dollars from the AI Gateway log. Nullable |
| `model_metadata` | JSON, shape differs by modality |
| `created_at` | Set on insert, defaults to `unixepoch()` |
| `completed_at` | Set when the row settles, on success **and** failure |

Two of these need more than a line.

**`planner_params` is a JSON column typed `unknown` when it comes back.** Always re-validate it through `HeliosParamsSchema` rather than trusting it. A row written under an older schema version has to fail loudly rather than quietly producing a nonsense image, and `resume.ts` does exactly that check before spending anything.

**`image_r2_key` is deterministic**, derived from the invocation id rather than random. That is what makes it possible to find an object again without a lookup, and it is why a future recovery for "R2 saved but the row update failed" can work at all.

The full meaning of `cost_usd` and `model_metadata`, including the traps, is in [helios-runs-conventions.md](helios-runs-conventions.md).

## Which status combinations are legal

`running` exists only mid-invocation. The pipeline is synchronous, so an HTTP response always carries a settled status and a `running` row in D1 would be a bug.

| text | image | What it is |
|---|---|---|
| `running` | absent | In flight, before the planner returned |
| `failed` | absent | The planner or its validation failed. Nothing to resume |
| `completed` | `running` | In flight, image being made |
| `completed` | `completed` | Success |
| `completed` | `failed` | The image failed. **This is what `POST /resume` recovers** |

Anything else is a bug worth reporting, in particular a `failed` text row sitting next to any image row.

## Retention

A Durable Object accumulates runs forever unless something stops it, so `pruneCompletedRuns` keeps only the newest `retention_limit` runs and deletes the rest.

Three properties of it matter:

- **It prunes whole invocations**, grouping by `pipeline_id`, so you never end up with an orphaned image row whose text sibling was deleted.
- **It only ever deletes fully completed runs.** A failed run is never pruned, at any age. The failure record is the thing you came back for, and it is what makes a resume possible days later.
- **It leaves `running` rows alone**, because a concurrent in-flight invocation is not garbage.

D1 is never pruned. It is the permanent record, and it is where "what happened last quarter" gets answered.

## Export always runs before prune

`exportAndPrune` in `services/pipeline.ts` copies settled rows to D1, and prunes **only if the export succeeded**.

The subtle part is that it exports **every settled row in the Durable Object**, not just the current invocation's. That looks wasteful and is not. Pruning deletes across the whole object, so exporting less than you prune leaves a gap: a run whose own export failed and was swallowed sits unexported until some *later* run's successful export prunes it away, and it is now gone from both stores. Doing both over the same set makes the rule exact. **Prune only ever runs once everything prunable is confirmed in D1.** [ADR-0010](adr/0010-export-the-whole-do-before-pruning-any-of-it.md).

`getSettledRows` deliberately excludes `running` rows, so a half-written row from a concurrent invocation can never be frozen into the permanent record.

The whole thing **never throws**. Export is an audit concern, and it should not cost the caller their result after they already waited for the pipeline. A failure logs and moves on.

## Exporting twice is harmless

`exportRuns` uses `insert().onConflictDoNothing()`, and that works because **`id` is minted in the Durable Object and travels with the row**. The same row exported twice carries the same primary key both times, so the second insert is a no-op.

The consequence to know: whichever version lands in D1 **first** is the version D1 keeps forever. That is why only settled rows are ever exported, and it is one reason a resume mints a new `pipeline_id` instead of rewriting the old run. By the time you resume, the failed rows are already in D1 and could not be updated even if you wanted to.

Inserts are chunked at 9 rows because D1 caps a statement at 100 bound parameters and the table has 11 columns.

## Images

`savePatternImage` in `repository/r2.repository.ts` is the only thing that writes to the bucket, under the key `patterns/{pipeline_id}.jpg`. `readPatternImage` is the only thing that reads, and `GET /images/*` in `index.ts` is its only caller.

Nothing deletes from R2. A pruned run's row disappears from the Durable Object while its image stays in the bucket, reachable by its key, and still referenced by the D1 copy of the row. That is deliberate for now, and it means bucket cleanup is a future job rather than a solved one.

## Where to go next

- Which step writes which row, in order: [flows.md](flows.md)
- Reading and querying the table: [helios-runs-conventions.md](helios-runs-conventions.md)
- Which file owns which query: [directory-structure.md](directory-structure.md)
