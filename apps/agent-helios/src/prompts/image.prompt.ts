import type { HeliosParams } from "@aureline/shared-types";

/**
 * Image generator prompt translator (v1).
 *
 * Structure and reasoning: docs/prompts/02-image-prompt-structure.md.
 *
 * This is a translator, not a prompt: a deterministic function from the eight
 * structured parameters to a Flux prompt. It holds no design judgement — the
 * planner made every creative decision already. If output looks wrong, the fix
 * belongs in the planner or in the phrase tables below, not in creative
 * rewording here.
 *
 * The ninth field, `image_prompt`, is the exception that proves the rule: it is
 * the planner's own words, passed through untranslated and appended after every
 * clause this file composes. It is the free-form half of the two-layer strategy
 * in `docs/Project Wide/phase-1-plan.md` §6 — everything else here is the
 * deterministic half.
 *
 * Clause order matters. Flux weights early clauses more heavily, so the format
 * declaration and motif lead and the exclusions trail.
 */

/** Versioned identity of this prompt. Never edit a prompt in place — bump the ID.
 *
 * v2 appends the planner's `image_prompt` as a final positive clause.
 * v3 adds a clause naming the user's reference image as a style input, on the
 * runs that carry one. */
export const IMAGE_PROMPT_ID = "helios-image-v3";

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

/**
 * What the supplied image is *for*.
 *
 * Named as a reference for motif character and linework, and explicitly not as
 * something to reproduce. Without this an image-to-image model treats the input
 * as the thing to redraw, and a designer's photograph of a printed fabric comes
 * back as a photograph of a printed fabric — colour, drape and all, every one of
 * them on the exclusion list below.
 *
 * "Do not copy its colours" is stated here as well as in `MONOCHROME_LOCK`.
 * Repetition rather than redundancy: the lock speaks about the output, this
 * speaks about the input, and a model weighing a vivid picture against one
 * clause of text needs both.
 */
const REFERENCE_IMAGE_CLAUSE =
	"drawing on the supplied reference image for motif character and linework only, " +
	"not copying its colours, framing, fabric drape or composition";

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
	/**
	 * Whether a reference image is being sent to the model alongside this prompt.
	 *
	 * The model needs telling what to do with a picture it has been handed, and
	 * the honest default is the dangerous one: an image-to-image model given a
	 * photograph and no instruction will reproduce it — colour, framing, drape and
	 * all. Every one of those is on the exclusion list.
	 *
	 * So this adds a clause naming the reference as a *style* input only. It does
	 * not relax anything: the monochrome lock and the exclusions still follow it,
	 * and they are ADR-0002 promises that no model-supplied or user-supplied input
	 * is allowed to weaken.
	 */
	hasReferenceImage?: boolean;
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
	const { supportsNegativePrompt = true, hasReferenceImage = false } = options;
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
		// Before the monochrome lock, so the lock has the last word on colour —
		// which is the whole risk of handing a colour photograph to an
		// image-to-image model.
		...(hasReferenceImage ? [REFERENCE_IMAGE_CLAUSE] : []),
		MONOCHROME_LOCK,
		// The free-form layer, last among the positive clauses (phase-1-plan §6).
		//
		// **Last here, and not last in the finished string.** The phase-1 doc says
		// "at the very end, after every other clause", which on the
		// `supportsNegativePrompt: false` path would put it after
		// `Do not include: colour, text, border, ...` — where a positive sentence
		// reads as more things to draw, the exact inversion the
		// `ImagePromptOptions` comment below warns about. Placing it here keeps
		// what §6 actually guarantees: it only ever adds to the positive prompt
		// and can never weaken the exclusions or the monochrome lock, which are
		// ADR-0002 promises and are not model-writable. See ADR-SHARED-0003.
		//
		// It also sits after MONOCHROME_LOCK rather than before, so a planner that
		// writes something colour-adjacent cannot get between the lock and the
		// fields it governs.
		params.image_prompt.trim(),
	];

	// One flowing descriptive sentence — Flux responds to natural language, not
	// comma-separated tag soup. The commas separate clauses, not keywords.
	const prompt = `${clauses.join(", ")}.`;
	const negative = EXCLUSIONS.join(", ");

	return supportsNegativePrompt
		? { prompt, negative_prompt: negative }
		: { prompt: `${prompt} Do not include: ${negative}.`, negative_prompt: null };
}
