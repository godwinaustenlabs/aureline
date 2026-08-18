import type { HeliosParams } from "@aureline/shared-types";

/**
 * Image generator prompt translator (v1).
 *
 * Structure and reasoning: docs/prompts/02-image-prompt-structure.md.
 *
 * This is a translator, not a prompt: a deterministic function from the eight
 * parameters to a Flux prompt. It holds no design judgement — the planner made
 * every creative decision already. If output looks wrong, the fix belongs in the
 * planner or in the phrase tables below, not in creative rewording here.
 *
 * Clause order matters. Flux weights early clauses more heavily, so the format
 * declaration and motif lead and the exclusions trail.
 */

/** Versioned identity of this prompt. Never edit a prompt in place — bump the ID. */
export const IMAGE_PROMPT_ID = "helios-image-v1";

/**
 * Phrase tables, keyed by the schema's own union types so that adding a value to
 * `HeliosParamsSchema` without a phrase for it is a type error.
 *
 * Each phrase describes GEOMETRY rather than naming our enum — the model has no
 * idea what "half-drop" means, but it can act on "alternate columns offset
 * downward by half a motif".
 */
const REPEAT_PHRASE: Record<HeliosParams["repeat_type"], string> = {
	block: "arranged on a strict aligned grid, rows and columns lining up exactly",
	"half-drop":
		"arranged in vertical columns, each alternate column offset downward by half a motif",
	brick: "arranged in horizontal rows, each alternate row offset sideways by half a motif",
	mirror: "arranged in rows, each alternate row flipped to mirror the row above",
	// "evenly distributed overall" is load-bearing: without it, models clump.
	toss: "scattered freely with no visible grid, motifs at varied angles, evenly distributed overall",
};

const SCALE_PHRASE: Record<HeliosParams["scale"], string> = {
	small: "small ditsy motifs, many across the width",
	medium: "moderately sized motifs",
	large: "large statement motifs, few across the width",
};

const DENSITY_PHRASE: Record<HeliosParams["density"], string> = {
	sparse: "generous white space between motifs",
	balanced: "an even balance of ink and white space",
	dense: "densely packed allover coverage with little white space",
};

const LINE_WEIGHT_PHRASE: Record<HeliosParams["line_weight"], string> = {
	fine: "fine delicate hairline linework",
	medium: "medium-weight linework",
	bold: "bold heavy linework",
};

/**
 * `solid-fill` has no internal linework, so the line weight has to describe the
 * silhouette edge instead — the one place the translation is not a clean
 * per-field lookup.
 */
const SILHOUETTE_EDGE_PHRASE: Record<HeliosParams["line_weight"], string> = {
	fine: "crisp fine silhouette edges",
	medium: "clean silhouette edges",
	bold: "heavy bold silhouette edges",
};

const TEXTURE_PHRASE: Record<HeliosParams["texture_technique"], string> = {
	flat: "clean flat line art with no shading",
	hatching: "shaded with parallel hatching lines",
	"cross-hatching": "shaded with dense cross-hatching",
	stippling: "shaded with stippled dots",
	"solid-fill": "drawn as solid filled black silhouettes with no internal detail",
};

const CONTRAST_PHRASE: Record<HeliosParams["contrast_level"], string> = {
	high: "high contrast, crisp pure black against pure white",
	medium: "moderate contrast with some mid greys",
	low: "soft low contrast, mostly mid-grey tones",
};

/**
 * Establishes a pattern swatch rather than an illustration. Three jobs: flat and
 * square-on, a scan rather than a photograph, and an allover repeat rather than
 * a single centred figure (the croquis failure).
 *
 * "Seamless" is included for its compositional bias only. Diffusion models do not
 * natively produce tileable edges — nothing downstream should read this output as
 * a validated repeat unit. See docs/prompts/00-pattern-prompting-research.md §2.
 */
const FORMAT_DECLARATION =
	"A flat seamless repeating textile pattern swatch, scanned square-on as an allover repeat";

/**
 * Stated positively, not just as an exclusion. "Black and white" alone lets sepia,
 * cream and off-white tints back in; this is the phrasing that actually holds, and
 * monochrome-only is the ADR-0002 promise the whole engine rests on.
 */
const MONOCHROME_LOCK =
	"pure black ink on a pure white ground, no colour of any kind, no tint, no sepia, no cream";

const EXCLUSIONS = [
	"colour",
	"text, letters, numbers, signature or watermark",
	"border or frame",
	"photograph, fabric drape, folds or product mockup",
	"3D rendering or perspective",
	"a single centred illustration",
	"background scene",
	"paper texture or drop shadow",
];

export interface ImagePrompt {
	prompt: string;
	/** `null` when the exclusions were folded into `prompt` instead. */
	negative_prompt: string | null;
}

export interface ImagePromptOptions {
	/**
	 * Whether the target model exposes a negative prompt field.
	 *
	 * Neither Flux model we use has one. Schnell's documented inputs are `prompt`
	 * and `steps` only, and Flux 1.1 Pro follows negative-style instruction
	 * embedded in the main prompt instead. So Sprint 1's caller passes `false`
	 * (ADR-0004), and the flag exists for a model that has a real field. Do not
	 * take `negative_prompt` and append it to `prompt` yourself: the list reads as
	 * things to draw unless it carries the "Do not include:" lead-in this adds.
	 */
	supportsNegativePrompt?: boolean;
}

/**
 * Free-text fields (`motif_type`, `style`) are wrapped rather than rewritten, so
 * an unexpected value from the planner degrades into an odd noun phrase instead
 * of breaking the sentence.
 */
function clean(freeText: string): string {
	return freeText.trim().toLowerCase();
}

/** `style` is free text, so the article has to be chosen at runtime. */
function article(word: string): string {
	return /^[aeiou]/.test(word) ? "an" : "a";
}

/** Translates `HeliosParams` into a Flux prompt. */
export function buildImagePrompt(
	params: HeliosParams,
	options: ImagePromptOptions = {},
): ImagePrompt {
	const { supportsNegativePrompt = true } = options;
	const isSilhouette = params.texture_technique === "solid-fill";

	const style = clean(params.style);

	const clauses = [
		FORMAT_DECLARATION,
		`${clean(params.motif_type)} motifs ${REPEAT_PHRASE[params.repeat_type]}`,
		SCALE_PHRASE[params.scale],
		DENSITY_PHRASE[params.density],
		isSilhouette
			? SILHOUETTE_EDGE_PHRASE[params.line_weight]
			: LINE_WEIGHT_PHRASE[params.line_weight],
		TEXTURE_PHRASE[params.texture_technique],
		CONTRAST_PHRASE[params.contrast_level],
		`in ${article(style)} ${style} style`,
		MONOCHROME_LOCK,
	];

	// One flowing descriptive sentence — Flux responds to natural language, not
	// comma-separated tag soup. The commas separate clauses, not keywords.
	const prompt = `${clauses.join(", ")}.`;
	const negative = EXCLUSIONS.join(", ");

	return supportsNegativePrompt
		? { prompt, negative_prompt: negative }
		: { prompt: `${prompt} Do not include: ${negative}.`, negative_prompt: null };
}
