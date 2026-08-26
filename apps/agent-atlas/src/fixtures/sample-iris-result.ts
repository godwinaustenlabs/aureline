import type { IrisResult } from "@aureline/shared-types";

/**
 * A complete, successful `IrisResult` — Atlas's input, standing in for Iris
 * until that engine's output is wired through for real (shared-02).
 *
 * **This is validated by a real `IrisResultSchema.parse` in `fixtures.test.ts`,
 * not merely typed as `IrisResult` here.** A type annotation is checked at
 * compile time against a schema that may since have moved; the parse is what
 * actually proves the shape is still right.
 *
 * That test is the box that makes shared-02 cheap. If this fixture validates
 * today, swapping it for Iris's live output later is a data change rather than
 * a code change. If it stops validating, that is a real cross-engine contract
 * bug found for free, and the fixture is what should be fixed — not the schema,
 * unless the schema is genuinely wrong.
 *
 * Note the two ids and that they are not interchangeable (AGENTS.md §3):
 * `pipeline_id` names Iris's run, and Atlas does not carry it forward.
 * `design_session_id` names the design, is the same string Helios was given,
 * and travels onto every `atlas_runs` row untouched. Reach Atlas's request
 * fields through `atlasInputFromIrisResult`, never by copying them across by
 * hand.
 */
export const SAMPLE_IRIS_RESULT: IrisResult = {
  pipeline_id: "iris-7f3a91c4-2b8e-4d05-9c61-0a4e8d2f5b73",
  design_session_id: "design-3e5b2a10-8c47-4f92-a6d1-b90f27c4e815",
  status: "completed",
  params: {
    primary_color: "indigo",
    secondary_color: "gold",
    accent_color: "rust",
    harmony: "complementary",
    saturation: "balanced",
    background_treatment: "solid",
    mood: "art deco, confident and graphic",
  },
  // A servable URL, exactly as Iris returns one: built from that worker's own
  // origin, so it already points at the right host when the engines deploy
  // apart. Atlas treats it as an opaque reference.
  image_url: "http://localhost:8788/images/iris/iris-7f3a91c4-2b8e-4d05-9c61-0a4e8d2f5b73.jpg",
  width: 512,
  height: 512,
  cost_usd: 0.0029,
  error: null,
};

/**
 * A failed Iris run, for the case Atlas has to refuse.
 *
 * `atlasInputFromIrisResult` throws on this deliberately: a run with a null
 * `image_url` produced no pattern, so there is nothing for Atlas to place, and
 * a request built from it would reach a billed call with a reference to
 * nothing.
 *
 * It shares a `design_session_id` with the successful fixture above, because a
 * failed attempt and a later successful one are attempts at the same design —
 * which is exactly what that id is for.
 */
export const SAMPLE_FAILED_IRIS_RESULT: IrisResult = {
  pipeline_id: "iris-0b2e77d9-4a13-4c86-90f5-6e3b1a8c4d02",
  design_session_id: "design-3e5b2a10-8c47-4f92-a6d1-b90f27c4e815",
  status: "failed",
  // Kept on a failure whenever the planner already succeeded — partial state is
  // more useful than none, and it is what makes the run resumable.
  params: {
    primary_color: "emerald",
    harmony: "monochrome",
    saturation: "muted",
    background_treatment: "solid",
    mood: "quiet and botanical",
  },
  image_url: null,
  width: null,
  height: null,
  cost_usd: 0.001,
  error: "image: model returned no image",
};
