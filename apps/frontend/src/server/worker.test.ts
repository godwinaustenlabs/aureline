import { describe, expect, it, beforeEach } from "vitest";
import worker from "./worker";
import { createTestD1, seed } from "./test-db";

const LONG = "You are a textile designer. Return only the JSON object, no prose.";

/**
 * The route against real databases.
 *
 * `ASSETS` answers a marker so the fall-through can be told apart from a route
 * that matched. The cast is the one this file needs: `Env` is generated from
 * wrangler.jsonc and describes runtime bindings that cannot be constructed
 * outside a Worker.
 */
function fakeEnv() {
	const irisDb = createTestD1();
	const heliosDb = createTestD1();
	const env = {
		IRIS_DB: irisDb,
		HELIOS_DB: heliosDb,
		ASSETS: { fetch: async () => new Response("the page") },
	} as unknown as Env;
	return { env, irisDb, heliosDb };
}

const get = (env: Env, query: string) =>
	worker.fetch(new Request(`https://playground.test/api/prompts${query}`), env);

const put = (env: Env, body: unknown) =>
	worker.fetch(
		new Request("https://playground.test/api/prompts", { method: "PUT", body: JSON.stringify(body) }),
		env,
	);

describe("GET /api/prompts", () => {
	let fake: ReturnType<typeof fakeEnv>;

	beforeEach(() => {
		fake = fakeEnv();
	});

	it("returns every slot of the engine", async () => {
		await seed(fake.irisDb, "iris_planner", LONG);

		const response = await get(fake.env, "?engine=iris");
		const body = (await response.json()) as { engine: string; prompts: { slot: string; promptText: string | null }[] };

		expect(response.status).toBe(200);
		expect(body.engine).toBe("iris");
		expect(body.prompts.map((p) => p.slot)).toEqual(["iris_planner", "iris_color"]);
		expect(body.prompts[0]?.promptText).toBe(LONG);
	});

	it("reads the other engine's database when asked for helios", async () => {
		await seed(fake.heliosDb, "helios_planner", LONG);

		const body = (await (await get(fake.env, "?engine=helios")).json()) as {
			prompts: { slot: string; promptText: string | null }[];
		};

		expect(body.prompts.find((p) => p.slot === "helios_planner")?.promptText).toBe(LONG);
	});

	it("refuses an unknown engine rather than guessing one", async () => {
		expect((await get(fake.env, "?engine=atlas")).status).toBe(400);
		expect((await get(fake.env, "")).status).toBe(400);
	});

	/** A prompt edited a second ago must never be served from a cache. */
	it("marks the response no-store", async () => {
		expect((await get(fake.env, "?engine=iris")).headers.get("cache-control")).toBe("no-store");
	});
});

describe("PUT /api/prompts", () => {
	let fake: ReturnType<typeof fakeEnv>;

	beforeEach(() => {
		fake = fakeEnv();
	});

	it("saves a prompt and reports when it was stored", async () => {
		const response = await put(fake.env, { engine: "iris", slot: "iris_planner", prompt_text: LONG });
		const body = (await response.json()) as { updated_at: string | null };

		expect(response.status).toBe(200);
		expect(body.updated_at).toBeTruthy();

		const stored = (await (await get(fake.env, "?engine=iris")).json()) as {
			prompts: { slot: string; promptText: string | null }[];
		};
		expect(stored.prompts.find((p) => p.slot === "iris_planner")?.promptText).toBe(LONG);
	});

	it("overwrites on the second save instead of adding a row", async () => {
		await put(fake.env, { engine: "iris", slot: "iris_planner", prompt_text: LONG });
		await put(fake.env, { engine: "iris", slot: "iris_planner", prompt_text: `${LONG} Edited.` });

		const { results } = await fake.irisDb.prepare("SELECT slot FROM prompts").all();
		expect(results).toHaveLength(1);
	});

	/**
	 * The whitelist doing its job. Without it this writes a row into iris-d1 that
	 * no engine will ever read — a save that appears to work and changes nothing.
	 */
	it("refuses a slot belonging to the other engine, and writes nothing", async () => {
		const response = await put(fake.env, { engine: "iris", slot: "helios_planner", prompt_text: LONG });

		expect(response.status).toBe(400);
		expect((await fake.irisDb.prepare("SELECT slot FROM prompts").all()).results).toHaveLength(0);
	});

	/**
	 * Refused here rather than saved and then ignored by the engine's own
	 * `MIN_PROMPT_LENGTH` guard, which is what would otherwise happen: a save that
	 * succeeds on screen and never reaches a model.
	 */
	it("refuses a prompt too short to be real, and writes nothing", async () => {
		const response = await put(fake.env, { engine: "iris", slot: "iris_planner", prompt_text: "todo" });

		expect(response.status).toBe(422);
		expect((await fake.irisDb.prepare("SELECT slot FROM prompts").all()).results).toHaveLength(0);
	});

	it("refuses whitespace dressed up as a prompt", async () => {
		expect(
			(await put(fake.env, { engine: "iris", slot: "iris_planner", prompt_text: " ".repeat(200) })).status,
		).toBe(422);
	});

	it("refuses a body that is not JSON, and a prompt_text that is not a string", async () => {
		const notJson = await worker.fetch(
			new Request("https://playground.test/api/prompts", { method: "PUT", body: "{" }),
			fake.env,
		);
		expect(notJson.status).toBe(400);
		expect((await put(fake.env, { engine: "iris", slot: "iris_planner", prompt_text: 42 })).status).toBe(400);
	});
});

describe("routing", () => {
	it("refuses methods that are neither read nor overwrite", async () => {
		const { env } = fakeEnv();
		const response = await worker.fetch(
			new Request("https://playground.test/api/prompts", { method: "DELETE" }),
			env,
		);

		// There is no delete. A slot's row always exists once created.
		expect(response.status).toBe(405);
	});

	it("hands anything else to the asset server", async () => {
		const { env } = fakeEnv();
		const response = await worker.fetch(new Request("https://playground.test/"), env);

		expect(await response.text()).toBe("the page");
	});
});
