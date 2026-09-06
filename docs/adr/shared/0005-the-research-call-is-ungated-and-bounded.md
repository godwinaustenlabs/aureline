# The research call is ungated and bounded, and its cost is null

**Contradicts [ADR-0006](../0006-all-model-calls-route-through-ai-gateway.md)**, which says all Workers AI calls made through `packages/shared-utils` pass a gateway configuration as `ai.run`'s third argument. Phase 2 adds a call that deliberately does not. ADR-0006 stands for every other call in the repo — the planner, the classifier and both image paths are unchanged — so this is a carve-out for one stage rather than a supersession, and it is written down because AGENTS.md §1 requires a change that contradicts an ADR to say so out loud instead of slipping it in.

## What the research call is

Phase 2 gives the model a `search_design_reference` tool over a Cloudflare AI Search knowledge base and lets it decide whether and what to search. That is not one call. It is a loop: the model answers, we run any searches it asked for, we hand the results back, and it answers again — up to `max_tool_iterations` times. Every turn of that loop is a separately billed Workers AI call.

Helios's run therefore becomes three stages that spend money: classify, research, planner. The ordering matters and is load-bearing:

| Call | Gateway | Cost |
|---|---|---|
| classify | on | read immediately after → `classify_cost_usd` |
| research | **off** | never read → `research_cost_usd: null` |
| planner | on | read immediately after → `planner_cost_usd` |

## Why ungated

The straightforward version of this argument — that a gated research call would overwrite `aiGatewayLogId` and corrupt the planner's cost — is not quite right, and it is worth correcting here rather than repeating. `readGatewayCost` is called immediately after the call it belongs to, and the planner runs *after* research, so the planner would set the log id last and read its own cost correctly either way. Gating research would not break the planner.

Two things that are true make the decision instead.

**A gated research stage would report a number that is wrong in a way that looks right.** `readGatewayCost` returns the cost of the most recent routed call, and it says so about itself (`apps/agent-helios/src/services/gatewayCost.ts:42-47`): *"When the planner retries, each attempt is its own gateway call and this returns the cost of the final one, not the sum."* The planner retries rarely, so that is a small under-report and is recorded as one. The research loop makes up to three billed calls *by design* — a loop is what it is — so the figure it would produce is the cost of the last turn, presented in a column named `research_cost_usd` as though it were the cost of research. A three-turn run would report roughly a third of what it spent, with nothing anywhere to say so. ADR-0007's closing rule exists for exactly this shape of number: a report built on it looks correct while being wrong.

**The hazard that does exist runs the other way, and the ungated choice is what contains it.** An ungated call does not clear `aiGatewayLogId`; it leaves whatever the last routed call put there (`gatewayCost.ts:35-40`). So calling `readGatewayCost` after the research stage would not return null — it would return the *classifier's* cost and record it as research's. The rule that follows is a discipline, not a preference: **nothing calls `readGatewayCost` on the research path.** That is enforced at the type level today, because the function's `stage` parameter is typed `"planner" | "image"` (`gatewayCost.ts:58`), so a `readGatewayCost(env, "research")` does not compile. If anyone widens that union, this paragraph is the reason not to widen it for this stage.

The consequence, stated plainly so nobody reports it as a routing bug: **the AI Gateway dashboard shows two calls per Helios run, not four or five.** Classify and planner are there; the research turns are not. Iris shows one. That is this decision working.

## Why the cost is `null` and never `0`

ADR-0007: *"A usage figure of zero means the provider did not report anything, not that the call was free. Saving a zero into a cost column is worse than saving nothing, because a report built on it will look correct while being wrong."*

The research call is not free. It is several billed model calls whose cost we have chosen not to measure. `0` would state that it cost nothing, which is false; `null` states that we do not know, which is true. The metadata block carries `cost_usd: null` explicitly rather than omitting the field, so a reader of an audit row can tell "we did not measure this" from "this key predates the field".

If the number turns out to be wanted later, the way to get it is not to gate the loop. It is to read the gateway log once per turn inside the loop and sum them — a different function from `readGatewayCost`, because summing is the thing `readGatewayCost` explicitly does not do.

## Why the tool loop is a sibling helper, not a change to `getTextualModelOutput`

`packages/shared-utils/src/runToolLoop.ts` is a new file beside `getTextualModelOutput.ts`, not a branch inside it. That looks like duplication and it is deliberate.

**The request bodies conflict.** `getTextualModelOutput` pins every call to `response_format: { type: "json_schema", json_schema: { …, strict: true } }` (`getTextualModelOutput.ts:373-400`). Telling a model "your next output must satisfy this schema" and "you may call tools" in the same request is a conflict the provider resolves however it likes, and the failure mode if it resolves it by never emitting `tool_calls` is the worst kind: a perfectly valid params object comes back, no error is raised, and retrieval simply never happened, with nothing in the run to say so. `temp logs.md` in this repo already shows `@cf/openai/gpt-oss-120b` returning `"function_call": null` on every call.

**The retry loop already owns the message array.** `appendCorrection` mutates `messages` in place to append schema-repair turns (`getTextualModelOutput.ts:293-311`). Interleaving tool turns into the same array puts one `maxRetries` counter in charge of two unrelated budgets — a repair budget and a tool budget. ADR-0009 exists to keep "one attempt" meaning one billed call, and a shared counter breaks that in both directions: a model that searches three times has spent its repair budget before it has produced an answer to repair.

**And it is used by everything.** `getTextualModelOutput` is called by both engines and covered by roughly forty-five tests, for a behaviour exactly one stage needs.

What the split costs is two model calls per run where one might have done. What it buys is a run where *"the model chose not to search"* and *"the model could not search"* are different, visible outcomes — recorded as `quality: "none"` and an error respectively, rather than both looking like a normal run.

## Why it is bounded

AGENTS.md §7: *"Anything that can trigger a repeated model call needs a bounded attempt count and a guard that trips on a malformed row. Money is the reason this section exists. A loop that costs nothing is a bug; a loop that calls an image model is an invoice."*

A tool loop is the exact shape that section is about — the model asks for another search, we oblige, and the stopping condition is the model's own judgement. So there are two ceilings, not one:

- **`max_tool_iterations`** (KV-tunable, default `3`) bounds the billed model calls. The loop runs at most this many turns and then proceeds with whatever it has.
- **`MAX_TOOL_CALLS_PER_TURN`** (a module constant, `4`) bounds the searches honoured from a single reply. Without it, a model that returns twenty tool calls in one turn fans out to twenty AI Search calls *inside* one "bounded" iteration. §7 is about unbounded work, not only unbounded spend, and a per-turn ceiling is the only thing that closes that.

Neither ceiling is an error condition. Reaching `max_tool_iterations` warns, records `quality`, and continues to the planner — an under-grounded design is a worse design, not a failed run. The one thing that *does* stop the run is an AI Search exception, which is why `search()` is not wrapped in a try/catch: "the knowledge base is empty" and "the knowledge base is unreachable" are different situations and must get different answers. An empty KB is a working state, which is what makes it possible to ship this phase before the knowledge base has any content in it.

## Consequences

- The research stage is invisible in the AI Gateway dashboard. Two logged calls per Helios run, one per Iris run.
- `research_cost_usd` is `null` on every row, and a run's `cost_usd` column understates what the run actually spent by the research loop's share. `docs/helios-runs-conventions.md` and `docs/iris-runs-conventions.md` should say so.
- A run costs meaningfully more than it did before the image call is even reached. The two levers are the off switch — `research_model: ""` in KV skips the stage entirely, no deploy needed — and `max_tool_iterations`.
- `getTextualModelOutput` is untouched by this phase. That is the strongest available statement that the planner and classifier calls are unaffected.
