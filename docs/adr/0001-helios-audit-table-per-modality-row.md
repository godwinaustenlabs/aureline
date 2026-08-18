# Helios's audit table is one row per modality, not one row per pipeline invocation

Helios's pipeline invokes two distinct models per run (a textual planner, then an image generator), each with its own status, cost, and model metadata. We considered a single wide row per pipeline invocation (one `status`/`cost_usd`/`model_metadata` set covering both calls) but rejected it — it can't cleanly represent "planner succeeded, image generation failed" as one row's status, and conflates two different models' cost/metadata into one field.

Instead, `helios_runs` stores one row per model call, tagged `modality: text | image`, with a shared `p_invoc_id` linking the rows belonging to the same pipeline invocation. The image row duplicates `planner_params` (rather than requiring a join back to the text row) so it's independently inspectable — the duplication cost is a small JSON blob, acceptable for the query convenience it buys.

This is the reusable template for every future engine's audit table (per the `agent-helios`-as-template decision), so the shape matters beyond Helios alone.
