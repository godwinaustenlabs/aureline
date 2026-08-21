import { buildColorPrompt } from "../apps/agent-iris/src/prompts/color.prompt";

type IrisParams = {
  primary_color: string;
  secondary_color?: string;
  accent_color?: string;
  harmony: string;
  saturation: string;
  background_treatment: string;
  mood: string;
};

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