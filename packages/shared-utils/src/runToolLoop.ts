import type { SearchQuality } from "@aureline/shared-types";
// Reused rather than redeclared: this helper calls the same binding
// `getTextualModelOutput` does, and two interfaces for one method would drift.
import type { AiRunner } from "./getTextualModelOutput";

/**
 * A bounded agentic loop over one search tool.
 *
 * The model is handed a knowledge-base search tool and decides for itself
 * whether and what to search. We run whatever it asks for, hand the results
 * back, and let it decide again — up to a cap.
 *
 * **This is a sibling of `getTextualModelOutput`, not a branch inside it, and
 * that is a decision rather than duplication** (ADR-SHARED-0005). That helper
 * pins every call to `response_format: json_schema, strict: true`; telling a
 * model "your next output must satisfy this schema" and "you may call tools" in
 * one request is a conflict the provider resolves however it likes, and if it
 * resolves it by never emitting `tool_calls` we get a valid object back, no
 * error, and retrieval that simply never happened. Its retry loop also already
 * mutates `messages` to append schema-repair turns, so interleaving tool turns
 * would put one `maxRetries` counter in charge of a repair budget and a tool
 * budget at once.
 *
 * **Every call here is ungated** — two arguments to `ai.run`, never three. See
 * ADR-SHARED-0005 for why, and for why nothing on this path may ever call
 * `readGatewayCost`.
 */

/** How much of a malformed reply to quote in a warning. */
const RESPONSE_EXCERPT_LENGTH = 200;

/** Matches `getTextualModelOutput`'s default, for the same reason: Chat
 * Completions otherwise defaults to 256 output tokens and truncates mid-answer
 * (ADR-0007's closing section). */
const DEFAULT_TOOL_LOOP_MAX_TOKENS = 2048;

/**
 * How many tool calls are honoured from a single reply.
 *
 * `maxToolIterations` bounds the billed *model* calls. This bounds the
 * *searches*, and without it a model that returns twenty tool calls in one turn
 * fans out to twenty AI Search calls inside a single "bounded" iteration.
 * AGENTS.md §7 is about unbounded work, not only unbounded spend.
 *
 * Calls past the cap are still answered, with a message saying they were not
 * run. Leaving a `tool_call` unanswered produces a malformed transcript that
 * some providers reject outright, which would turn a safety limit into a failed
 * run.
 */
const MAX_TOOL_CALLS_PER_TURN = 4;

/**
 * Handed back when a query returned less text than `minChunkChars`.
 *
 * The point is the second chance. A thin first attempt is usually a wording
 * problem rather than an empty knowledge base, and the model can only tell the
 * difference if we say so — otherwise it reads an empty tool result as "there
 * is nothing there" and stops.
 */
const THIN_RESULT_NUDGE =
	"No strong matches for that query. Try different wording — a shorter query, " +
	"or different vocabulary for the same idea. Answering without searching " +
	"again is also fine if you already have enough.";

/**
 * The one method this helper needs from an AI Search instance binding.
 *
 * Structural rather than the platform's `AiSearchInstance`, for the same reason
 * `AiRunner` is structural: this package compiles with `types: ["node"]` and has
 * no Cloudflare runtime types, so it cannot name the class. A real binding
 * satisfies this, and a test can build a complete value of it with no cast
 * (AGENTS.md §4, §5).
 *
 * The reply is `unknown` on purpose. This is a third-party boundary — and a
 * beta one — so it is read defensively below rather than trusted.
 */
export interface SearchRunner {
	search: (params: {
		query: string;
		ai_search_options?: {
			retrieval?: { max_num_results?: number; match_threshold?: number };
			query_rewrite?: { enabled?: boolean };
		};
	}) => Promise<unknown>;
}

/** Exactly what this helper reads out of a Worker `Env`, and nothing else. */
export interface ToolLoopEnv {
	AI: AiRunner;
	AI_SEARCH: SearchRunner;
}

export interface RunToolLoopConfig {
	/** Ceiling on billed model calls. One turn of the loop is one call. */
	maxToolIterations: number;
	/** Passed to AI Search as `max_num_results`. */
	maxSearchResults: number;
	/** Below this many characters, a result is thin and the model is nudged. */
	minChunkChars: number;
	/** Passed to AI Search as `match_threshold`. */
	searchMatchThreshold: number;
	/** AI Search's own LLM query rewriting. Off by default — the model is
	 *  already writing the query, so rewriting adds a second billed call we do
	 *  not control, per search. */
	queryRewrite: boolean;
}

/**
 * One retrieved chunk's provenance.
 *
 * The text is deliberately not kept. It runs to tens of kilobytes per run and
 * is reproducible from the query; the key is what answers "which document made
 * it say that" (`phase-2-plan.md` §10.2).
 */
export interface RetrievedChunk {
	key: string;
	score: number;
	chars: number;
}

export interface ToolLoopResult {
	/** The `<source>` blocks, ready for the planner's `constraints` slot, or
	 *  null when nothing was retrieved. */
	context: string | null;
	/** What the model actually chose to search for, in order. */
	queries: string[];
	chunks: RetrievedChunk[];
	/** Model calls made. Not the number of searches. */
	iterations: number;
	quality: SearchQuality;
}

export interface RunToolLoopOptions {
	model: string;
	/**
	 * Mutated in place across iterations, exactly as `getTextualModelOutput`'s
	 * retry loop mutates its own. The caller owns the array and can read the
	 * whole transcript back afterwards.
	 */
	messages: Record<string, unknown>[];
	tools: readonly unknown[];
	maxOutputTokens?: number;
}

/**
 * The knowledge-base search tool offered to the model.
 *
 * The description is deliberately general, with no mention of filenames or
 * document structure. The knowledge base is Markdown sectioned by heading with
 * no filename convention, and the layout is expected to change — code that
 * assumes one breaks silently the day someone reorganises the content. Tune the
 * grounding by editing the knowledge base, not this string.
 *
 * `as const` so a test can assert on the literal and no caller can mutate the
 * shared object.
 */
export const SEARCH_TOOL = {
	name: "search_design_reference",
	description:
		"Search the textile design reference knowledge base for guidance on how a " +
		"correct output looks for a given mode and garment part. Call this before " +
		"deciding the design direction.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "A natural-language search query." },
		},
		required: ["query"],
	},
} as const;

/** One tool call as we managed to read it. */
interface ParsedToolCall {
	/** Present only when the model supplied one. */
	id?: string;
	/** The search query, or null when the call could not be read. */
	query: string | null;
	/** Why it could not be read. Present exactly when `query` is null. */
	problem?: string;
}

/** A chunk as we managed to read it. */
interface ReadChunk {
	key: string;
	text: string;
	score: number;
}

export async function runToolLoop(
	env: ToolLoopEnv,
	config: RunToolLoopConfig,
	options: RunToolLoopOptions,
): Promise<ToolLoopResult> {
	const { model, messages, tools, maxOutputTokens = DEFAULT_TOOL_LOOP_MAX_TOKENS } = options;

	const queries: string[] = [];
	const chunks: RetrievedChunk[] = [];
	const rendered: string[] = [];
	let totalChars = 0;
	let iterations = 0;

	for (let attempt = 1; attempt <= config.maxToolIterations; attempt++) {
		iterations = attempt;

		const body: Record<string, unknown> = {
			messages,
			tools: tools.map((t) => ({ type: "function", function: t })),
			max_tokens: maxOutputTokens,
		};

		// Two arguments, never three. A gateway id here would set
		// `aiGatewayLogId` between the two gated calls either side of this stage,
		// and reading a cost off it afterwards would attribute the classifier's
		// spend to research (ADR-SHARED-0005).
		const response = await env.AI.run(model, body);

		const calls = readToolCalls(response);
		if (calls.length === 0) break;

		// The model's own turn goes back before its tool results, or the next
		// request contains tool replies answering nothing.
		messages.push(assistantTurn(response));

		for (const [index, call] of calls.entries()) {
			if (index >= MAX_TOOL_CALLS_PER_TURN) {
				console.warn(
					`runToolLoop: reply asked for ${calls.length} searches, honouring ${MAX_TOOL_CALLS_PER_TURN}`,
				);
				messages.push(
					toolMessage(call, `Not run: at most ${MAX_TOOL_CALLS_PER_TURN} searches per reply.`),
				);
				continue;
			}

			if (call.query === null) {
				messages.push(toolMessage(call, call.problem ?? "Not run: the tool call could not be read."));
				continue;
			}

			queries.push(call.query);

			// Deliberately not wrapped: an AI Search exception stops the run at
			// `research:`. "The knowledge base is empty" and "the knowledge base is
			// unreachable" are different situations and get different answers.
			const reply = await env.AI_SEARCH.search({
				query: call.query,
				ai_search_options: {
					retrieval: {
						max_num_results: config.maxSearchResults,
						match_threshold: config.searchMatchThreshold,
					},
					query_rewrite: { enabled: config.queryRewrite },
				},
			});

			warnOnRewrittenQuery(reply, call.query);

			const found = readChunks(reply);
			const chars = found.reduce((sum, chunk) => sum + chunk.text.length, 0);
			totalChars += chars;

			for (const chunk of found) {
				chunks.push({ key: chunk.key, score: chunk.score, chars: chunk.text.length });
			}

			const sources = renderSources(found);
			if (sources !== "") rendered.push(sources);

			// The nudge is measured on *this* query; `quality` below is measured on
			// the loop's total. So a thin first query followed by a good second one
			// gets nudged and still comes out "ok", which is the intended outcome.
			const content =
				chars < config.minChunkChars
					? sources === ""
						? THIN_RESULT_NUDGE
						: `${sources}\n\n${THIN_RESULT_NUDGE}`
					: sources;

			messages.push(toolMessage(call, content));
		}
	}

	// Measured on searches that actually ran. A reply whose tool calls were all
	// unreadable therefore lands on "none" — nothing was retrieved — and the
	// warnings from `readToolCalls` are what say why.
	const quality: SearchQuality =
		queries.length === 0 ? "none" : totalChars < config.minChunkChars ? "thin" : "ok";

	return {
		context: rendered.length === 0 ? null : rendered.join("\n\n"),
		queries,
		chunks,
		iterations,
		quality,
	};
}

/**
 * Finds the tool calls in a reply, whichever envelope they arrived in.
 *
 * Three live shapes, all present in the generated Workers AI types:
 * top-level `tool_calls` (`@cf/meta/llama-4-scout`, the default research model),
 * `choices[0].message.tool_calls` (Chat Completions), and `response.tool_calls`.
 * The default model puts them at the top level, so a Chat-Completions-only
 * reader would find nothing and report that the model chose not to search.
 *
 * **Never throws.** A reply we cannot read means no searches this turn, the
 * loop stops, and the run completes ungrounded — because "the model chose not
 * to search" is already a legitimate completing outcome, and a parse bug here
 * must not start failing runs that would otherwise work. The warnings are the
 * "fail loudly" half of AGENTS.md §7.
 */
function readToolCalls(response: unknown): ParsedToolCall[] {
	const raw = rawToolCalls(response);
	if (raw === null) return [];

	if (!Array.isArray(raw)) {
		console.warn(`runToolLoop: tool_calls was not an array: ${excerpt(raw)}`);
		return [];
	}

	return raw.map((call) => readOneToolCall(call));
}

/** The raw `tool_calls` value, or null when the reply carries none. */
function rawToolCalls(response: unknown): unknown {
	if (!response || typeof response !== "object") return null;

	if ("tool_calls" in response) return (response as { tool_calls: unknown }).tool_calls;

	const { choices } = response as { choices?: unknown };
	if (Array.isArray(choices)) {
		const message = (choices[0] as { message?: unknown } | undefined)?.message;
		if (message && typeof message === "object" && "tool_calls" in message) {
			return (message as { tool_calls: unknown }).tool_calls;
		}
	}

	const inner = (response as { response?: unknown }).response;
	if (inner && typeof inner === "object" && "tool_calls" in inner) {
		return (inner as { tool_calls: unknown }).tool_calls;
	}

	return null;
}

/**
 * Reads one tool call.
 *
 * `arguments` is a JSON string on the Chat Completions shape and a plain object
 * on the scout and vision shapes, and the name sits under `function.name` on
 * one and bare on the other. Both spellings are accepted; a call that is
 * neither is returned with `query: null` so the caller can still answer it and
 * keep the transcript well-formed.
 */
function readOneToolCall(call: unknown): ParsedToolCall {
	if (!call || typeof call !== "object") {
		console.warn(`runToolLoop: ignoring a tool call that is not an object: ${excerpt(call)}`);
		return { query: null, problem: "Not run: the tool call could not be read." };
	}

	const shape = call as {
		id?: unknown;
		name?: unknown;
		arguments?: unknown;
		function?: { name?: unknown; arguments?: unknown };
	};

	// Kept only when the model supplied one. `@cf/meta/llama-4-scout` types `id`
	// as optional, and sending `tool_call_id: undefined` is not the same request
	// as omitting the key.
	const id = typeof shape.id === "string" ? shape.id : undefined;

	const name = shape.function?.name ?? shape.name;
	if (name !== SEARCH_TOOL.name) {
		console.warn(`runToolLoop: ignoring a call to an unknown tool: ${excerpt(name)}`);
		return { id, query: null, problem: `Not run: there is no tool named ${excerpt(name)}.` };
	}

	const rawArgs = shape.function?.arguments ?? shape.arguments;
	let args: unknown = rawArgs;

	if (typeof rawArgs === "string") {
		try {
			args = JSON.parse(rawArgs);
		} catch {
			console.warn(`runToolLoop: tool call arguments were not valid JSON: ${excerpt(rawArgs)}`);
			return { id, query: null, problem: "Not run: the arguments were not valid JSON." };
		}
	}

	const query = (args as { query?: unknown })?.query;
	if (typeof query !== "string" || query.trim() === "") {
		console.warn(`runToolLoop: tool call carried no usable query: ${excerpt(args)}`);
		return { id, query: null, problem: "Not run: the call carried no `query` string." };
	}

	return { id, query: query.trim() };
}

/**
 * The model's turn, echoed back so its tool results have something to answer.
 *
 * The raw `tool_calls` array goes back exactly as it arrived rather than being
 * re-serialised from what we parsed — the provider wrote it and the provider
 * has to accept it again, and normalising it here would be us inventing a shape
 * on its behalf.
 */
function assistantTurn(response: unknown): Record<string, unknown> {
	const turn: Record<string, unknown> = {
		role: "assistant",
		content: assistantText(response),
	};

	const raw = rawToolCalls(response);
	if (raw !== null) turn.tool_calls = raw;

	return turn;
}

/** Whatever the model wrote alongside its tool calls, or an empty string. */
function assistantText(response: unknown): string {
	if (typeof response === "string") return response;
	if (!response || typeof response !== "object") return "";

	const { choices } = response as { choices?: unknown };
	if (Array.isArray(choices)) {
		const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
		if (typeof content === "string") return content;
	}

	const inner = (response as { response?: unknown }).response;
	if (typeof inner === "string") return inner;

	return "";
}

/** One `role: "tool"` reply, carrying an id only when the model gave one. */
function toolMessage(call: ParsedToolCall, content: string): Record<string, unknown> {
	return {
		role: "tool",
		name: SEARCH_TOOL.name,
		...(call.id !== undefined && { tool_call_id: call.id }),
		content,
	};
}

/**
 * Reads the chunks out of an AI Search reply.
 *
 * Every field is checked even though the generated types mark most of them
 * required, because this is a beta API behind a structural interface and
 * `return_on_failure` defaults to true — AI Search answers a failed retrieval
 * with an empty result rather than throwing, and whether "empty" means
 * `chunks: []` or a missing field is not something the types settle.
 */
function readChunks(reply: unknown): ReadChunk[] {
	const raw = (reply as { chunks?: unknown })?.chunks;

	if (!Array.isArray(raw)) {
		console.warn(`runToolLoop: search reply carried no chunks array: ${excerpt(reply)}`);
		return [];
	}

	const found: ReadChunk[] = [];

	for (const chunk of raw) {
		const shape = chunk as { text?: unknown; score?: unknown; id?: unknown; item?: { key?: unknown } };

		// A chunk with no text contributes nothing to the context and would
		// otherwise inflate the character count with `String(undefined)`.
		if (typeof shape?.text !== "string" || shape.text === "") {
			console.warn(`runToolLoop: skipping a chunk with no text: ${excerpt(chunk)}`);
			continue;
		}

		found.push({ key: readChunkKey(shape), text: shape.text, score: readChunkScore(shape) });
	}

	return found;
}

/** The source document's key. Provenance is metadata, not the answer, so a
 *  missing one degrades rather than failing the run. */
function readChunkKey(chunk: { id?: unknown; item?: { key?: unknown } }): string {
	const key = chunk.item?.key;
	if (typeof key === "string" && key !== "") return key;

	if (typeof chunk.id === "string" && chunk.id !== "") {
		console.warn(`runToolLoop: chunk had no item.key, falling back to its id ${chunk.id}`);
		return chunk.id;
	}

	console.warn("runToolLoop: chunk had neither item.key nor id");
	return "unknown";
}

/**
 * The match score.
 *
 * A missing score is recorded as `0`, which is **deliberately unlike** the rule
 * for a cost figure. ADR-0007 forbids storing a zero cost because a spend report
 * built on it looks correct while being wrong. A score is not money, it is only
 * ever read by a person tuning `search_match_threshold`, and a run must not fail
 * over one — the warning is what tells you the shape moved. Do not "fix" this to
 * match the cost rule.
 */
function readChunkScore(chunk: { score?: unknown }): number {
	if (typeof chunk.score === "number") return chunk.score;

	console.warn(`runToolLoop: chunk had no numeric score: ${excerpt(chunk.score)}`);
	return 0;
}

/**
 * Renders chunks as `<source>` blocks for the planner's `constraints` slot.
 *
 * Following Cloudflare's own bring-your-own-generation-model guidance, so
 * provenance survives into the prompt and the planner can be told where a claim
 * came from.
 */
function renderSources(found: ReadChunk[]): string {
	return found
		// The key goes inside a quoted attribute the planner reads as structure, so
		// a key containing a quote would close the attribute early and hand the
		// planner a mangled block.
		.map((chunk) => `<source name="${chunk.key.replace(/"/g, "&quot;")}">${chunk.text}</source>`)
		.join("\n\n");
}

/**
 * Warns when AI Search searched for something other than what we sent.
 *
 * With `query_rewrite` off the two must be identical, so a difference is the
 * only signal that rewriting is on — which means a second Workers AI call per
 * search, billed, that nothing in this repo controls.
 */
function warnOnRewrittenQuery(reply: unknown, sent: string): void {
	const used = (reply as { search_query?: unknown })?.search_query;

	if (typeof used === "string" && used !== sent) {
		console.warn(
			`runToolLoop: AI Search rewrote the query — sent ${JSON.stringify(sent)}, ` +
				`searched ${JSON.stringify(used)}. Check ai_search_query_rewrite.`,
		);
	}
}

/** Truncated, quotable form of a value, for warnings. */
function excerpt(value: unknown): string {
	const asText = typeof value === "string" ? value : JSON.stringify(value);

	if (typeof asText !== "string") return String(value);

	return asText.length > RESPONSE_EXCERPT_LENGTH
		? `${asText.slice(0, RESPONSE_EXCERPT_LENGTH)}...`
		: asText;
}
