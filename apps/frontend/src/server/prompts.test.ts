import { describe, expect, it, beforeEach } from "vitest";
import { ENGINE_SLOTS, isEngineName, isSlotOf, listPrompts, savePrompt } from "./prompts";
import { createTestD1, seed } from "./test-db";

const PROMPT = "You are a textile designer. Return only the JSON object.";

describe("listPrompts", () => {
	let db: D1Database;

	beforeEach(() => {
		db = createTestD1();
	});

	/**
	 * The screen renders one box per slot, so an empty table has to come back as
	 * empty boxes rather than as nothing at all — otherwise there is no way to
	 * create the first row.
	 */
	it("returns every slot of the engine, empty, before anything is stored", async () => {
		const view = await listPrompts(db, "iris");

		expect(view.map((p) => p.slot)).toEqual([...ENGINE_SLOTS.iris]);
		expect(view.every((p) => p.promptText === null && p.updatedAt === null)).toBe(true);
	});

	it("fills in the slots that have rows and leaves the rest empty", async () => {
		await seed(db, "iris_planner", PROMPT);

		const view = await listPrompts(db, "iris");

		expect(view.find((p) => p.slot === "iris_planner")?.promptText).toBe(PROMPT);
		expect(view.find((p) => p.slot === "iris_planner")?.updatedAt).toBeTruthy();
		expect(view.find((p) => p.slot === "iris_color")?.promptText).toBeNull();
	});

	/** Each engine has its own database, so a slot of the other one never shows. */
	it("ignores rows belonging to another engine's slots", async () => {
		await seed(db, "helios_planner", PROMPT);

		const view = await listPrompts(db, "iris");

		expect(view.every((p) => p.promptText === null)).toBe(true);
	});
});

describe("savePrompt", () => {
	let db: D1Database;

	beforeEach(() => {
		db = createTestD1();
	});

	it("creates the row the first time", async () => {
		await savePrompt(db, "iris_planner", PROMPT);

		expect((await listPrompts(db, "iris")).find((p) => p.slot === "iris_planner")?.promptText).toBe(PROMPT);
	});

	/** One row per slot. Editing overwrites; it never accumulates candidates. */
	it("overwrites rather than adding a second row", async () => {
		await savePrompt(db, "iris_planner", PROMPT);
		await savePrompt(db, "iris_planner", "Rewritten, and this is the only version that survives.");

		const { results } = await db.prepare("SELECT slot FROM prompts").all();
		expect(results).toHaveLength(1);
		expect((await listPrompts(db, "iris")).find((p) => p.slot === "iris_planner")?.promptText).toBe(
			"Rewritten, and this is the only version that survives.",
		);
	});

	/**
	 * SQLite has no `ON UPDATE`, so `DEFAULT CURRENT_TIMESTAMP` fires on INSERT
	 * only. The row is seeded with an old timestamp because the default has
	 * one-second resolution — two writes in the same second are indistinguishable,
	 * so a test that just wrote twice would pass either way.
	 */
	it("moves updated_at forward on an edit", async () => {
		await seed(db, "iris_planner", PROMPT, "2000-01-01 00:00:00");

		const updatedAt = await savePrompt(db, "iris_planner", "Rewritten, and long enough to be a real prompt.");

		expect(updatedAt).not.toBe("2000-01-01 00:00:00");
		expect(updatedAt).toBeTruthy();
	});
});

describe("slot whitelist", () => {
	it("accepts only the two engine names", () => {
		expect(isEngineName("iris")).toBe(true);
		expect(isEngineName("helios")).toBe(true);
		expect(isEngineName("atlas")).toBe(false);
		expect(isEngineName(undefined)).toBe(false);
	});

	/**
	 * The check that stops a write from landing in a row no engine reads — which
	 * would look exactly like a save that silently did nothing.
	 */
	it("refuses a slot that does not belong to the engine", () => {
		expect(isSlotOf("iris", "iris_planner")).toBe(true);
		expect(isSlotOf("iris", "helios_planner")).toBe(false);
		expect(isSlotOf("helios", "iris_color")).toBe(false);
		expect(isSlotOf("iris", "made_up")).toBe(false);
		expect(isSlotOf("iris", 42)).toBe(false);
	});
});
