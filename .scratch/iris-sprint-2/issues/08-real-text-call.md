# iris-08: The real planner call, concept to palette

**What to build:** replace iris-05's fake `planConcept` with a real call to a text model that reads the concept and returns a validated `IrisParams`. Record what it cost and which model answered.

**Objective:** this is the stage that decides what colors a run uses. Everything after it is mechanical. It is also the cheap, recoverable half of Iris's pipeline, which is why it is the stage that gets automatic retries while the image call gets none. Doing it before iris-09 means the image call is developed against real palettes rather than a fixture, so a bad-looking result can be attributed to one stage or the other.

**Final result:** `POST /generate` with a real concept produces a real palette, validated against `IrisParamsSchema`, saved on a settled text row with its real dollar cost and the model that produced it. A concept that names no color still produces a usable palette.

**Blocked by:** iris-04 (the prompt and glossaries) and iris-05 (the pipeline to plug into).

**Status:** ready-for-human.

**Owner:** Ali Amir. **Reviewer:** Hashir Rauf.

## Read this first

- `apps/agent-helios/src/services/planner.ts` (49 lines) and `apps/agent-helios/src/tools.ts` (20 lines). Between them they are almost exactly this ticket, for a different schema. `tools.ts` in particular is deliberately thin: it binds a schema to the helper and owns nothing else.
- `packages/shared-utils/src/getTextualModelOutput.ts` (268 lines). Two things in it are easy to get wrong and are already handled: the envelope unwrapping covers three reply shapes because Workers AI models are inconsistent about it, and the retry loop distinguishes a schema failure from a call failure in the error it throws.
- `apps/agent-helios/src/services/gatewayCost.ts` (81 lines). Read the whole doc comment on `readGatewayCost`, not just the signature.
- ADR-0007 for why the call uses the Chat Completions shape rather than the Responses API, and ADR-0009 for the per-stage retry rule.

## Decisions

1. **The text stage retries automatically; the image stage never does** (ADR-0009). A structured-output call that came back as slightly-wrong JSON is cheap to ask again and very likely to succeed on the second try. The retry count comes from `config.maxRetries`, resolved from KV, so it is tunable without a redeploy.
2. **Chat Completions, not the Responses API** (ADR-0007). Responses works and reports zero tokens and zero neurons on a billed call, which makes cost untrackable. `getTextualModelOutput` already sends the right shape; do not go around it.
3. **`planConcept` does not validate its own output.** It returns `unknown`. The pipeline's validate stage does the parse. Keeping these separate is what makes a schema failure attributable to validation instead of to the model call, which is what the stage prefix on `error` is for.
4. **Read the gateway cost immediately after the call, before anything else awaits.** `aiGatewayLogId` holds the most recent routed call on the binding, so the image stage will overwrite it. Helios's pipeline reads the planner cost on the line right after `planConcept` returns, and there is a comment there saying why.
5. **A missing cost never fails a run.** `readGatewayCost` returns null on every failure path, and every one of those paths logs first. Cost is an audit concern. A run that produced a good palette must not fail because a log row was slow.
6. **Warn when the call did not route through the gateway.** `buildAiRunOptions` returns `undefined` for an empty gateway id, which sends the call straight to Workers AI with no error, no log entry and no cost. `env.AI.aiGatewayLogId` being null afterwards is the only available signal. Helios warns on exactly this and so must Iris.
7. **The model is `config.textModel.model`, never a literal.** Resolved from KV with the `wrangler.jsonc` var as fallback (ADR-0008). `@cf/openai/gpt-oss-120b` is the starting choice because it is already proven in this repo, and it must be swappable without a redeploy.
8. **Carry `p_invoc_id` in the gateway metadata.** That is what lets a gateway log row be joined back to an `iris_runs` row later. It costs one line and it is the only bridge between the two systems.
9. **The prompt version goes in `model_metadata`.** So a run's palette stays attributable to the prompt that produced it, which is the entire reason iris-04 versions its prompts.

## Agreed shapes, do not invent your own

```ts
// apps/agent-iris/src/tools.ts
// A thin call site binding IrisParamsSchema to the shared helper. Owns no
// schema of its own: IrisParamsSchema is the contract, defined once in
// @aureline/shared-types.
export async function callPlannerModel(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  ai: Parameters<typeof getTextualModelOutput>[3],
  options: Parameters<typeof getTextualModelOutput>[4]
): Promise<TextualModelOutput<IrisParams>>;
```

```ts
// apps/agent-iris/src/services/planner.ts
// Signature unchanged from iris-05's fake. Only the body changes.
export async function planConcept(
  concept: string, env: Env, config: IrisConfig, p_invoc_id: string
): Promise<unknown>;
```

What lands in the text row's `model_metadata`:

```jsonc
{
  "model": "@cf/openai/gpt-oss-120b",   // as reported by the call, not from config
  "usage": { /* whatever the provider returned */ },
  "prompt_version": "iris-planner-v1"
}
```

## Work

- [ ] Write `src/tools.ts` exactly as above. It binds the schema and does nothing else. If you find yourself putting logic in it, that logic belongs in `planner.ts`. (**Ali Amir**)
- [ ] Replace `planConcept`'s body in `src/services/planner.ts`. Do not change its signature: iris-05's pipeline calls it and its tests fake it. (**Ali Amir**)
- [ ] Build both prompts from iris-04's `buildPlannerSystemPrompt` and `buildPlannerUserPrompt`. Do not write prompt text in this file. Prompt text lives in `prompts/`, versioned. (**Ali Amir**)
- [ ] Pass `{ gateway: { id: env.AI_GATEWAY_ID, metadata: { p_invoc_id } }, maxRetries: config.maxRetries, temperature: config.textModel.temperature }`. All three come from config or env; none is a literal. (**Ali Amir**)
- [ ] After the call, warn if `env.AI.aiGatewayLogId` is falsy, naming the `p_invoc_id` (decision 6). (**Ali Amir**)
- [ ] In `pipeline.ts`, read the cost with `readGatewayCost(env, "planner")` on the line immediately after `planConcept` returns, before the validate stage runs. Not later (decision 4). (**Ali Amir**)
- [ ] Port `services/gatewayCost.ts` from Helios into Iris, including its three read attempts and its backoff. Do **not** shorten it to one attempt because the text call usually populates on the first read: iris-09 calls the same function and needs the retries. (**Ali Amir**)
- [ ] Pass `prompt_version` into the text row's `model_metadata` alongside `model` and `usage` (decision 9). (**Ali Amir**)
- [ ] Confirm the validate stage in `pipeline.ts` parses with `IrisParamsSchema.parse` and that a failure there is reported with the `validate:` stage prefix, not `planner:`. (**Ali Amir**)
- [ ] Do **not** add retry logic in `planner.ts`. `getTextualModelOutput` already retries, and a second loop around it multiplies the attempts. (**Ali Amir**)
- [ ] Update `pipeline.test.ts`'s fake `AI` binding so it returns a plausible structured reply for the text call and still **throws** for the image call. The image call is still faked at this point and must stay unbillable. (**Ali Amir**)
- [ ] Add a test where the model returns invalid JSON and assert the run settles as `failed` with the stage prefix naming the failing stage, and that both rows are written. (**Ali Amir**)
- [ ] Add a test where `readGatewayCost` returns null and assert the run still completes. Decision 5 is a contract and needs a test that would notice it changing. (**Ali Amir**)

### Review gates

- [ ] **Test the no-color fallback against the real model.** Send at least three concepts that name no color at all, for example "art deco paisley with fine linework", "brutalist geometric grid", "delicate botanical sprig". All three must return a valid `IrisParams`. If any returns something unusable, that is iris-04's prompt to fix, so raise it there rather than patching around it here. (**Hashir Rauf**)
- [ ] Send at least three concepts that **do** name colors and confirm the returned palette actually reflects them. A prompt that returns valid-but-unrelated palettes passes every schema check and is completely broken. (**Hashir Rauf**)
- [ ] Confirm the cost read happens before the validate stage, by reading the order of statements in `runPipeline`. (**Hashir Rauf**)
- [ ] Confirm `tools.ts` owns no schema and no logic. (**Hashir Rauf**)
- [ ] Confirm the gateway log shows a row per call, with the `p_invoc_id` in its metadata, and that the row's cost matches what landed in `iris_runs`. (**Hashir Rauf**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: text calls only, well under a cent each.** The image call is still faked in this ticket, so the expensive half is not in play. Six to ten planner calls for the gates above is fine. If you find yourself in double digits, you are debugging the prompt, which belongs in iris-04 with its harness and no model at all.

1. `npm run dev --workspace=apps/agent-iris`, then a real concept:
   ```
   curl -s -X POST http://localhost:8787/generate -H 'Content-Type: application/json' \
     -d '{"concept":"art deco paisley in deep jewel tones","motif_ref":"patterns/fake.jpg","source_p_invoc_id":"h1"}' | jq .params
   ```
   Expect a real palette whose colors relate to "deep jewel tones".
2. `curl -s 'http://localhost:8787/runs' | jq '.runs[] | select(.modality=="text")'`. Confirm `cost_usd` is a real non-null number, `planner_params` holds the palette, and `model_metadata` carries `model`, `usage` and `prompt_version`.
3. Force a retry: set `max_retries` low and use a concept likely to confuse the model, or temporarily corrupt the schema handed to the model. Confirm the error message distinguishes a schema failure from a call failure. Put everything back with `npm run config:pull:iris`.
4. Force the no-gateway path: temporarily blank `AI_GATEWAY_ID`. Confirm the warning fires, the run still completes, and `cost_usd` is null. Put it back. This is worth doing once, because in production this failure is completely silent.
5. `npm test --workspace=apps/agent-iris` passes.

## Two things that will waste your afternoon

**Reading the cost anywhere except immediately after the call gives you the wrong number, not an error.** `aiGatewayLogId` is a single slot on the binding holding the most recent routed call. Move the read one `await` later and you get whatever ran in between. In production this shows up as a text row carrying the image call's cost, which nobody notices until the cost report looks strange.

**A blank or misspelled `AI_GATEWAY_ID` does not fail.** The run works, the palette is fine, and `cost_usd` is null forever. If costs are coming back null, check `aiGatewayLogId` before you go looking at `gatewayCost.ts`. Verification step 4 makes you watch this happen once, deliberately, which is much cheaper than meeting it for the first time in production.
