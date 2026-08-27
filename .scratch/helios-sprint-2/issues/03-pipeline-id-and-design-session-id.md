# helios-03: pipeline_id, design_session_id, and object parameters

**What to build:** rename Helios's `p_invoc_id` to `pipeline_id`, add a required `design_session_id`, and convert every row-opening function to take one object instead of a line-up of positional strings.

**Objective:** Helios is the last engine still naming its run id `p_invoc_id`, and the only one with no cross-engine design id at all. Iris and Atlas both carry `pipeline_id` + `design_session_id`, so today a design cannot be traced back through Helios. The object-parameter half is the compile-time guard that makes the rename safe: adding a third adjacent string to functions that already take two is how the original incident became possible.

**Final result:** a Helios run answers to the same two ids as an Iris or Atlas run, a request without `design_session_id` is rejected with a 400, and swapping two fields at a call site is a compile error.

**Blocked by:** helios-02. Without the typed test database the rename produces silence at every test call site instead of errors.

**Status:** not started.

**Owner:** Maaz Bin Asif. **Reviewer:** to be assigned.

**Duration:** 2 days. **Scheduled:** Mon Aug 31 to Tue Sep 1.

## Read this first

- `prompt.md`, problems 2 and 3.
- `AGENTS.md` §3 for the three ids, §6 for the parameter rule, §8 for the migration rule.
- `origin/dev:packages/shared-types/src/v1/iris.ts:66-77` — the reasoning comment on Iris's required `design_session_id`, to be adapted rather than reinvented.

## Decisions

1. **Clean break on the data.** Both `0000` migrations are regenerated from `schema.ts`, not extended with a `0001`. Helios's audit rows are disposable and `design_session_id` is `NOT NULL` with no default, which SQLite cannot add to a non-empty table anyway. This is what the Iris rename did.
2. **`MAX_ROWS_PER_INSERT` drops from 9 to 8.** It is derived from the column count: 11 columns became 12, and `12 x 9 = 108` exceeds D1's 100-parameter cap. This is the most dangerous line in the change, because `exportAndPrune` swallows the failure and every run still returns `completed` while nothing reaches D1. Re-derive the arithmetic in the comment; do not just edit the number.
3. **No alias for the old name.** A request missing `design_session_id` is a 400. Helios will not mint one and will not accept `p_invoc_id` as a synonym. Keeping the old name "just in case" is how the confusion started.
4. **`completeTextRun` and `failRunningRuns` stay positional.** Their arguments are of distinct types, so §6 does not bite. Iris made the same call.
5. **The frontend is out of scope.** `apps/frontend` on `dev-atlas` already reads `design_session_id` off Helios results and mints one it cannot send. That is the Atlas squad's branch and their follow-up.
6. **`HeliosResult` stays an interface.** Converting it to a zod schema the way `IrisResultSchema` is done is a real improvement and is not this ticket. Note it and move on.

## Checklist

- [ ] `schema.ts` renamed, `design_session_id` added as the third column
- [ ] both migrations regenerated, neither hand-edited, `HELIOS_RUNS_DDL` updated in the same commit
- [ ] `MAX_ROWS_PER_INSERT` re-derived to 8 with the arithmetic in the comment
- [ ] `RowSeed` added; the five row-opening functions and `runImageStage` converted
- [ ] `HeliosRequestSchema` requires `design_session_id`; resume schema and `HeliosResult` renamed
- [ ] the query-string key, the R2 key comment and the shared `aiGateway.ts` comment updated
- [ ] `tests/run-concept.ts` annotated with the real `HeliosParams`
- [ ] `docs/helios-runs-conventions.md` gains the two-ids section
- [ ] `docs/adr/helios/0001-*.md` records the rename and the clean break
