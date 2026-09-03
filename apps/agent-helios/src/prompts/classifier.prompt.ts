/**
 * The classifier's system prompt: is this brief a repeating tile, or a single
 * motif for one part of a garment?
 *
 * Short and flat on purpose. Every other prompt in this engine is asking a model
 * to be a designer; this one is asking it to answer a two-way question and name
 * a part, and length here buys nothing but latency and a wider surface for the
 * model to be creative on.
 *
 * The version history lives here rather than in a changelog. **Never edit a
 * prompt in place — bump the id**, because `prompt_version` on the audit row is
 * what makes a run reproducible, and an edited v1 silently redefines every row
 * that already claims to be v1.
 *
 * v1 — first version. Includes the edge-case rules from the outset rather than
 * shipping a naive version and tuning it afterwards: the four cases below were
 * known before a line was written (P2.md T5), so a v1 without them would have
 * been a version that never ran anywhere and two `prompt_version` values
 * describing one intent.
 */
export const HELIOS_CLASSIFIER_PROMPT_VERSION = "helios-classifier-v1";

/**
 * Garment parts the classifier may name.
 *
 * A closed list, and that is the point. `garment_part` reaches the image prompt
 * as a real instruction ("a single motif for the {part}"), so a model free to
 * invent one produces designs tailored to places the schema has never heard of
 * and that the playground cannot group by. The schema caps the field at 64
 * characters but cannot constrain its vocabulary; this list is where that
 * happens, and `ClassificationSchema` is the second line of defence rather than
 * the first.
 */
const GARMENT_PARTS = [
	"neckline",
	"back",
	"front",
	"sleeve",
	"cuff",
	"hem",
	"yoke",
	"panel",
] as const;

/**
 * Builds the classifier system prompt.
 *
 * Takes no arguments and returns the same string every time. That is deliberate
 * and tested: the prompt is stored in the database and this is only the code
 * fallback, so a fallback that varied per call would make two runs on the same
 * brief incomparable for a reason nothing in the audit row would show.
 */
export function buildClassifierSystemPrompt(): string {
	return `You classify textile design briefs. You are not designing anything.

Answer two questions about the brief and reply with JSON only.

# mode

"tile" — a seamless repeating unit. It is laid edge to edge to cover cloth, so
its edges must be continuous and it shows no seam where copies meet. Most
briefs are tiles: an all-over print, a pattern, a repeat, anything describing
cloth rather than a place on a garment.

"motif" — one design element, placed once, on one part of a garment. It does
not repeat. An embroidered crest, a printed panel, a single bird at the
shoulder.

The test is whether the design repeats, not whether the brief mentions a
garment. "A seamless sleeve pattern" is a tile: it names a sleeve, but it
describes a repeat.

# garment_part

Include it only for a motif, and only when the brief names a place on the
garment. One of: ${GARMENT_PARTS.join(", ")}.

Leave it out entirely when the brief names no place. Do not infer one from the
subject matter, and do not pick a likely one — a part you invent is passed to
the image model as an instruction, and the design comes back tailored to
somewhere nobody asked for.

Never include it for a tile. A tile covers cloth; it has no one place.

# The reference image

If a picture is attached, read it as evidence of which mode is intended. A
photograph of cloth carrying a repeating print is a tile. A photograph of one
worked element on a garment — an embroidered neckline, a printed back — is a
motif, and it also shows you which part.

Where the picture and the words disagree, follow the words. The brief is the
request; the picture is a reference.

# When the brief is ambiguous

Answer "tile". A brief that says only "a floral design" is a tile — it is the
common case, and it is the answer that does not invent a garment part.

# Output

JSON only. No prose, no markdown fence.

{"mode": "tile"}
{"mode": "motif", "garment_part": "neckline"}`;
}
