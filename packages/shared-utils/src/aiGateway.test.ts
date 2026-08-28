import { describe, it, expect } from "vitest";
import { buildAiRunOptions, DEFAULT_IMAGE_CACHE_TTL } from "./aiGateway";

describe("buildAiRunOptions", () => {
  it("returns undefined when no gateway config is given", () => {
    expect(buildAiRunOptions(undefined)).toBeUndefined();
  });

  it("returns undefined when the gateway id is empty", () => {
    expect(buildAiRunOptions({ id: "" })).toBeUndefined();
    expect(buildAiRunOptions({ id: undefined })).toBeUndefined();
  });

  it("returns undefined when the id is empty even if other options are set", () => {
    expect(buildAiRunOptions({ id: "", cacheTtl: 60 })).toBeUndefined();
  });

  it("returns just the id when nothing else is configured", () => {
    expect(buildAiRunOptions({ id: "helios" })).toEqual({
      gateway: { id: "helios" },
    });
  });

  it("does not emit keys for options that were not set", () => {
    const result = buildAiRunOptions({ id: "helios" });
    expect(Object.keys(result!.gateway!)).toEqual(["id"]);
  });

  it("applies defaults when the caller sets nothing", () => {
    expect(
      buildAiRunOptions({ id: "helios" }, { cacheTtl: DEFAULT_IMAGE_CACHE_TTL })
    ).toEqual({ gateway: { id: "helios", cacheTtl: DEFAULT_IMAGE_CACHE_TTL } });
  });

  it("lets caller values win over defaults", () => {
    expect(
      buildAiRunOptions({ id: "helios", cacheTtl: 60 }, { cacheTtl: 3600 })
    ).toEqual({ gateway: { id: "helios", cacheTtl: 60 } });
  });

  it("forwards skipCache, cacheKey and metadata", () => {
    expect(
      buildAiRunOptions({
        id: "helios",
        skipCache: true,
        cacheKey: "k",
        metadata: { pipeline_id: "abc" },
      })
    ).toEqual({
      gateway: {
        id: "helios",
        skipCache: true,
        cacheKey: "k",
        metadata: { pipeline_id: "abc" },
      },
    });
  });

  it("keeps skipCache: false rather than dropping it as falsy", () => {
    expect(buildAiRunOptions({ id: "helios", skipCache: false })).toEqual({
      gateway: { id: "helios", skipCache: false },
    });
  });

  it("does not mutate the defaults object it is given", () => {
    const defaults = { cacheTtl: 3600 };
    buildAiRunOptions({ id: "helios", cacheTtl: 60, skipCache: true }, defaults);
    expect(defaults).toEqual({ cacheTtl: 3600 });
  });
});
