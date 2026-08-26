import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./repository/test-db";
import type { AtlasDb } from "./db/client";

/**
 * Tests `onRequest` at the HTTP level: a real `Request` in, a real `Response`
 * out, with the **status code** asserted and not only the body.
 *
 * Two things stand in for the Workers runtime:
 *
 * - The `agents` SDK is mocked, because importing it pulls in
 *   `cloudflare:workers`, which the default ESM loader cannot resolve. Only the
 *   `Agent` base class is needed, and only for its constructor.
 * - `getDb` is pointed at the in-memory harness, so `ctx.storage` is never read
 *   and the fake context can stay a single empty object.
 *
 * This is not a substitute for a real Worker-boundary harness
 * (`@cloudflare/vitest-pool-workers`), which the repo still lacks for every
 * engine — see docs/spec.md. It does cover every branch of the controller,
 * which is what this file is for.
 */

/** Stands in for the SDK's `Agent`, which this class needs only for ctx/env. */
class FakeAgentBase {
	constructor(
		readonly ctx: DurableObjectState,
		readonly env: Env,
	) {}
}

vi.mock("agents", () => ({ Agent: FakeAgentBase }));

// `agent.ts` imports the generated migrations, which pull in raw `.sql` files.
// Wrangler resolves those through a build rule; vitest tries to parse them as
// JavaScript and fails. Only `onStart` uses them and no test here calls it.
vi.mock("../drizzle/migrations", () => ({ default: { journal: {}, migrations: {} } }));

let testDb: ReturnType<typeof createTestDb>;

vi.mock("./db/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./db/client")>();
	// Drizzle's sqlite-proxy driver is declared `mode: "async"` and the
	// durable-sqlite one `mode: "sync"`, so the two database types are not
	// assignable even though both are Drizzle over sqlite-core and both run the
	// same SQL. That difference is the untyped boundary here; every query in
	// this file is a real one against a real in-memory SQLite.
	return { ...actual, getDb: () => testDb as unknown as AtlasDb };
});

const { AtlasAgent } = await import("./agent");

const VARS = {
	IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-9b",
	AI_GATEWAY_ID: "atlas",
	MAX_RETRIES: "2",
	RETENTION_LIMIT: "5",
	MAX_RESUME_ATTEMPTS: "3",
};

const aiRun = vi.fn(async () => {
	throw new Error("the AI binding must never be reached in atlas-06");
});

/** The bindings the controller actually reaches, and nothing else. */
function fakeEnv(): Env {
	const env: Record<string, unknown> = {
		...VARS,
		AI: { run: aiRun },
		CONFIG: { get: vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, null]))) },
		PATTERNS: { put: vi.fn(async () => ({})), get: vi.fn(async () => null) },
		DB: { prepare: vi.fn(() => { throw new Error("D1 unavailable in tests"); }) },
	};
	// `Env` is generated from wrangler.jsonc and describes real platform bindings;
	// a test double cannot structurally satisfy `R2Bucket` or `Ai`. This is the
	// untyped-boundary exception, and it is confined to this one helper rather
	// than scattered through the assertions.
	return env as unknown as Env;
}

/**
 * The Durable Object context.
 *
 * The agents SDK types this as `DurableObjectState`, a platform interface with
 * sixteen methods that a test double cannot structurally satisfy. **None of
 * them is called here**: `getDb` is mocked above, and nothing else in
 * `onRequest` touches storage. That is the untyped boundary.
 */
function fakeCtx(): DurableObjectState {
	return { storage: {} } as unknown as DurableObjectState;
}

/** A real agent instance, constructed rather than cast onto. */
function agent() {
	return new AtlasAgent(fakeCtx(), fakeEnv());
}

const post = (path: string, body: unknown) =>
	new Request(`http://localhost:8787${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

const VALID = {
	pattern_ref: "iris/iris-abc.jpg",
	garment_ref: "https://example.com/shirt.jpg",
	design_session_id: "design-abc",
	garment_type: "tshirt",
	regions: ["back", "hem"],
};

beforeEach(() => {
	testDb = createTestDb();
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a failed run is HTTP 200 with a settled status in the body", () => {
	it("returns 200, not a 4xx and not a 5xx", async () => {
		// atlas-06 decision 3. This is a contract with the frontend: a page that
		// branches on `response.ok` renders every failed run as a success with a
		// blank image. The status code is asserted here so a change to it fails a
		// test rather than a demo.
		const response = await agent().onRequest(
			post("/generate", { ...VALID, garment_type: "scarf", regions: ["sleeve"] }),
		);

		expect(response.status).toBe(200);

		const body = await response.json<{ status: string; error: string }>();
		expect(body.status).toBe("failed");
		expect(body.error).toMatch(/^validate: /);
	});

	it("returns 200 for a successful run too, so the code alone tells you nothing", async () => {
		const response = await agent().onRequest(post("/generate", VALID));

		expect(response.status).toBe(200);
		expect((await response.json<{ status: string }>()).status).toBe("completed");
	});

	it("carries the design_session_id straight through to the result", async () => {
		const response = await agent().onRequest(post("/generate", VALID));

		// The design id is minted upstream and passed on untouched (AGENTS.md §3).
		expect((await response.json<{ design_session_id: string }>()).design_session_id).toBe("design-abc");
	});
});

describe("a transport error is a 4xx with no pipeline_id", () => {
	it("400s a malformed body", async () => {
		const response = await agent().onRequest(post("/generate", {}));

		expect(response.status).toBe(400);
		const body = await response.json<Record<string, unknown>>();
		// It never became an invocation, so there is no run to name.
		expect(body).not.toHaveProperty("pipeline_id");
		expect(body.error).toMatch(/pattern_ref/);
	});

	it("400s a missing design_session_id rather than minting one", async () => {
		const { design_session_id: _omitted, ...withoutDesign } = VALID;

		const response = await agent().onRequest(post("/generate", withoutDesign));

		// A run that cannot be traced back to a design is worse than a run that
		// did not happen: it still spends money and still lands in the audit table.
		expect(response.status).toBe(400);
		expect((await response.json<{ error: string }>()).error).toMatch(/design_session_id/);
	});

	it("400s a garment_ref that is not a URL", async () => {
		const response = await agent().onRequest(post("/generate", { ...VALID, garment_ref: "uploads/shirt.jpg" }));

		expect(response.status).toBe(400);
		expect((await response.json<{ error: string }>()).error).toMatch(/garment_ref/);
	});

	it("405s a non-POST to /generate", async () => {
		const response = await agent().onRequest(new Request("http://localhost:8787/generate"));

		expect(response.status).toBe(405);
	});
});

describe("GET /runs", () => {
	it("is served ahead of the POST check, so the history stays reachable", async () => {
		const response = await agent().onRequest(new Request("http://localhost:8787/runs"));

		// 405-ing this is the mistake the ordering in onRequest exists to avoid.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ runs: [] });
	});

	it("returns an envelope and rows exactly as stored", async () => {
		const a = agent();
		await a.onRequest(post("/generate", VALID));

		const body = await (await a.onRequest(new Request("http://localhost:8787/runs"))).json<{
			runs: Record<string, unknown>[];
		}>();

		expect(body.runs).toHaveLength(1);
		// camelCase, unreshaped — the stored shape is the thing worth seeing.
		expect(body.runs[0]).toHaveProperty("pipelineId");
		expect(body.runs[0]).toHaveProperty("designSessionId", "design-abc");
		expect(body.runs[0]).toHaveProperty("garmentRef", "https://example.com/shirt.jpg");
	});

	it("filters to one invocation by pipeline_id", async () => {
		const a = agent();
		const first = await (await a.onRequest(post("/generate", VALID))).json<{ pipeline_id: string }>();
		await a.onRequest(post("/generate", VALID));

		const body = await (
			await a.onRequest(new Request(`http://localhost:8787/runs?pipeline_id=${first.pipeline_id}`))
		).json<{ runs: { pipelineId: string }[] }>();

		// One row, because Atlas has one row per invocation (ADR-ATLAS-0001).
		expect(body.runs).toHaveLength(1);
		expect(body.runs[0]!.pipelineId).toBe(first.pipeline_id);
	});

	it("returns an empty list for an unknown pipeline_id rather than erroring", async () => {
		const response = await agent().onRequest(new Request("http://localhost:8787/runs?pipeline_id=nope"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ runs: [] });
	});

	it("never reaches a model", async () => {
		await agent().onRequest(new Request("http://localhost:8787/runs"));

		// Read-only and free, permanently. It is the route a page calls on load
		// and on every refresh.
		expect(aiRun).not.toHaveBeenCalled();
	});
});

describe("POST /resume", () => {
	it("validates the body before anything else", async () => {
		const response = await agent().onRequest(post("/resume", {}));

		expect(response.status).toBe(400);
		expect((await response.json<{ error: string }>()).error).toMatch(/pipeline_id/);
	});

	it("reports not-implemented rather than claiming a run happened", async () => {
		const response = await agent().onRequest(post("/resume", { pipeline_id: "whatever" }));

		// 501 and not a settled `failed` AtlasResult: nothing ran, and a result
		// would claim an invocation existed. atlas-08 builds the behaviour.
		expect(response.status).toBe(501);
		expect((await response.json<{ error: string }>()).error).toMatch(/atlas-08/);
	});
});
