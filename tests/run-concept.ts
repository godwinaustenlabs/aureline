import { buildImagePrompt } from "../apps/agent-helios/src/prompts/image.prompt";

//I have added the json params in excel sheet (which i sent seperately) from there u can copy and paste the params in below code to test the buildImagePrompt function for different params and see the output in console.
const params = {
  "motif_type": "geometric block",
  "repeat_type": "block",
  "scale": "medium",
  "density": "dense",
  "line_weight": "bold",
  "texture_technique": "solid-fill",
  "contrast_level": "high",
  "style": "brutalist"
};

const result = buildImagePrompt(params);

console.log("=== MAIN PROMPT ===");
console.log(result.prompt);
console.log("\n=== NEGATIVE PROMPT ===");
console.log(result.negative_prompt);