# 07 — D1 export and retention pruning

**What to build:** Completed runs are exported to D1 immediately on completion, and DO-local completed rows are pruned once more than 5 exist — independent of whether the run's data came from stubs or real model calls.

**Blocked by:** 03

**Status:** ready-for-agent

**Team:** Database Team

- [ ] D1 database for `agent-helios` is provisioned (Database team infra, per this ticket) — **Hashir Rauf**
- [ ] On a run's completion, its `helios_runs` row(s) are exported to D1 immediately (no batching/queue), same shape as the DO-local table — **Arham Zahid** (pipeline persistence)
- [ ] DO-local completed rows are pruned once the completed-row count exceeds 5, oldest first — **Arham Zahid**
- [ ] Verified against rows produced with stubbed data (no dependency on tickets 05/06 — this can run in parallel with real model integration) — **Hashir Rauf** (review gate)
