import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IrisRequest } from "@aureline/shared-types";
import { runPipeline, runImageStage } from "./pipeline";
import { resolveConfig } from "../config";
import { planConcept } from "./planner";
import { colorizeMotif } from "./colorizer";
import { readGatewayCost } from "./gatewayCost";
import { startTextRun, failRunningRuns, startImageRun, getRunRows } from "../repository/do.repository";
import { irisRuns } from "../db/schema";
import { createTestDb, insertRow } from "../repository/test-db";
import { sampleParamsFull, sampleParamsMinimal } from "../fixtures/sample-params";
import { json } from "../http";
import { fakeEnv } from "./test-env";

// The planner, the colorizer and the storage writes are imported by
// pipeline.ts, so mocking these modules (with a delegate that calls the real
// thing by default) is how a test injects a failure and pipeline.ts sees it.
// The delegate keeps every other test on the real implementation.
vi.mock("./planner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./planner")>();
	return { ...actual, planConcept: vi.fn(actual.planConcept) };
});

vi.mock("./colorizer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./colorizer")>();
	return { ...actual, colorizeMotif: vi.fn(actual.colorizeMotif) };
});

// The cost read is the one thing here with no observable behaviour of its own —
// against a fake env it always returns null, so every test would exercise the
// same path and none would prove the number ever reaches a row. The delegate
// keeps that default and lets two tests below force a real value.
vi.mock("./gatewayCost", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./gatewayCost")>();
	return { ...actual, readGatewayCost: vi.fn(actual.readGatewayCost) };
});

vi.mock("../repository/do.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../repository/do.repository")>();
	return {
		...actual,
		startTextRun: vi.fn(actual.startTextRun),
		failRunningRuns: vi.fn(actual.failRunningRuns),
		startImageRun: vi.fn(actual.startImageRun),
		getRunRows: vi.fn(actual.getRunRows),
	};
});

const ORIGIN = "http://localhost:8787";

const REQ: IrisRequest = {
	concept: "art deco paisley in deep jewel tones",
	motif_ref: "patterns/fake.jpg",
	design_session_id: "helios-test-1",
};

async function rowsFor(db: ReturnType<typeof createTestDb>, pipelineId: string) {
	return db.select().from(irisRuns).where(eq(irisRuns.pipelineId, pipelineId));
}

describe("runPipeline", () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
		// These mocks carry live delegates from `vi.fn(actual.x)`, and several
		// tests queue a `...Once` value. `mockReset` drains that queue and puts
		// the delegate back, so a test that fails before consuming its queued
		// value cannot leak it into the next one.
		vi.mocked(planConcept).mockReset();
		vi.mocked(colorizeMotif).mockReset();
		vi.mocked(startTextRun).mockReset();
		vi.mocked(failRunningRuns).mockReset();
		vi.mocked(startImageRun).mockReset();
		vi.mocked(getRunRows).mockReset();
		vi.mocked(readGatewayCost).mockReset();
	});

	it("fails the run when the image row cannot be read back, instead of reporting no dimensions", async () => {
		const { env } = fakeEnv();
		// The write path silently lost the row. Before this guard existed, the
		// read-back fell through to `width: null, height: null` and the run was
		// reported completed — Atlas would then receive a finished-looking run with
		// no dimensions and nothing indicating anything had gone wrong.
		vi.mocked(getRunRows).mockResolvedValueOnce([]);

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^image:/);
		expect(result.error).toMatch(/vanished between writing and reading it back/);
		expect(result.width).toBeNull();
		expect(result.height).toBeNull();
	});

	it("completes a happy path with real params, a full image url, and width/height", async () => {
		const { env } = fakeEnv();

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		expect(result.params).toEqual(sampleParamsFull);
		expect(result.design_session_id).toBe(REQ.design_session_id);
		expect(result.image_url).toBe(`${ORIGIN}/images/iris/${result.pipeline_id}.jpg`);
		expect(result.width).toBe(128);
		expect(result.height).toBe(128);
		expect(result.cost_usd).toBeNull();
		expect(result.error).toBeNull();

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(2);
		const textRow = rows.find((row) => row.modality === "text");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(textRow?.status).toBe("completed");
		expect(imageRow?.status).toBe("completed");
		expect(imageRow?.motifRef).toBe(REQ.motif_ref);
		expect(textRow?.designSessionId).toBe(REQ.design_session_id);
		expect(imageRow?.designSessionId).toBe(REQ.design_session_id);

		// iris-08: text row metadata carries model, usage, and prompt_version
		const textMeta = textRow?.modelMetadata as Record<string, unknown>;
		expect(textMeta).toHaveProperty("model", "@cf/openai/gpt-oss-120b");
		expect(textMeta).toHaveProperty("prompt_version", "iris-planner-v1");
		expect(textMeta).toHaveProperty("usage");
	});

	it("records what the planner call cost on the text row", async () => {
		const { env } = fakeEnv();
		// A real figure, not a round number: a test asserting 1 would still pass
		// against code that wrote a hardcoded 1, and this is the only assertion
		// anywhere that the gateway's number reaches a row at all.
		vi.mocked(readGatewayCost).mockResolvedValueOnce(0.00087);

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");

		const rows = await rowsFor(db, result.pipeline_id);
		const textRow = rows.find((row) => row.modality === "text");
		expect(textRow?.costUsd).toBe(0.00087);

		// It belongs to the text row only. `result.cost_usd` is the image's, and
		// the image call is still faked, so conflating the two would show up here.
		expect(result.cost_usd).toBeNull();
	});

	it("completes the run when the planner cost cannot be read", async () => {
		const { env } = fakeEnv();
		// `readGatewayCost` returns null on all three of its failure paths — no log
		// id, a throw, a log carrying no cost. Cost is an audit concern, and a run
		// that produced a good palette must not fail because a log row was slow
		// (iris-08 decision 5).
		vi.mocked(readGatewayCost).mockResolvedValueOnce(null);

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		expect(result.params).toEqual(sampleParamsFull);

		const rows = await rowsFor(db, result.pipeline_id);
		const textRow = rows.find((row) => row.modality === "text");
		expect(textRow?.status).toBe("completed");
		expect(textRow?.costUsd).toBeNull();
	});

	it("accepts params carrying only the required primary_color, with no secondary or accent color", async () => {
		// Exercises the other fixture in sample-params.ts: sampleParamsFull covers
		// all three optional color fields, this one covers none of them. Both have
		// to clear the validate stage, not just be schema-valid in isolation.
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockResolvedValueOnce({ data: sampleParamsMinimal, model: "test", usage: {} });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		expect(result.params).toEqual(sampleParamsMinimal);
		expect(result.params?.secondary_color).toBeUndefined();
		expect(result.params?.accent_color).toBeUndefined();
	});

	it("marks a planner failure as one failed text row and one failed image row", async () => {
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockRejectedValueOnce(new Error("boom"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toBeNull();
		expect(result.image_url).toBeNull();
		expect(result.cost_usd).toBeNull();
		expect(result.error).toMatch(/^planner:/);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("failed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("failed");
	});

	it("keeps the planner's params on the result when only the image fails", async () => {
		const { env } = fakeEnv();
		vi.mocked(colorizeMotif).mockRejectedValueOnce(new Error("flux down"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toEqual(sampleParamsFull);
		expect(result.image_url).toBeNull();
		expect(result.error).toMatch(/^image:/);

		const rows = await rowsFor(db, result.pipeline_id);
		const textRow = rows.find((row) => row.modality === "text");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(textRow?.status).toBe("completed");
		expect(textRow?.plannerParams).toEqual(sampleParamsFull);
		expect(imageRow?.status).toBe("failed");
	});

	it("returns a settled failed result when storage itself is unavailable, rather than throwing", async () => {
		const { env } = fakeEnv();
		vi.mocked(startTextRun).mockRejectedValueOnce(new Error("storage down"));
		// The cleanup write breaks too, and must not escape as a throw.
		vi.mocked(failRunningRuns).mockRejectedValueOnce(new Error("cleanup down"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^persist:/);
	});

	it("still records a failed image row when opening that row is what failed", async () => {
		const { env } = fakeEnv();
		vi.mocked(startImageRun).mockRejectedValueOnce(new Error("storage hiccup"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^image:/);
		expect(result.params).toEqual(sampleParamsFull);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("failed");
	});

	it("leaves a concurrent invocation's running row alone", async () => {
		await insertRow(db, { pipelineId: "other-inflight", modality: "text", status: "running" });
		await insertRow(db, { pipelineId: "other-inflight", modality: "image", status: "running" });
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockRejectedValueOnce(new Error("boom"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");

		const other = await rowsFor(db, "other-inflight");
		expect(other).toHaveLength(2);
		expect(other.every((row) => row.status === "running")).toBe(true);
	});
});

describe("runImageStage re-entry (iris-10's /resume)", () => {
	// iris-10 does not exist yet, so this calls runImageStage exactly the way a
	// resume would: a fresh pipeline_id, params read back from a prior run rather
	// than from the planner, and a non-empty metadataExtras carrying the markers
	// a resume needs on the image row. runPipeline itself only ever calls this
	// with the default {}, so without this test the merge path is unexercised.
	it("merges metadataExtras over the image row's model metadata alongside width/height", async () => {
		const db = createTestDb();
		const { env } = fakeEnv();

		const resumeMarker = { root: "original-run-id", resumed_from: "original-run-id", attempt: 2 };
		const newInvocId = "resumed-run-id";
		const config = await resolveConfig(env);

		const outcome = await runImageStage(db, env, config, {
			pipelineId: newInvocId,
			designSessionId: REQ.design_session_id,
			concept: REQ.concept,
			motifRef: REQ.motif_ref,
			params: sampleParamsFull,
			metadataExtras: resumeMarker,
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.width).toBe(128);
		expect(outcome.height).toBe(128);

		const rows = await rowsFor(db, newInvocId);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.status).toBe("completed");
		const metadata = row?.modelMetadata as { root?: string; resumed_from?: string; attempt?: number; width?: number };
		// The resume markers survive...
		expect(metadata.root).toBe("original-run-id");
		expect(metadata.resumed_from).toBe("original-run-id");
		expect(metadata.attempt).toBe(2);
		// ...alongside width/height, which completeImageRun adds after the markers
		// are already on the row.
		expect(metadata.width).toBe(128);
	});
});

describe("HTTP layer contract (decision 3)", () => {
	it("returns HTTP 200 for a failed run, not just a body that says failed", async () => {
		const db = createTestDb();
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockReset();
		vi.mocked(planConcept).mockRejectedValueOnce(new Error("boom"));

		const result = await runPipeline(db, REQ, env, ORIGIN);
		expect(result.status).toBe("failed");

		const response = json(result);
		expect(response.status).toBe(200);
		expect((await response.json()) as typeof result).toMatchObject({ status: "failed" });
	});
});
