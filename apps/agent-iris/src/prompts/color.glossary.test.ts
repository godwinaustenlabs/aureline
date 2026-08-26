import { describe, it, expect } from "vitest";
import { ColorNameSchema, IrisParamsSchema } from "@aureline/shared-types";
import {
  COLOR_GLOSSARY,
  HARMONY_GLOSSARY,
  SATURATION_GLOSSARY,
  BACKGROUND_GLOSSARY,
} from "./color.glossary";

/**
 * These tests exist to catch a value added to a schema enum but not to the
 * glossary that explains it.
 *
 * `COLOR_GLOSSARY` is typed `Record<ColorName, …>`, so today that mismatch is
 * already a compile error. This asserts it at runtime anyway, deliberately:
 * the typing is one `Partial<>` away from silently allowing a gap, and the
 * failure it would let through is invisible — the planner prompt would simply
 * stop describing one colour and the model would start guessing at it.
 */
describe("COLOR_GLOSSARY", () => {
  it("has an entry for every name in ColorNameSchema", () => {
    const missing = ColorNameSchema.options.filter(
      (name) => !(name in COLOR_GLOSSARY)
    );

    expect(missing).toEqual([]);
    expect(Object.keys(COLOR_GLOSSARY)).toHaveLength(
      ColorNameSchema.options.length
    );
  });

  it("has no entry that is not in ColorNameSchema", () => {
    const names: readonly string[] = ColorNameSchema.options;
    const extra = Object.keys(COLOR_GLOSSARY).filter(
      (key) => !names.includes(key)
    );

    // The other direction of the check above. A stale name here would be dead
    // weight in the planner prompt, offering the model a value the schema
    // would then reject.
    expect(extra).toEqual([]);
  });

  it("gives every colour a well-formed six-digit hex", () => {
    for (const name of ColorNameSchema.options) {
      expect(COLOR_GLOSSARY[name].hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("gives every colour a non-empty gloss", () => {
    for (const name of ColorNameSchema.options) {
      expect(COLOR_GLOSSARY[name].gloss.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives no two colours the same hex", () => {
    // Two names resolving to the same value is a vocabulary bug: the planner
    // can pick either and the rendered result is identical, so the distinction
    // it thought it was making does not exist.
    const byHex = new Map<string, string[]>();

    for (const name of ColorNameSchema.options) {
      const hex = COLOR_GLOSSARY[name].hex.toLowerCase();
      byHex.set(hex, [...(byHex.get(hex) ?? []), name]);
    }

    const collisions = [...byHex.entries()].filter(
      ([, names]) => names.length > 1
    );

    expect(collisions).toEqual([]);
  });
});

/**
 * The same check for the three enum fields the planner also has to explain.
 * Each glossary is read straight into the system prompt, so a gap here is a
 * value the model is asked to choose without being told what it means.
 */
describe("the enum glossaries", () => {
  /**
   * Generic so each glossary is checked against its own field's values rather
   * than against the union of all three. Written this way instead of a loop
   * over a mixed tuple, which widens the glossary type and needs a cast to
   * index — the cast being exactly what would stop this checking anything.
   */
  function expectCovers<T extends string>(
    allowed: readonly T[],
    glossary: Record<T, string>
  ): void {
    expect(Object.keys(glossary).sort()).toEqual([...allowed].sort());

    for (const value of allowed) {
      expect(glossary[value].trim().length).toBeGreaterThan(0);
    }
  }

  it("harmony: covers every value in IrisParamsSchema, and no others", () => {
    expectCovers(IrisParamsSchema.shape.harmony.options, HARMONY_GLOSSARY);
  });

  it("saturation: covers every value in IrisParamsSchema, and no others", () => {
    expectCovers(IrisParamsSchema.shape.saturation.options, SATURATION_GLOSSARY);
  });

  it("background_treatment: covers every value in IrisParamsSchema, and no others", () => {
    expectCovers(
      IrisParamsSchema.shape.background_treatment.options,
      BACKGROUND_GLOSSARY
    );
  });
});
