import type { IrisParams } from "@aureline/shared-types";
import { buildColorPrompt } from "../apps/agent-iris/src/prompts/color.prompt";

// The real IrisParams, not a local restatement of it. A hand-written copy here
// would let this harness compile against a shape the planner cannot produce,
// which is the one thing a harness for eyeballing real prompts must not do.
const examples: IrisParams[] = [
  {
    primary_color: "navy",
    secondary_color: "gold",
    harmony: "complementary",
    saturation: "balanced",
    background_treatment: "solid",
    mood: "opulent traditional",
  },
  {
    primary_color: "sage",
    secondary_color: "cream",
    harmony: "analogous",
    saturation: "muted",
    background_treatment: "solid",
    mood: "calm airy",
  },
  {
    primary_color: "charcoal",
    harmony: "neutral",
    saturation: "muted",
    background_treatment: "solid",
    mood: "art deco elegant",
  },
  {
    primary_color: "terracotta",
    secondary_color: "sand",
    accent_color: "ivory",
    harmony: "analogous",
    saturation: "muted",
    background_treatment: "textured",
    mood: "earthy warm",
  },
];

for (const [i, params] of examples.entries()) {
  console.log(`\n=== Example ${i + 1} ===`);
  console.log(buildColorPrompt(params));
}
