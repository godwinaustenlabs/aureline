# 07 — D1 export and retention pruning

**What to build:** Every settled run — completed or failed — is exported to D1 immediately, and DO-local **completed** runs are pruned once more than 5 exist, independent of whether the run's data came from stubs or real model calls.

**Blocked by:** 03

**Status:** ready-for-agent

**Team:** Database Team

**Two decisions already settled, so nobody has to guess:** the retention limit counts **runs, not rows** — keep the 5 most recent completed `p_invoc_id`s, up to 10 rows, so a run is never half-pruned. And **failed runs are exported to D1 but never pruned**, so failure history reaches the durable store and the local rows stay available for debugging; the accepted trade-off is that DO storage grows with failure count.

Ordered roughly by dependency — nothing below can be verified until the D1 table exists.

- [x] D1 database for `agent-helios` is provisioned (Database team infra, per this ticket) — **Hashir Rauf** — done: `helios-d1`, id `fa6c2552-c844-4c9b-8730-8e3108aa4cc8`, bound in `wrangler.jsonc`
- [ ] The D1 table is created. `wrangler.jsonc:44` points `migrations_dir` at `../../infrastructure/d1/migrations` and **that directory is not in the repo** — create it with a migration for `helios_runs` matching `db/schema.ts`, primary key on `id` — **Hashir Rauf** (data-layer conventions/architecture)
- [ ] D1 writes live in `repository/d1.repository.ts` (exists, empty) and pruning lives in `repository/do.repository.ts` alongside the existing write functions; `pipeline.ts` calls them and holds no Drizzle or D1 statements. Ticket 03 skipped naming its target file and needed a follow-up refactor to undo it — **Arham Zahid** (pipeline persistence)
- [ ] On a run settling, its `helios_runs` row(s) are exported to D1 immediately (no batching/queue), same shape as the DO-local table — **Arham Zahid**
- [ ] Export is idempotent — a retry or re-export must not double-insert, relying on the `id` primary key rather than on the caller being careful — **Arham Zahid**
- [ ] A failed D1 export is logged and does not fail the run. Export is an audit concern; the caller still gets their result. Follow the pattern `runPipeline`'s cleanup already uses: inner `try/catch`, `console.error`, carry on — **Arham Zahid**
- [ ] DO-local completed runs are pruned once the completed-run count exceeds the retention limit, oldest first, whole runs only — **Arham Zahid**
- [ ] The retention limit is read from `env.RETENTION_LIMIT` (already `"5"` in `wrangler.jsonc:70`), not hardcoded. Two sources of truth on day one is how they drift — **Arham Zahid**
- [ ] Pruning happens only after the export is confirmed written. The wrong order deletes DO rows that never reached D1 — silent data loss, found much later or never — **Arham Zahid**
- [ ] Exported rows are read back from D1 by query and verified. Ticket 03's equivalent box was ticked on a hand-run SQLite query with no read path in code; do not repeat that — **Hashir Rauf** (review gate)
- [ ] Verified against rows produced with stubbed data (no dependency on tickets 05/06 — this can run in parallel with real model integration) — **Hashir Rauf** (review gate)

**Verification is free right now.** The pipeline stages are still stubs, so this whole ticket can be exercised end to end without a single Workers AI call. Do it before tickets 05/06 make every test request cost quota.
