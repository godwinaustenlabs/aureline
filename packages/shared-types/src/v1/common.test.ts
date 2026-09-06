import { describe, it, expect } from "vitest";
import {
	ClassificationSchema,
	DesignModeSchema,
	SearchQualitySchema,
} from "./common";

/**
 * These schemas are the boundary between a model's free-text answer and a
 * column every downstream engine reads, so what matters is what they *refuse*.
 * A test that only proves a correct object parses would still pass if the
 * schema were `z.any()` (AGENTS.md §5).
 */

describe("DesignModeSchema", () => {
	it("accepts exactly the two modes and nothing else", () => {
		expect(DesignModeSchema.parse("tile")).toBe("tile");
		expect(DesignModeSchema.parse("motif")).toBe("motif");
	});

	it("rejects a third mode, so an ambiguous brief cannot arrive as its own value", () => {
		// The classifier prompt resolves ambiguity to `tile`. If "either" or
		// "unknown" could parse, that resolution would silently become optional
		// and every consumer would have to handle a state nothing declares.
		expect(DesignModeSchema.safeParse("either").success).toBe(false);
		expect(DesignModeSchema.safeParse("unknown").success).toBe(false);
		expect(DesignModeSchema.safeParse("").success).toBe(false);
	});

	it("rejects a differently-cased mode rather than coercing it", () => {
		// A model that answers "Tile" is a model that did not follow the schema,
		// and the retry loop should see that rather than have it quietly fixed.
		expect(DesignModeSchema.safeParse("Tile").success).toBe(false);
	});
});

describe("ClassificationSchema", () => {
	it("parses a tile with no garment part, and leaves the key absent", () => {
		const parsed = ClassificationSchema.parse({ mode: "tile" });

		expect(parsed).toEqual({ mode: "tile" });
		// Absent, not present-and-undefined. A consumer doing `"garment_part" in
		// classification` must get `false`, and a JSON column must not store a
		// null that reads as "there is a part, and it is nothing".
		expect(Object.hasOwn(parsed, "garment_part")).toBe(false);
	});

	it("parses a motif with a garment part", () => {
		expect(ClassificationSchema.parse({ mode: "motif", garment_part: "neckline" })).toEqual({
			mode: "motif",
			garment_part: "neckline",
		});
	});

	it("rejects a missing mode rather than defaulting to one", () => {
		// The whole point of the classifier stage is that something decided. A
		// default here would produce a run grounded on a guess with an audit row
		// that looks exactly like a classified one.
		expect(ClassificationSchema.safeParse({}).success).toBe(false);
		expect(ClassificationSchema.safeParse({ garment_part: "cuff" }).success).toBe(false);
	});

	it("rejects an unknown mode", () => {
		expect(ClassificationSchema.safeParse({ mode: "sticker" }).success).toBe(false);
	});

	it("rejects an empty garment part, so absent and blank cannot be confused", () => {
		expect(ClassificationSchema.safeParse({ mode: "motif", garment_part: "" }).success).toBe(false);
	});

	it("rejects a whitespace-only garment part, because trimming happens before the length check", () => {
		// This is the case the `.trim().min(1)` ordering exists for: without the
		// trim running first, "   " is three characters and passes.
		expect(ClassificationSchema.safeParse({ mode: "motif", garment_part: "   " }).success).toBe(false);
	});

	it("trims a garment part rather than storing the padding", () => {
		expect(ClassificationSchema.parse({ mode: "motif", garment_part: "  yoke  " })).toEqual({
			mode: "motif",
			garment_part: "yoke",
		});
	});

	it("accepts a garment part of exactly 64 characters and rejects 65", () => {
		const part = "a".repeat(64);

		expect(ClassificationSchema.parse({ mode: "motif", garment_part: part }).garment_part).toBe(part);
		expect(ClassificationSchema.safeParse({ mode: "motif", garment_part: `${part}a` }).success).toBe(false);
	});

	it("rejects a non-string garment part", () => {
		expect(ClassificationSchema.safeParse({ mode: "motif", garment_part: 3 }).success).toBe(false);
		expect(ClassificationSchema.safeParse({ mode: "motif", garment_part: null }).success).toBe(false);
	});

	it("drops an unknown key instead of carrying it into the column", () => {
		// Recorded because it is a choice, not an accident: the classifier writes
		// straight into a JSON column, and a model that volunteers an extra field
		// must not be able to put it there. Parsing is what strips it, so callers
		// must store `parsed`, never the raw reply.
		expect(ClassificationSchema.parse({ mode: "tile", confidence: 0.9 })).toEqual({ mode: "tile" });
	});
});

describe("SearchQualitySchema", () => {
	it("accepts the three retrieval outcomes", () => {
		expect(SearchQualitySchema.parse("none")).toBe("none");
		expect(SearchQualitySchema.parse("thin")).toBe("thin");
		expect(SearchQualitySchema.parse("ok")).toBe("ok");
	});

	it("rejects anything else, including the error case", () => {
		// A retrieval error stops the run; it is deliberately not a quality value,
		// so "failed" must not be storable as one.
		expect(SearchQualitySchema.safeParse("failed").success).toBe(false);
		expect(SearchQualitySchema.safeParse("good").success).toBe(false);
		expect(SearchQualitySchema.safeParse("").success).toBe(false);
	});
});
