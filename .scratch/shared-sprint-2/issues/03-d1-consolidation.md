# shared-03: Consolidate the three D1 databases into one

**What to build:** move `helios_runs`, `iris_runs` and `atlas_runs` into a single D1 database, so a full-pipeline view is one query instead of three reads stitched together in application code.

**Objective:** each engine got its own D1 database for the length of the sprint, on purpose. A shared database would have been nicer to query, but applying a migration against a shared live database is not something you can rehearse the way a branch merge can be rehearsed with `git merge-tree`, and two squads both adding tables to one database during active parallel work is exactly the kind of shared mutable resource that caused sprint 1's worst incidents. That reasoning holds during the sprint and stops holding after it. Once no new migrations are being written, the consolidation is a single deliberate coordinated step, and it is the step that turns three tables that happen to share a database into three tables that tell one connected story.

**Final result:** one database, three prefixed tables, and one query that returns a whole pipeline run with its total cost.

**Blocked by:** both engines' tables being stable, meaning no open ticket in either backlog that would add or change a column. This is the last ticket in both sprints. Do not start it early.

**Status:** blocked until both sprints are otherwise done.

**Owner:** jointly, Maaz Bin Asif and Maaz Ahmad, with Saad Naik on the migration apply. One named holder, **to be filled in when it unblocks.**

## Read this first

- `docs/sprint-2-3-conventions.md`, the two paragraphs explaining why the databases are separate now and why they get merged later. That is the reasoning this ticket carries out.
- ADR-0003, for why every table is prefixed per engine. That prefix is what makes this consolidation possible at all: three tables named `runs` could not share a database.
- `apps/agent-helios/src/repository/d1.repository.ts` and each engine's equivalent. Note that each has its own `MAX_ROWS_PER_INSERT`, computed from its own column count. Those numbers do not change here.
- `.scratch/shared-sprint-2/issues/02-iris-atlas-wiring.md`, which has the three-read stitched query this ticket replaces with a join.

## Decisions

1. **Stand up one fresh database and migrate all three into it, rather than moving two tables into Helios's existing one.** A fresh database means the migration history starts clean and the same procedure applies to all three engines instead of two of them being special. Helios's existing `helios-d1` becomes read-only history until it is confirmed unneeded.
2. **The table prefixes stay** (ADR-0003). They were there to avoid colliding with the Agents SDK's `cf_agents_*` and `__cf_*` tables, and they now also keep the three engines' tables distinguishable in one place. Do not rename anything.
3. **No schema changes in this ticket.** Not a shared parent table, not a normalised cost table, not a foreign key between the three. Moving data and changing its shape at the same time means a failure could be either, and this is the one ticket where a mistake is hard to undo. If a schema improvement is worth doing, it is its own ticket after this one.
4. **Copy, verify, then switch, then delete. In that order, with the delete last and separate.** The old databases stay intact and readable until the new one is confirmed correct. This is the same discipline as ADR-0010's export-before-prune, applied one level up.
5. **`source_p_invoc_id` is what this ticket is for.** It is already on Iris's and Atlas's rows, carrying the upstream run forward one hop each. Consolidation turns those columns from something a human stitches together into a real join. If that column is null anywhere, this ticket has found a bug and stops until it is fixed.
6. **Every engine's `wrangler.jsonc` changes in one coordinated pass, and all three deploy together.** A half-switched state where two engines write to the new database and one writes to the old is a split history that nobody notices for days.
7. **Write the ADR.** This decision rejected a real alternative twice, first choosing separate databases during the sprint and then choosing to merge them after. Both halves of that reasoning belong in `docs/adr/shared/`, per shared-04's scheme, because ticket files are not where anyone looks in six months.

## Work

### Before touching anything

- [ ] Confirm no open ticket in either backlog would add or change a column in any of the three tables. If one exists, this ticket waits. (**owner**)
- [ ] Confirm `source_p_invoc_id` is non-null on every row in `iris_runs` and `atlas_runs`. A null means the chain is broken somewhere upstream, and consolidating would preserve the break rather than reveal it (decision 5). (**owner**)
- [ ] Record the row count of each of the three databases. That number is the verification target and it is much harder to reconstruct afterwards. (**owner**)

### The move

- [ ] Create the new D1 database. Name it for the platform rather than for an engine, so the next engine does not need a fourth. (**Saad Naik**)
- [ ] Decide where the shared migrations live. Today each engine generates into `infrastructure/d1/migrations/<engine>/` from its own `drizzle.d1.config.ts`. Either they all continue generating into their own directory against the same database, or there is one shared migrations directory. Pick one and write down why, because this is the decision the next engine inherits. (**owner**, with **Saad Naik**)
- [ ] Apply all three tables' migrations against the new database. (**Saad Naik**)
- [ ] Copy the data across, one table at a time, verifying each row count before moving to the next. Do not do all three in one script that reports success at the end. (**owner**)
- [ ] Confirm the copy is idempotent, so a partway failure is safe to rerun. Each engine's export already relies on `onConflictDoNothing` against a DO-generated primary key, and the same property should hold here. (**owner**)
- [ ] Do **not** delete the old databases in this ticket (decision 4). Note in the ticket when they can go, and who will do it. (**owner**)

### The switch

- [ ] Update all three `wrangler.jsonc` files' `d1_databases` entries to the new `database_id`, in one change, and deploy all three together (decision 6). (**Saad Naik**)
- [ ] Run `npm run cf-typegen` in each app and commit the regenerated `worker-configuration.d.ts`. `wrangler types` types vars as literals, and a stale file will reject the new config. (**Saad Naik**)
- [ ] Verify each engine still exports correctly after the switch, by doing one real run per engine and confirming its rows land in the new database. (**owner**)

### The payoff

- [ ] Write the full-pipeline query as a real join across the three tables and put it in `docs/`. This is the thing the whole ticket is for, so it is not optional and it does not live only in a commit message. (**owner**)
- [ ] Write the ADR (decision 7). It states why separate during the sprint and why merged after, and it names what would have to change for the answer to be different. (**owner**)
- [ ] Update `docs/sprint-2-3-conventions.md`'s Cloudflare table, which currently tells a new engine to create its own database. After this ticket that instruction is wrong, and a stale convention doc is worse than none. (**owner**)

### Review gates

- [ ] Compare the row counts recorded before the move against the new database, per table. They must match exactly. (**the manager who does not own it**)
- [ ] Run the full-pipeline join on a real chain and confirm it returns what the three-read version returned. (**the manager who does not own it**)
- [ ] Confirm all three engines write to the new database and none still writes to an old one, by doing a run per engine and checking. (**Saad Naik**)
- [ ] Confirm the old databases are still intact and were not deleted (decision 4). (**Saad Naik**)
- [ ] Nobody approves their own work. (**both managers**)

## Verification without burning budget

**Budget: three runs, one per engine, roughly a cent.** Everything else is SQL against data that already exists.

1. Row counts match, per table, before and after.
2. `npx wrangler d1 execute <new-db> --remote --command "<the full-pipeline join>"` returns a complete chain for a real run.
3. One real run per engine lands in the new database.
4. The old databases still respond to a `SELECT COUNT(*)`.

## Two things that will waste your afternoon

**Switching one engine at a time splits the history and nothing complains.** Two engines writing to the new database and one still writing to the old produces a chain with a missing middle, and every query looks like it worked. The three `wrangler.jsonc` edits go in one change and deploy together, and this is the reason.

**Doing a schema improvement at the same time as the move makes a failure undiagnosable.** If rows are missing afterwards, you need to know whether the copy dropped them or the new shape rejected them, and if you changed both you cannot tell. Decision 3 exists because this is the one ticket in the sprint where a mistake is genuinely hard to walk back.
