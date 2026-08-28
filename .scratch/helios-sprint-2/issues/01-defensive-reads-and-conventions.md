# helios-01: Defensive reads, and the conventions Helios never got

**What to build:** close the fall-through in `resume.ts` that can bill a second image for free, make the two "settle a row" functions fail loudly instead of updating nothing, and move Helios onto the repository conventions that arrived with the Iris sprint after Helios had already shipped.

**Objective:** `AGENTS.md` §7 cites `apps/agent-helios/src/services/resume.ts:62-68` by file and line as the canonical example of a bug the repo has a rule against. The rule was written from Helios's own incident, and the code it points at was never fixed. Everything else in this ticket is bookkeeping that has to happen before the rename in helios-03 can land in the right directory.

**Final result:** a resume on a run with no image row is refused rather than billed, a settle against a missing row throws with the id in the message, and Helios's migrations, ADR directory and CI trigger sit where the conventions say they do.

**Blocked by:** nothing. This is the first of three and the only one that is independently shippable.

**Status:** done, pending review.

**Owner:** Maaz Bin Asif. **Reviewer:** to be assigned.

**Duration:** 1 day. **Scheduled:** Thu Aug 27 to Thu Aug 27.

## Read this first

- `prompt.md` at the repo root, problem 4. It is the write-up of the four patterns found in the Iris DB review, and this ticket is its fourth.
- `AGENTS.md` §7, which quotes the exact lines this ticket changes.
- `origin/dev:apps/agent-iris/src/repository/do.repository.ts:143-192` — Iris's `completeImageRun`, the shape to copy, including the reason in its doc comment.
- `docs/adr/README.md`, for why `helios/` needed a paragraph of its own rather than just a directory.

## Decisions

1. **`undefined` gets its own branch, not a third `?.`.** `imageRow` is `HeliosRun | undefined`, and a run with a text row but no image row matches neither `?.status === "completed"` nor `?.status === "running"`, so today it falls through and generates another image. Only `"failed"` may reach the resume path.
2. **Both settle functions are guarded, not just the image one.** Iris guarded only `completeImageRun`, justified by "the caller has just paid for an image". Helios's `completeTextRun` has the same silent zero-row hole and it is reachable earlier: a no-op text insert lets `runPipeline` return `status: "completed"` with no rows in the table at all.
3. **A row with null `model_metadata` is not silently dropped from the resume spend cap.** `do.repository.ts:193` reads `?.root === root`, so a row whose metadata failed to serialise counts as "not this chain" and the cap under-counts.
4. **The attempt cap itself is left alone.** It is already enforced above both the id mint and the first write, so a refusal genuinely costs nothing. It was checked, not assumed.
5. **Helios's D1 migrations move to `infrastructure/d1/migrations/helios/`.** They sat at the root, which made Iris's `migrations/iris/` a child of Helios's own migrations directory. `drizzle.d1.config.ts` and `wrangler.jsonc` both point at it and must not drift.
6. **The one-row planner failure is NOT changed.** It looked like an ADR-0001 violation and it is not: helios-sprint-1 ticket 07 decision 4 specifies it deliberately and its live check verified it. Iris later chose the opposite. The divergence is now written down in `docs/helios-runs-conventions.md` instead of one engine being quietly bent to match the other.

## Checklist

- [x] `resume.ts` refuses a run with no image row, ahead of the two status guards
- [x] `completeImageRun` throws naming the id rather than updating zero rows
- [x] `completeTextRun` likewise
- [x] `countResumeAttempts` handles null metadata explicitly
- [x] D1 migrations moved to `migrations/helios/`, with both pointers updated
- [x] `docs/adr/helios/` exists and `docs/adr/README.md` explains it
- [x] `dev-helios` added to the CI branch list
- [x] dead ADR link and the trailing-slash origin fixed in `wrangler.jsonc`, `cf-typegen` re-run in the same commit
- [x] the Helios/Iris failure-shape divergence recorded in the conventions doc
- [x] tests covering the missing image row and both missing-row settles
