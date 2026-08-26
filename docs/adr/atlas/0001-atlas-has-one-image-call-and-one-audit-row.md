# Atlas has one image call, and therefore one audit row per invocation

`helios_runs` and `iris_runs` each hold two rows per invocation, one per modality, and [ADR-0001](../0001-helios-audit-table-per-modality-row.md) argues that shape carefully. `atlas_runs` holds one. This is a deliberate departure, not an oversight, and a future reader comparing the three tables deserves the argument rather than the assumption that Atlas simply forgot.

## Why there is no text call

Every other engine has a planner because it has an open-ended language problem to solve. Helios turns "art deco paisley with fine linework" into eight structured parameters; Iris turns the same free text into a palette. Neither mapping can be written down as a lookup, so a model does it.

Atlas has no such problem left to solve. By the time a request reaches it, every creative decision has already been made upstream and is already structured:

- **Repeat style, scale, density and linework** were decided by Helios's planner and are baked into the pattern image Atlas receives. Re-deriving them would be second-guessing an engine that already had the text.
- **Colour** was decided by Iris, likewise.
- **Garment type, region, coverage and pattern scale** are what remains, and all four are small closed sets. A caller picks from an enum. There is nothing for a language model to interpret.

So Atlas's request carries **no free-text field at all** — not `concept`, not `notes`, not `style`. That is enforced in `AtlasRequestSchema`, and it is a safety property as much as a design one: Atlas has no text model to interpret free text, so anything free-form would pass straight into an image prompt. That is an unbounded, unvalidatable input to a call that spends real money.

The consequence is that `prompts/placement.prompt.ts` is a deterministic translator rather than a model call. Same placement in, same string out. That is also what makes a bad output attributable: if two runs with identical placements produce different images, the model did it, not us.

## Why one call means one row

ADR-0001's reasoning is worth restating precisely, because it is the thing being departed from. It says a single `status` and a single `cost_usd` column cannot represent "the planner succeeded and the image failed" — two independently billable calls that succeed and fail independently need two independent outcomes. That argument is correct, and it is the reason Helios and Iris are shaped the way they are.

Atlas has exactly one billable call. There is no partial-success case for a `modality` column to represent, because there is no second stage that can settle differently from the first. A `modality` column here would hold the literal string `"image"` on every row that has ever existed. That is copying a pattern rather than reusing one.

The practical effect: for Atlas, "what did the image model cost this month" is `SELECT sum(cost_usd)`, not a filter over nullable columns. One row per invocation is the shape that makes the simple question simple.

## What follows from it, and what breaks if you forget

Three things depend on this and are easy to get wrong:

**The rescue insert matters more here than anywhere else.** When an invocation fails while *opening* its row, `insertFailedRun` writes one already marked `failed`. Helios and Iris can survive without their equivalent looking too broken — a failure while opening the second row still leaves the first behind, so the invocation is at least visible. Atlas has one row, so without the rescue a failed invocation leaves **no trace at all**: no row, nothing in `GET /runs`, nothing exported to D1, and nothing to resume from.

**Resume markers have nowhere else to go.** Helios and Iris write `root`, `resumed_from` and `attempt` onto a resumed *text* row, and both have a known trap where the markers land on a row that carries no cost. Atlas cannot have that trap, because there is one row and it carries both the markers and the money. A resumed Atlas run writes one row, not two.

**Anything consuming `GET /runs` must not assume a pair.** Code written against Helios or Iris that does `rows.find(r => r.modality === "image")` returns `undefined` on an Atlas run, a cost total comes out `NaN`, and the run renders as half-missing — which reads as a backend bug when the backend is correct. This is called out in atlas-10 for the playground, and `pipeline.test.ts` asserts the one-row invariant so it cannot drift.

**The D1 export chunk size follows from the column count, not from the other engines.** `atlas_runs` has twelve columns, D1 caps a statement at 100 bound parameters, so an insert chunks at eight rows. Helios chunks at nine (eleven columns) and Iris at seven (thirteen). The arithmetic is written into `d1.repository.ts` so nobody reconciles the three to one number.

## What would change the answer

One thing, and only one: **Atlas gaining a second independently billable call.**

If a later sprint adds, say, a separate upscaling pass or a garment-segmentation call that bills on its own and can fail on its own while the first succeeded, then ADR-0001's argument applies here in full and this table should grow a `modality` column and two rows per invocation. The trigger is not "Atlas got more complex" or "Atlas gained a stage" — a second stage that cannot fail independently and does not bill separately still needs only one row. The trigger is a second outcome that has to be recorded separately because it can differ from the first.

Adding a text call would be the same conversation, and it should be one: it would mean something upstream stopped carrying a decision it currently owns.
