# 08 — Failure handling

**What to build:** A mid-pipeline crash (planner or image call throwing) leaves a retained, inspectable record instead of silently losing state or auto-retrying.

**Blocked by:** 03, 07

**Status:** ready-for-agent

**Team:** Database Team

- [ ] Forcing the planner or image-generator call to throw mid-pipeline results in its `helios_runs` row set to `status: failed` — **Arham Zahid** (pipeline persistence, error handling)
- [ ] Partial state (e.g. a successful planner output when only the image call failed) is retained, not deleted — **Arham Zahid**
- [ ] Failed rows are excluded from the ticket-07 pruning logic — they are never automatically pruned — **Hashir Rauf** (touches ticket-07 pruning code — review gate)
- [ ] N automatic retry occurs on failure using a binding — **Hashir Rauf** (review gate)
