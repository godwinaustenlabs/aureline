import { describe, expect, it } from "vitest";
import {
	IrisParamsSchema,
	IrisRequestSchema,
	IrisResultSchema,
	IrisResumeRequestSchema,
} from "@aureline/shared-types";
import { sampleParamsFull, sampleParamsMinimal } from "./fixtures/sample-params";

/**
 * The wire contract's boundaries, tested from the side that matters: what gets
 * **rejected**.
 *
 * `shared-types` has no test runner of its own, so these live here, where vitest
 * already runs. A test proving a good value is accepted says nothing about
 * whether the schema is doing any work — every one of these asserts a refusal.
 */

const VALID_REQUEST = {
	concept: "art deco paisley in deep jewel tones",
	motif_ref: "patterns/motif.jpg",
	design_session_id: "design-1",
};

describe("IrisRequestSchema", () => {
	it("accepts a request carrying a design_session_id", () => {
		expect(IrisRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
	});

	it("rejects a request with no design_session_id", () => {
		const { design_session_id: _absent, ...withoutIt } = VALID_REQUEST;

		// The locked decision for this ticket: required, no fallback, no minted id.
		// A run that cannot be traced back to a design still spends money and still
		// lands in the audit table, so it must not start.
		const parsed = IrisRequestSchema.safeParse(withoutIt);
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues)).toContain("design_session_id");
	});

	it("rejects the old source_p_invoc_id name instead of quietly accepting it", () => {
		// Deliberately not aliased. A caller still on the old name gets a 400 that
		// names the new one, rather than a run whose design id silently came from
		// a field nothing else in the system reads any more.
		const parsed = IrisRequestSchema.safeParse({
			concept: VALID_REQUEST.concept,
			motif_ref: VALID_REQUEST.motif_ref,
			source_p_invoc_id: "helios-run-1",
		});

		expect(parsed.success).toBe(false);
	});

	it("rejects an empty or whitespace-only design_session_id", () => {
		expect(IrisRequestSchema.safeParse({ ...VALID_REQUEST, design_session_id: "" }).success).toBe(false);
		expect(IrisRequestSchema.safeParse({ ...VALID_REQUEST, design_session_id: "   " }).success).toBe(false);
	});

	it("rejects an empty concept and an empty motif_ref", () => {
		expect(IrisRequestSchema.safeParse({ ...VALID_REQUEST, concept: "" }).success).toBe(false);
		expect(IrisRequestSchema.safeParse({ ...VALID_REQUEST, motif_ref: "" }).success).toBe(false);
	});

	it("rejects an over-long concept rather than sending it to a model", () => {
		expect(IrisRequestSchema.safeParse({ ...VALID_REQUEST, concept: "x".repeat(1001) }).success).toBe(false);
	});

	it("treats session_id as optional, because it only picks the Durable Object", () => {
		expect(IrisRequestSchema.safeParse({ ...VALID_REQUEST, session_id: "session-1" }).success).toBe(true);
		expect(IrisRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
	});
});

describe("IrisResumeRequestSchema", () => {
	it("takes a pipeline_id, since a resume names one run of one engine", () => {
		expect(IrisResumeRequestSchema.safeParse({ pipeline_id: "run-a" }).success).toBe(true);
	});

	it("rejects a resume that names no pipeline_id", () => {
		expect(IrisResumeRequestSchema.safeParse({}).success).toBe(false);
	});

	it("rejects a design_session_id in place of a pipeline_id", () => {
		// A design has many runs; resuming "the design" is not a thing that can be
		// acted on. The distinction is the whole reason the two ids are separate.
		expect(IrisResumeRequestSchema.safeParse({ design_session_id: "design-1" }).success).toBe(false);
	});
});

describe("IrisParamsSchema", () => {
	it("accepts both fixtures, so the fakes stay valid as the vocabulary changes", () => {
		expect(IrisParamsSchema.safeParse(sampleParamsFull).success).toBe(true);
		expect(IrisParamsSchema.safeParse(sampleParamsMinimal).success).toBe(true);
	});

	it("rejects a colour name outside the controlled vocabulary", () => {
		// The reason the vocabulary is an enum: nothing downstream can map
		// "dark jewel green" onto a hex value.
		expect(IrisParamsSchema.safeParse({ ...sampleParamsFull, primary_color: "dark jewel green" }).success).toBe(false);
	});

	it("rejects params with no primary_color", () => {
		const { primary_color: _absent, ...withoutIt } = sampleParamsFull;

		// A single-colour scheme is legitimate; a scheme with no colour at all is
		// not, which is why this one field is required and the other two are not.
		expect(IrisParamsSchema.safeParse(withoutIt).success).toBe(false);
	});

	it("rejects an unknown harmony, saturation or background treatment", () => {
		expect(IrisParamsSchema.safeParse({ ...sampleParamsFull, harmony: "tetradic" }).success).toBe(false);
		expect(IrisParamsSchema.safeParse({ ...sampleParamsFull, saturation: "loud" }).success).toBe(false);
		expect(IrisParamsSchema.safeParse({ ...sampleParamsFull, background_treatment: "blurred" }).success).toBe(false);
	});

	it("rejects an empty mood, which would carry no concept at all", () => {
		expect(IrisParamsSchema.safeParse({ ...sampleParamsFull, mood: "  " }).success).toBe(false);
	});

	it("rejects the half-built params object that used to pass the tests", () => {
		// This exact value sat in do.repository.test.ts behind an `as never` and
		// was never checked by anything. It is here so it can never come back.
		expect(IrisParamsSchema.safeParse({ primary_color: "gold" }).success).toBe(false);
	});
});

describe("IrisResultSchema", () => {
	const VALID_RESULT = {
		pipeline_id: "run-a",
		design_session_id: "design-1",
		status: "completed",
		params: sampleParamsFull,
		image_url: "http://localhost:8787/images/iris/run-a.jpg",
		width: 128,
		height: 128,
		cost_usd: 0.05,
		error: null,
	};

	it("accepts a completed result, and a failed one with everything nulled", () => {
		expect(IrisResultSchema.safeParse(VALID_RESULT).success).toBe(true);
		expect(
			IrisResultSchema.safeParse({
				...VALID_RESULT,
				status: "failed",
				params: null,
				image_url: null,
				width: null,
				height: null,
				cost_usd: null,
				error: "image: flux down",
			}).success,
		).toBe(true);
	});

	it("rejects a result missing either id", () => {
		const { pipeline_id: _p, ...noPipeline } = VALID_RESULT;
		const { design_session_id: _d, ...noDesign } = VALID_RESULT;

		// Atlas validates this at runtime and carries design_session_id forward.
		// A result missing one is a break in the chain, not a cosmetic omission.
		expect(IrisResultSchema.safeParse(noPipeline).success).toBe(false);
		expect(IrisResultSchema.safeParse(noDesign).success).toBe(false);
	});

	it("rejects a status outside running/completed/failed", () => {
		expect(IrisResultSchema.safeParse({ ...VALID_RESULT, status: "done" }).success).toBe(false);
	});

	it("rejects zero or negative dimensions", () => {
		expect(IrisResultSchema.safeParse({ ...VALID_RESULT, width: 0 }).success).toBe(false);
		expect(IrisResultSchema.safeParse({ ...VALID_RESULT, height: -1 }).success).toBe(false);
	});
});
