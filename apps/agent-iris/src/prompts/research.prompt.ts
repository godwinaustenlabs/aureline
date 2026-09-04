import type { Classification } from "@aureline/shared-types";

/**
 * The research stage's system prompt: you have a search tool, here is what it
 * searches, decide for yourself whether to use it.
 *
 * **This is the only prompt in the engine addressed to a model that can act
 * rather than only answer.** Everything else here asks for a JSON object; this
 * one hands over a tool and a budget.
 *
 * The version history lives here rather than in a changelog. **Never edit a
 * prompt in place — bump the id**, because `prompt_version` on the audit row is
 * what makes a run reproducible.
 *
 * v1 — first version.
 */
export const IRIS_RESEARCH_PROMPT_VERSION = "iris-research-v1";

/** The tool's name, kept in step with `SEARCH_TOOL` in shared-utils. */
const TOOL_NAME = "search_design_reference";

/**
 * Describes what has already been decided about this design, so the model
 * searches for the right thing rather than rediscovering the mode.
 *
 * Returns an empty string when there is no classification.
 */
function classificationBrief(classification: Classification | undefined): string {
	if (classification === undefined) return "";

	const part =
		classification.garment_part === undefined
			? ""
			: `\nThe garment part is: ${classification.garment_part}. Search for colour guidance specific to that part — its shape, its proportions, and what reads well at that scale.`;

	return classification.mode === "tile"
		? `\n# What has already been decided\n\nThis design is a TILE: a seamless repeating unit whose edges must meet without a visible seam. Search for colour guidance about repeats, tiling, edge continuity and scale — not about placement on a garment.\n`
		: `\n# What has already been decided\n\nThis design is a MOTIF: a single element placed once, not a repeat. Search for colour guidance about placement, silhouette and how a single worked element should sit on cloth — not about tiling or seamless repeats.${part}\n`;
}

/**
 * Builds the research system prompt.
 *
 * Deterministic for any given argument, and tested to be. The prompt is stored
 * in the database and this is only the code fallback.
 */
export function buildResearchSystemPrompt(classification?: Classification): string {
	return `You are researching a textile design brief for colour before anyone designs anything.

You have one tool, ${TOOL_NAME}. It searches a reference knowledge base of textile design guidance — how correct colour output looks for a given kind of design, what conventions apply, what tends to go wrong.

Use it before deciding a colour direction, so the direction is informed rather than invented.
${classificationBrief(classification)}
# Writing a good query

Search for the design problem, not for the brief's own words. A brief about "deep navy and gold paisley" is answered by guidance on navy and gold colour pairings, or on paisley colour conventions — not by a document that happens to contain the phrase "deep navy and gold paisley".

Short queries beat long ones. The knowledge base is prose organised by heading, not a search engine that rewards keyword stuffing.

Ask one thing at a time. Two questions in one query returns documents that answer neither well.

# How many times to search

You may search more than once, and should when the first result opens a question it does not answer. There is a limit on how many times, and when you reach it the design proceeds with whatever you have found.

# When not to search

Not searching is a valid answer. If the brief is plain and you already know how such a design should look, say so and stop — an unnecessary search costs money and puts irrelevant text in front of the planner, which is worse than no text at all.

# When a search comes back thin

You will be told when a query matched little or nothing. That usually means the wording was wrong, not that the knowledge base is empty: try different vocabulary for the same idea, or a shorter query.

It can also mean the knowledge base genuinely has nothing on the subject. If a second attempt is also thin, stop rather than trying a third variation of the same question. The design will proceed ungrounded, which is an acceptable outcome and not a failure.

# Your answer

When you are done searching, briefly state what you found and what it means for this design's colour. If you searched nothing, say that instead.`;
}

/**
 * The user turn: the brief, and what has already been decided about it.
 *
 * **The classification is repeated here even though `buildResearchSystemPrompt`
 * already states it, and that is not redundancy — it is the only copy that
 * survives.** The system prompt is database-backed: `resolvePrompt` returns the
 * stored row whenever there is one, and a stored row is a static string with no
 * classification baked into it.
 */
export function buildResearchUserPrompt(concept: string, classification: Classification): string {
	const part =
		classification.garment_part === undefined ? "" : `\nGarment part: ${classification.garment_part}`;

	return `Brief: ${concept}\nDesign mode: ${classification.mode}${part}`;
}
