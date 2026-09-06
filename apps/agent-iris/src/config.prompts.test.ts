import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getD1Db, type IrisD1Db } from "./db/client";
import { prompts } from "./db/schema.d1";
import { createFailingD1, createTestD1 } from "./repository/test-db";
import { upsertPrompt } from "./repository/prompts.repository";
import { describePrompt, resolvePrompt } from "./config";

/**
 * `resolvePrompt` needs a database, and `config.test.ts` deliberately does not —
 * its whole point is that `ConfigEnv` is narrow enough to fake without one. The
 * two live in separate files so that stays true.
 */

/** Stands in for `buildPlannerSystemPrompt()`. Long enough to clear the guard. */
const FALLBACK = "You are a textile colour designer. Return only the JSON object.";
const STORED = "You are a textile colour designer, rewritten in the playground.";

describe("resolvePrompt", () => {
	let d1: IrisD1Db;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		d1 = getD1Db(createTestD1());
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
	});

	it("sends the stored prompt when the row exists", async () => {
		await upsertPrompt(d1, { slot: "iris_planner", promptText: STORED });

		const resolved = await resolvePrompt(d1, "iris_planner", FALLBACK);

		expect(resolved.text).toBe(STORED);
		expect(resolved.source).toBe("db");
		expect(resolved.updatedAt).toBeTruthy();
	});

	/** The rollout case: a slot nobody has seeded yet must behave exactly as before. */
	it("falls back to the committed prompt when the slot has no row, silently", async () => {
		const resolved = await resolvePrompt(d1, "iris_planner", FALLBACK);

		expect(resolved.text).toBe(FALLBACK);
		expect(resolved.source).toBe("code");
		expect(resolved.updatedAt).toBeNull();
		// A missing row is expected, not a problem. Warning on it would mean every
		// request logged a warning for every slot until all of them were seeded.
		expect(warn).not.toHaveBeenCalled();
	});

	it("reads only its own slot", async () => {
		await upsertPrompt(d1, { slot: "iris_color", promptText: STORED });

		expect((await resolvePrompt(d1, "iris_planner", FALLBACK)).source).toBe("code");
	});

	/**
	 * A row that exists but holds nothing usable is not the same as no row, and
	 * the difference matters: an empty system prompt is not an error the model
	 * reports, it is a billed call that comes back unusable (AGENTS.md §7).
	 *
	 * Inserted around `upsertPrompt`, which refuses text this short — this is the
	 * row someone writes by hand in the dashboard.
	 */
	it("falls back and warns when the stored prompt is too short to be real", async () => {
		await d1.insert(prompts).values({ slot: "iris_planner", promptText: "todo" });

		const resolved = await resolvePrompt(d1, "iris_planner", FALLBACK);

		expect(resolved.text).toBe(FALLBACK);
		expect(resolved.source).toBe("code");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("iris_planner"));
	});

	it("treats a whitespace-only prompt as unusable", async () => {
		await d1.insert(prompts).values({ slot: "iris_planner", promptText: "                              " });

		expect((await resolvePrompt(d1, "iris_planner", FALLBACK)).source).toBe("code");
	});

	/**
	 * A prompt is policy, not a dependency the engine cannot run without. D1 being
	 * unavailable has to degrade to the committed prompt rather than fail the
	 * request — the same trade `resolveConfig` makes when KV is down.
	 */
	it("falls back and warns when the database read throws", async () => {
		const failing = getD1Db(createFailingD1());

		const resolved = await resolvePrompt(failing, "iris_planner", FALLBACK);

		expect(resolved.text).toBe(FALLBACK);
		expect(resolved.source).toBe("code");
		expect(warn).toHaveBeenCalled();
	});
});

describe("describePrompt", () => {
	it("names the store and the length, and the edit time when there is one", () => {
		expect(describePrompt("iris_planner", { text: STORED, source: "db", updatedAt: "2026-09-01 12:45:16" })).toBe(
			`prompt: iris_planner=${STORED.length}chars (db, updated 2026-09-01 12:45:16)`,
		);
	});

	it("omits the edit time for the committed prompt, which has none", () => {
		expect(describePrompt("iris_planner", { text: FALLBACK, source: "code", updatedAt: null })).toBe(
			`prompt: iris_planner=${FALLBACK.length}chars (code)`,
		);
	});
});
