# 03 — `helios_runs` schema and DO-local persistence

**What to build:** Triggering the pipeline (still with stubbed planner/image output from ticket 01) writes and reads correct audit rows in DO-local SQLite. This is the persistence half of the day-7 checkpoint.

**Blocked by:** 01

**Status:** ready-for-agent

**Team:** Database Team, with AI Team support on verification

- [ ] `db/schema.ts` defines `helios_runs`: `id, p_invoc_id, modality (text|image), status (running|completed|failed), user_prompt, planner_params (JSON), image_r2_key, cost_usd, model_metadata (JSON), created_at, completed_at` — table name prefixed `helios_` (ADR-0003) — **Hashir Rauf** (data-layer conventions/architecture)
- [ ] `services/pipeline.ts` writes one `modality: text` row and one `modality: image` row per invocation, sharing a `p_invoc_id` — **Arham Zahid** (pipeline persistence)
- [ ] The `modality: image` row duplicates `planner_params` from its sibling `text` row (ADR-0001) rather than requiring a join — **Arham Zahid**
- [ ] Rows are written to DO-local SQLite via Drizzle with the `durable-sqlite` adapter, readable back correctly — **Arham Zahid**

**`cost_usd` now has a source (ADR-0006).** Workers AI returns `usage.neurons` in the response body — confirmed against a text model through the `helios` gateway. Cloudflare bills at $0.011 per 1,000 neurons, so `cost_usd = neurons / 1000 * 0.011`. Put the rate in `vars`, not in code — it is a published price that will drift. Whether Flux Schnell returns a `usage` block is **not yet confirmed**, so the image row may still write `null`; carry the raw `neurons` count in `model_metadata` either way so it can be backfilled without a schema change.

**`model_metadata` JSON shape:** per-modality, not shared (ADR-0001) — the `text` row and `image` row on the same `p_invoc_id` each get their own shape below. Both carry raw usage counts so `cost_usd` can be backfilled later without a schema change (see spec's cost-tracking note).

```jsonc
// modality: text  (GPT-OSS-120B via ticket 05)
{
  "model": "gpt-oss-120b",
  "provider": "openai",
  "temperature": 1,
}

// modality: image  (Flux Schnell via ticket 06, ADR-0004)
{
  "model": "flux.1-schnell",
  "provider": "black forest labs",
  "width": 1024,
  "height": 1024,
  "steps": 4,
  "seed": 0, // random
}
```

Ticket 01's stub output should populate these shapes with placeholder/zero values so tickets 05/06 only need to fill in real numbers, not change the shape.
