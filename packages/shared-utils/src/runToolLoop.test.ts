import { describe, it, expect, vi } from "vitest";
import { runToolLoop, SEARCH_TOOL, type RunToolLoopConfig, type ToolLoopEnv } from "./runToolLoop";

const CONFIG: RunToolLoopConfig = {
	maxToolIterations: 3,
	maxSearchResults: 5,
	minChunkChars: 200,
	searchMatchThreshold: 0.5,
	queryRewrite: false,
};

/** A chunk in the shape AI Search documents, with enough text to be "ok". */
function chunk(key: string, text: string, score = 0.8) {
	return { id: `${key}#0`, type: "text", score, text, item: { key } };
}

function searchReply(query: string, chunks: unknown[]) {
	return { search_query: query, chunks };
}

/** A reply with no tool calls, which is what ends the loop. */
const DONE = { response: "I have enough to work with." };

/** The default research model's shape: tool_calls at the top level, arguments
 *  as an object, id present. */
function scoutCall(query: string, id = "call-1") {
	return {
		response: "",
		tool_calls: [{ id, type: "function", function: { name: SEARCH_TOOL.name, arguments: { query } } }],
	};
}

function env(overrides: Partial<ToolLoopEnv> = {}): ToolLoopEnv {
	return {
		AI: { run: vi.fn().mockResolvedValue(DONE) },
		AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [])) },
		...overrides,
	};
}

/** Silences a warning for one test, the way getTextualModelOutput.test.ts does. */
function silenceWarn() {
	return vi.spyOn(console, "warn").mockImplementation(() => {});
}

function messages(): Record<string, unknown>[] {
	return [
		{ role: "system", content: "You may search." },
		{ role: "user", content: "an art deco paisley" },
	];
}

function options(overrides: Record<string, unknown> = {}) {
	return { model: "@cf/meta/llama-4-scout-17b-16e-instruct", messages: messages(), tools: [SEARCH_TOOL], ...overrides };
}

describe("runToolLoop stopping conditions", () => {
	it("stops when the reply has no tool calls, and reports that nothing was searched", async () => {
		const e = env();

		const result = await runToolLoop(e, CONFIG, options());

		expect(result).toEqual({
			context: null,
			queries: [],
			chunks: [],
			iterations: 1,
			quality: "none",
		});
		expect(e.AI.run).toHaveBeenCalledTimes(1);
		expect(e.AI_SEARCH.search).not.toHaveBeenCalled();
	});

	it("stops at maxToolIterations and does not call the model again", async () => {
		// Every reply asks for another search, so only the cap can end this.
		const e = env({
			AI: { run: vi.fn().mockResolvedValue(scoutCall("seamless repeats")) },
			AI_SEARCH: {
				search: vi.fn().mockResolvedValue(searchReply("seamless repeats", [chunk("tiling.md", "x".repeat(500))])),
			},
		});

		const result = await runToolLoop(e, { ...CONFIG, maxToolIterations: 2 }, options());

		expect(e.AI.run).toHaveBeenCalledTimes(2);
		expect(e.AI_SEARCH.search).toHaveBeenCalledTimes(2);
		expect(result.iterations).toBe(2);
	});

	it("runs no model call at all when the iteration cap is zero", async () => {
		const e = env();

		const result = await runToolLoop(e, { ...CONFIG, maxToolIterations: 0 }, options());

		expect(e.AI.run).not.toHaveBeenCalled();
		expect(result).toEqual({ context: null, queries: [], chunks: [], iterations: 0, quality: "none" });
	});
});

describe("runToolLoop is ungated", () => {
	it("calls the model with two arguments, never a third", async () => {
		// Asserted as arity rather than `calls[0][2] === undefined`, which would
		// also pass if someone explicitly passed undefined — and an explicit third
		// argument is exactly what a later edit would add. ADR-SHARED-0005.
		const e = env();

		await runToolLoop(e, CONFIG, options());

		expect(vi.mocked(e.AI.run).mock.calls[0].length).toBe(2);
	});

	it("sends the tools and the caller's max_tokens in the body", async () => {
		const e = env();

		await runToolLoop(e, CONFIG, options({ maxOutputTokens: 512 }));

		const [model, body] = vi.mocked(e.AI.run).mock.calls[0];
		expect(model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(body).toEqual({ messages: messages(), tools: [{ type: "function", function: SEARCH_TOOL }], max_tokens: 512 });
	});
});

describe("runToolLoop reads tool calls from every live envelope", () => {
	// The default research model puts tool_calls at the TOP LEVEL, not under
	// choices[0].message. A Chat-Completions-only reader finds nothing there and
	// silently reports that the model chose not to search.
	const shapes: Array<[string, unknown]> = [
		["top-level, arguments as an object, with an id", scoutCall("art deco lattice")],
		[
			"chat completions, arguments as a JSON string",
			{
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call-9",
									type: "function",
									function: { name: SEARCH_TOOL.name, arguments: JSON.stringify({ query: "art deco lattice" }) },
								},
							],
						},
					},
				],
			},
		],
		[
			"flat, no id and no function wrapper",
			{ response: "", tool_calls: [{ name: SEARCH_TOOL.name, arguments: { query: "art deco lattice" } }] },
		],
		[
			"nested under response",
			{
				response: {
					tool_calls: [{ id: "call-3", function: { name: SEARCH_TOOL.name, arguments: { query: "art deco lattice" } } }],
				},
			},
		],
	];

	for (const [label, reply] of shapes) {
		it(`finds the query when tool calls arrive ${label}`, async () => {
			const e = env({
				AI: { run: vi.fn().mockResolvedValueOnce(reply).mockResolvedValue(DONE) },
				AI_SEARCH: {
					search: vi
						.fn()
						.mockResolvedValue(searchReply("art deco lattice", [chunk("deco.md", "y".repeat(300))])),
				},
			});

			const result = await runToolLoop(e, CONFIG, options());

			expect(result.queries).toEqual(["art deco lattice"]);
			expect(vi.mocked(e.AI_SEARCH.search).mock.calls[0][0].query).toBe("art deco lattice");
		});
	}

	it("omits tool_call_id entirely when the model supplied no id", async () => {
		// Sending `tool_call_id: undefined` is not the same request as omitting the
		// key, and the flat vision shape carries no id at all.
		const sent = messages();
		const e = env({
			AI: {
				run: vi
					.fn()
					.mockResolvedValueOnce({ response: "", tool_calls: [{ name: SEARCH_TOOL.name, arguments: { query: "q" } }] })
					.mockResolvedValue(DONE),
			},
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("a.md", "z".repeat(300))])) },
		});

		await runToolLoop(e, CONFIG, options({ messages: sent }));

		const toolTurn = sent.find((message) => message.role === "tool");
		expect(toolTurn).toBeDefined();
		expect(toolTurn).not.toHaveProperty("tool_call_id");
	});

	it("carries the id through when the model supplied one", async () => {
		const sent = messages();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q", "call-77")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("a.md", "z".repeat(300))])) },
		});

		await runToolLoop(e, CONFIG, options({ messages: sent }));

		expect(sent.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "call-77" });
	});
});

describe("runToolLoop transcript", () => {
	it("pushes the model's turn before the tool result, so the reply answers something", async () => {
		const sent = messages();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("paisley")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("paisley", [chunk("a.md", "z".repeat(300))])) },
		});

		await runToolLoop(e, CONFIG, options({ messages: sent }));

		expect(sent).toHaveLength(4);
		expect(sent[2]).toMatchObject({ role: "assistant" });
		expect(sent[2].tool_calls).toEqual(scoutCall("paisley").tool_calls);
		expect(sent[3]).toMatchObject({ role: "tool", name: SEARCH_TOOL.name });
	});

	it("gives the model a second chance after a thin result", async () => {
		// 50 characters against a 200-character floor. The nudge is the whole
		// reason a thin first attempt is not the end of the stage.
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("obscure")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("obscure", [chunk("a.md", "z".repeat(50))])) },
		});
		const sent = messages();

		const result = await runToolLoop(e, CONFIG, options({ messages: sent }));

		const toolTurn = sent.find((message) => message.role === "tool");
		expect(String(toolTurn?.content)).toContain("Try different wording");
		expect(e.AI.run).toHaveBeenCalledTimes(2);
		expect(result.quality).toBe("thin");
	});

	it("still answers every tool call when a reply asks for more searches than the per-turn cap", async () => {
		// An unanswered tool_call is a malformed transcript some providers reject,
		// so the cap must refuse the work without dropping the reply.
		const warn = silenceWarn();
		const sent = messages();
		const e = env({
			AI: {
				run: vi
					.fn()
					.mockResolvedValueOnce({
						response: "",
						tool_calls: Array.from({ length: 6 }, (_unused, index) => ({
							id: `call-${index}`,
							function: { name: SEARCH_TOOL.name, arguments: { query: `q${index}` } },
						})),
					})
					.mockResolvedValue(DONE),
			},
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("a.md", "z".repeat(300))])) },
		});

		const result = await runToolLoop(e, CONFIG, options({ messages: sent }));

		expect(e.AI_SEARCH.search).toHaveBeenCalledTimes(4);
		expect(result.queries).toEqual(["q0", "q1", "q2", "q3"]);
		expect(sent.filter((message) => message.role === "tool")).toHaveLength(6);
		warn.mockRestore();
	});
});

describe("runToolLoop source rendering", () => {
	it("renders each chunk as a source block, joined by a blank line", async () => {
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("tiles")).mockResolvedValue(DONE) },
			AI_SEARCH: {
				search: vi
					.fn()
					.mockResolvedValue(searchReply("tiles", [chunk("tiling.md", "Edges must meet."), chunk("scale.md", "Keep it small.")])),
			},
		});

		const result = await runToolLoop(e, CONFIG, options());

		expect(result.context).toBe(
			'<source name="tiling.md">Edges must meet.</source>\n\n<source name="scale.md">Keep it small.</source>',
		);
	});

	it("escapes a quote in a key, so a source block cannot be closed early", async () => {
		// The key goes inside a quoted attribute the planner reads as structure.
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk('od"d.md', "text")])) },
		});

		const result = await runToolLoop(e, CONFIG, options());

		expect(result.context).toBe('<source name="od&quot;d.md">text</source>');
	});

	it("records provenance and length but never the chunk text", async () => {
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("tiling.md", "z".repeat(300), 0.91)])) },
		});

		const result = await runToolLoop(e, CONFIG, options());

		expect(result.chunks).toEqual([{ key: "tiling.md", score: 0.91, chars: 300 }]);
	});
});

describe("runToolLoop quality", () => {
	it("is none when the model searched for nothing", async () => {
		expect((await runToolLoop(env(), CONFIG, options())).quality).toBe("none");
	});

	it("is thin when the total retrieved text is under minChunkChars", async () => {
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("a.md", "z".repeat(199))])) },
		});

		expect((await runToolLoop(e, CONFIG, options())).quality).toBe("thin");
	});

	it("is ok once enough text has come back", async () => {
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("a.md", "z".repeat(200))])) },
		});

		expect((await runToolLoop(e, CONFIG, options())).quality).toBe("ok");
	});

	it("counts thin results across the whole loop, not per query", async () => {
		// Two 120-character results are 240 characters together, over the floor —
		// so a run that was nudged on its first query still ends up "ok".
		const e = env({
			AI: {
				run: vi
					.fn()
					.mockResolvedValueOnce(scoutCall("first"))
					.mockResolvedValueOnce(scoutCall("second"))
					.mockResolvedValue(DONE),
			},
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [chunk("a.md", "z".repeat(120))])) },
		});

		expect((await runToolLoop(e, CONFIG, options())).quality).toBe("ok");
	});
});

describe("runToolLoop error handling", () => {
	it("lets an AI Search exception propagate rather than swallowing it", async () => {
		// "The knowledge base is empty" completes the run; "the knowledge base is
		// unreachable" must not.
		const e = env({
			AI: { run: vi.fn().mockResolvedValue(scoutCall("q")) },
			AI_SEARCH: { search: vi.fn().mockRejectedValue(new Error("AI Search unavailable")) },
		});

		await expect(runToolLoop(e, CONFIG, options())).rejects.toThrow("AI Search unavailable");
	});

	it("does not throw on a reply whose tool_calls are not an array", async () => {
		const warn = silenceWarn();
		const e = env({ AI: { run: vi.fn().mockResolvedValue({ response: "", tool_calls: "nope" }) } });

		const result = await runToolLoop(e, CONFIG, options());

		expect(result.quality).toBe("none");
		expect(e.AI_SEARCH.search).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("answers a call whose arguments are not valid JSON instead of searching", async () => {
		const warn = silenceWarn();
		const sent = messages();
		const e = env({
			AI: {
				run: vi
					.fn()
					.mockResolvedValueOnce({
						response: "",
						tool_calls: [{ id: "call-1", function: { name: SEARCH_TOOL.name, arguments: "{not json" } }],
					})
					.mockResolvedValue(DONE),
			},
		});

		const result = await runToolLoop(e, CONFIG, options({ messages: sent }));

		expect(e.AI_SEARCH.search).not.toHaveBeenCalled();
		expect(result.queries).toEqual([]);
		expect(String(sent.find((message) => message.role === "tool")?.content)).toContain("not valid JSON");
		warn.mockRestore();
	});

	it("ignores a call to a tool that does not exist", async () => {
		const warn = silenceWarn();
		const e = env({
			AI: {
				run: vi
					.fn()
					.mockResolvedValueOnce({ response: "", tool_calls: [{ function: { name: "delete_everything", arguments: {} } }] })
					.mockResolvedValue(DONE),
			},
		});

		const result = await runToolLoop(e, CONFIG, options());

		expect(e.AI_SEARCH.search).not.toHaveBeenCalled();
		expect(result.queries).toEqual([]);
		warn.mockRestore();
	});

	it("treats a search reply with no chunks array as empty rather than failing", async () => {
		// return_on_failure defaults to true, so AI Search answers a failed
		// retrieval with an empty result — and the types do not settle whether
		// "empty" means `chunks: []` or a missing field.
		const warn = silenceWarn();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue({ search_query: "q" }) },
		});

		const result = await runToolLoop(e, CONFIG, options());

		expect(result).toMatchObject({ context: null, queries: ["q"], chunks: [], quality: "thin" });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("skips a chunk with no text and keeps the rest", async () => {
		const warn = silenceWarn();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: {
				search: vi.fn().mockResolvedValue(
					searchReply("q", [{ id: "a#0", score: 0.5, item: { key: "a.md" } }, chunk("b.md", "kept")]),
				),
			},
		});

		const result = await runToolLoop(e, CONFIG, options());

		expect(result.chunks).toEqual([{ key: "b.md", score: 0.8, chars: 4 }]);
		expect(result.context).toBe('<source name="b.md">kept</source>');
		warn.mockRestore();
	});

	it("falls back to the chunk id when it carries no item key", async () => {
		const warn = silenceWarn();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [{ id: "orphan#3", score: 0.5, text: "t" }])) },
		});

		expect((await runToolLoop(e, CONFIG, options())).chunks).toEqual([{ key: "orphan#3", score: 0.5, chars: 1 }]);
		warn.mockRestore();
	});

	it("records a missing score as zero rather than failing the run", async () => {
		// Deliberately unlike the rule for a cost figure (ADR-0007): a score is not
		// money, and a run must not fail over one.
		const warn = silenceWarn();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("q")).mockResolvedValue(DONE) },
			AI_SEARCH: { search: vi.fn().mockResolvedValue(searchReply("q", [{ id: "a#0", text: "t", item: { key: "a.md" } }])) },
		});

		expect((await runToolLoop(e, CONFIG, options())).chunks).toEqual([{ key: "a.md", score: 0, chars: 1 }]);
		warn.mockRestore();
	});

	it("warns when AI Search searched for something other than what was sent", async () => {
		// With query_rewrite off the two must be identical, so a difference is the
		// only signal that rewriting is on and billing a call we do not control.
		const warn = silenceWarn();
		const e = env({
			AI: { run: vi.fn().mockResolvedValueOnce(scoutCall("art deco")).mockResolvedValue(DONE) },
			AI_SEARCH: {
				search: vi.fn().mockResolvedValue(searchReply("art deco patterns of the 1920s", [chunk("a.md", "t")])),
			},
		});

		await runToolLoop(e, CONFIG, options());

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("rewrote the query"));
		warn.mockRestore();
	});
});

describe("SEARCH_TOOL", () => {
	it("describes the tool without naming a filename convention", () => {
		// The knowledge base is Markdown with no filename convention and its layout
		// is expected to change. Grounding is tuned by editing the KB, not this.
		expect(SEARCH_TOOL.name).toBe("search_design_reference");
		expect(SEARCH_TOOL.parameters.required).toEqual(["query"]);
		expect(SEARCH_TOOL.description).not.toMatch(/\.md|filename|file name/i);
	});
});
