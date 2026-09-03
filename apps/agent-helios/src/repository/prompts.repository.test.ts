import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getD1Db, type HeliosD1Db } from "../db/client";
import { prompts } from "../db/schema.d1";
import { createTestD1 } from "./test-db";
import { getPrompt, listPrompts, upsertPrompt } from "./prompts.repository";

/** A prompt long enough to be a plausible one, so length is never why a test passes. */
const PROMPT = "You are a textile designer. Return only the JSON object.";

describe("prompts repository", () => {
	let d1: HeliosD1Db;

	beforeEach(() => {
		d1 = getD1Db(createTestD1());
	});

	it("stores a prompt and reads it back", async () => {
		await upsertPrompt(d1, { slot: "helios_planner", promptText: PROMPT });

		const row = await getPrompt(d1, "helios_planner");

		expect(row?.slot).toBe("helios_planner");
		expect(row?.promptText).toBe(PROMPT);
	});

	it("returns null for a slot that has never been written", async () => {
		expect(await getPrompt(d1, "helios_planner")).toBeNull();
	});

	it("lists every stored prompt", async () => {
		await upsertPrompt(d1, { slot: "helios_planner", promptText: PROMPT });
		await upsertPrompt(d1, { slot: "helios_classifier", promptText: `${PROMPT} Second slot.` });

		const slots = (await listPrompts(d1)).map((row) => row.slot).sort();

		expect(slots).toEqual(["helios_classifier", "helios_planner"].sort());
	});

	/**
	 * The one-row-per-slot invariant. Editing overwrites; it never accumulates a
	 * second candidate, because there is no mechanism to choose between two.
	 */
	it("overwrites the existing row rather than adding a second one", async () => {
		await upsertPrompt(d1, { slot: "helios_planner", promptText: PROMPT });
		await upsertPrompt(d1, { slot: "helios_planner", promptText: "Rewritten." });

		const rows = await d1.select().from(prompts).where(eq(prompts.slot, "helios_planner"));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.promptText).toBe("Rewritten.");
	});

	/**
	 * The regression test for the trap in `schema.d1.ts`: SQLite has no
	 * `ON UPDATE`, so `DEFAULT CURRENT_TIMESTAMP` fires on INSERT only. The row
	 * is seeded with an old timestamp because `CURRENT_TIMESTAMP` has one-second
	 * resolution — two writes in the same second are indistinguishable, so a test
	 * that just wrote twice would pass whether or not the column was set.
	 */
	it("moves updated_at forward when a prompt is edited", async () => {
		await d1.insert(prompts).values({
			slot: "helios_planner",
			promptText: PROMPT,
			updatedAt: "2000-01-01 00:00:00",
		});

		await upsertPrompt(d1, { slot: "helios_planner", promptText: "Rewritten." });

		expect((await getPrompt(d1, "helios_planner"))?.updatedAt).not.toBe("2000-01-01 00:00:00");
	});

	/**
	 * The other half of the same fact, and the reason `upsertPrompt` sets the
	 * column by hand: an UPDATE that leaves `updated_at` alone keeps the original
	 * value forever. If this ever fails, SQLite grew an `ON UPDATE` default and
	 * the explicit set is no longer load-bearing.
	 */
	it("proves the column default does not fire on a plain UPDATE", async () => {
		await d1.insert(prompts).values({
			slot: "helios_planner",
			promptText: PROMPT,
			updatedAt: "2000-01-01 00:00:00",
		});

		await d1.update(prompts).set({ promptText: "Rewritten." }).where(eq(prompts.slot, "helios_planner"));

		expect((await getPrompt(d1, "helios_planner"))?.updatedAt).toBe("2000-01-01 00:00:00");
	});

	it("refuses a blank prompt and stores nothing", async () => {
		await expect(upsertPrompt(d1, { slot: "helios_planner", promptText: "   " })).rejects.toThrow(/empty prompt/);

		expect(await getPrompt(d1, "helios_planner")).toBeNull();
	});

	it("leaves an existing prompt intact when a blank edit is refused", async () => {
		await upsertPrompt(d1, { slot: "helios_planner", promptText: PROMPT });

		await expect(upsertPrompt(d1, { slot: "helios_planner", promptText: "" })).rejects.toThrow(/empty prompt/);

		expect((await getPrompt(d1, "helios_planner"))?.promptText).toBe(PROMPT);
	});

	/** The unique index is the database's own copy of the one-row rule. */
	it("rejects a second row for the same slot inserted around the repository", async () => {
		await upsertPrompt(d1, { slot: "helios_planner", promptText: PROMPT });

		await expect(
			d1.insert(prompts).values({ slot: "helios_planner", promptText: "Smuggled in." }),
		).rejects.toThrow();
	});
});
