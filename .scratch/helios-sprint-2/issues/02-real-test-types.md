# helios-02: Real test types

**What to build:** delete all 74 type escapes from Helios's test suite, give `createTestDb` the real `HeliosDb` return type, and add the shared fixtures and fake `Env` the suites currently rebuild by hand.

**Objective:** casting one argument turns off type checking for the whole call, so a test can claim to check a shape while checking nothing. Helios has 65 `as never` and 9 `as unknown as`, and nearly every one launders the test database past a driver-type mismatch. Until they are gone, the rename in helios-03 lands as silence instead of compile errors, which is exactly how the bad schema shipped in Iris.

**Final result:** feeding a Helios repository function the wrong shape fails to compile, and the only casts left in `apps/agent-helios/src` are the documented boundary ones in `test-db.ts`.

**Blocked by:** helios-01, for ordering only. Nothing in it conflicts.

**Status:** not started.

**Owner:** Maaz Bin Asif. **Reviewer:** to be assigned.

**Duration:** 1 day. **Scheduled:** Fri Aug 28 to Fri Aug 28.

## Read this first

- `prompt.md`, problem 1.
- `AGENTS.md` §4 and §5. §5's "Yes" example is itself stale and still writes `pInvocId`; do not copy it verbatim.
- `origin/dev:apps/agent-iris/src/repository/test-db.ts` — the 185-line version, and the model for this ticket.

## Decisions

1. **One cast per fake, at the return, with the reason in the function's doc comment.** Not one per call site. A `D1Database` and a `durable-sqlite` driver genuinely cannot be constructed outside a Worker; that is the legitimate exception §4 allows, and it is spent once.
2. **The DDL is hoisted to a module const.** Two fakes with two copies doubles the thing that can silently drift from `schema.ts`, and nothing enforces the match (§8).
3. **`createTestD1` really writes.** Helios's current `fakeD1()` is a no-op, and `exportAndPrune` swallows what it catches by design, so today the export path is untested and would stay green if it never exported anything at all. This is what makes helios-03's chunk-size change testable.
4. **The two deliberate escapes are rewritten, not deleted.** `pipeline.test.ts`'s invalid `repeat_type` is a real schema-boundary case and becomes a test that the wrong shape is *rejected* (§5). `config.test.ts`'s absent-var case gets a restructured fixture.
5. **These files get touched again by helios-03.** Accepted. Doing the rename first would produce no compile errors at these call sites, which is the whole reason this ticket comes before it.

## Checklist

- [ ] `createTestDb(): HeliosDb`, with the single documented cast
- [ ] `HELIOS_RUNS_DDL` hoisted, checked against `schema.ts` including the `created_at` unit
- [ ] `createTestD1` and `createFailingD1` added
- [ ] `src/fixtures/sample-params.ts`, both fixtures annotated `HeliosParams`
- [ ] `src/services/test-env.ts` replaces the per-suite fake `Env`
- [ ] zero `as never` / `as any` / `as unknown as` / `@ts-ignore` outside the documented casts
- [ ] a test proving a wrong-shaped params object is rejected
