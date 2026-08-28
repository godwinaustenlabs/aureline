import { describe, expect, it } from "vitest";
import { HeliosParamsSchema, HeliosRequestSchema, HeliosResumeRequestSchema } from "@aureline/shared-types";
import { sampleParamsAlternate, sampleParamsFull, SAMPLE_DESIGN_SESSION_ID } from "./fixtures/sample-params";

/**
 * The wire contract's boundaries, tested from the side that matters: what gets
 * **rejected**.
 *
 * `shared-types` has no test runner of its own, so these live here, where vitest
 * already runs. A test proving a good value is accepted says nothing about
 * whether the schema is doing any work, so every one of these asserts a refusal.
 *
 * None of them needs a cast. `safeParse` takes `unknown`, so a wrong shape is
 * ordinary data here — casts were only ever needed to smuggle one past a
 * function signature (AGENTS.md §4, §5).
 */

const VALID_REQUEST = {
	concept: "art deco paisley in deep jewel tones",
	design_session_id: SAMPLE_DESIGN_SESSION_ID,
};

describe("HeliosRequestSchema", () => {
	it("accepts a concept and a design session id, which is all Helios needs to start", () => {
		expect(HeliosRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
	});

	it("rejects a request with no concept at all", () => {
		expect(HeliosRequestSchema.safeParse({}).success).toBe(false);
	});

	it("rejects an empty or whitespace-only concept", () => {
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, concept: "" }).success).toBe(false);
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, concept: "   " }).success).toBe(false);
	});

	it("rejects an over-long concept rather than sending it to a model", () => {
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, concept: "x".repeat(1001) }).success).toBe(false);
		// The boundary itself is fine, so the limit is off-by-one safe.
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, concept: "x".repeat(1000) }).success).toBe(true);
	});

	it("rejects a request with no design_session_id, rather than minting one", () => {
		// Destructured away rather than cast away: a missing field is ordinary data
		// to `safeParse`, which takes `unknown`.
		const { design_session_id: _absent, ...withoutIt } = VALID_REQUEST;

		// A run that cannot be traced back to a design still spends money and still
		// lands in the audit table, so refusing is cheaper than accepting.
		expect(HeliosRequestSchema.safeParse(withoutIt).success).toBe(false);
	});

	it("rejects an empty design_session_id, which would trace back to nothing", () => {
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, design_session_id: "" }).success).toBe(false);
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, design_session_id: "   " }).success).toBe(false);
	});

	it("rejects the old p_invoc_id name instead of quietly accepting it", () => {
		const { design_session_id: _absent, ...withoutIt } = VALID_REQUEST;

		// Decision 3 of the ticket, made executable: there is no alias and no
		// fallback. Accepting the old name "just in case" is how the confusion
		// between the two ids started.
		expect(HeliosRequestSchema.safeParse({ ...withoutIt, p_invoc_id: "run-a" }).success).toBe(false);
	});

	it("treats session_id as optional, because it only picks the Durable Object", () => {
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, session_id: "session-1" }).success).toBe(true);
		expect(HeliosRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
	});

	it("rejects an empty session_id, which would silently mean the shared instance", () => {
		expect(HeliosRequestSchema.safeParse({ ...VALID_REQUEST, session_id: "" }).success).toBe(false);
	});
});

describe("HeliosResumeRequestSchema", () => {
	it("takes a pipeline_id, since a resume names one run of one engine", () => {
		expect(HeliosResumeRequestSchema.safeParse({ pipeline_id: "run-a" }).success).toBe(true);
	});

	it("rejects a resume that names no run", () => {
		expect(HeliosResumeRequestSchema.safeParse({}).success).toBe(false);
		expect(HeliosResumeRequestSchema.safeParse({ pipeline_id: "" }).success).toBe(false);
	});

	it("rejects the old p_invoc_id name, so a stale caller fails loudly", () => {
		// A 400 rather than a resume of `undefined`, which `getRunRows` would answer
		// with no rows and the route would report as "no run in this session" — the
		// wrong refusal for the actual problem.
		expect(HeliosResumeRequestSchema.safeParse({ p_invoc_id: "run-a" }).success).toBe(false);
	});

	it("does not take a design_session_id, because a resume inherits the design", () => {
		// Not rejected, just ignored: zod strips unknown keys by default. The point
		// is that the resumed run's design comes off the row being resumed, so
		// nothing a caller sends here could redirect it to a different design.
		const parsed = HeliosResumeRequestSchema.safeParse({
			pipeline_id: "run-a",
			design_session_id: "some-other-design",
		});

		expect(parsed.success).toBe(true);
		expect(parsed.success && "design_session_id" in parsed.data).toBe(false);
	});
});

describe("HeliosParamsSchema", () => {
	it("accepts both fixtures, so the fakes stay valid as the vocabulary changes", () => {
		expect(HeliosParamsSchema.safeParse(sampleParamsFull).success).toBe(true);
		expect(HeliosParamsSchema.safeParse(sampleParamsAlternate).success).toBe(true);
	});

	it("rejects a repeat_type outside the controlled vocabulary", () => {
		// The reason it is an enum: `buildImagePrompt` maps each member onto
		// prompt language, and nothing downstream can render "not-a-real-repeat".
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, repeat_type: "not-a-real-repeat" }).success).toBe(
			false,
		);
	});

	it("rejects an unknown scale, density, line_weight, texture or contrast", () => {
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, scale: "enormous" }).success).toBe(false);
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, density: "crowded" }).success).toBe(false);
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, line_weight: "chunky" }).success).toBe(false);
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, texture_technique: "smudging" }).success).toBe(false);
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, contrast_level: "extreme" }).success).toBe(false);
	});

	it("rejects an empty motif_type or style, which would carry no concept at all", () => {
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, motif_type: "  " }).success).toBe(false);
		expect(HeliosParamsSchema.safeParse({ ...sampleParamsFull, style: "" }).success).toBe(false);
	});

	it("rejects params with a field missing", () => {
		const { repeat_type: _absent, ...withoutIt } = sampleParamsFull;

		// Every field is required: `buildImagePrompt` reads all eight, and a
		// missing one would render as `undefined` in the prompt sent to the model.
		expect(HeliosParamsSchema.safeParse(withoutIt).success).toBe(false);
	});

	it("rejects the half-built params object that used to sit behind a cast", () => {
		// This shape is what AGENTS.md §5 uses as its example of a test that had
		// stopped checking anything. It is here so it can never come back.
		expect(HeliosParamsSchema.safeParse({ motif_type: "art deco fan" }).success).toBe(false);
	});
});
