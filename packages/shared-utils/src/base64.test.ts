import { describe, expect, it } from "vitest";
import { bytesToBase64, toDataUrl } from "./base64";

describe("bytesToBase64", () => {
  it("encodes bytes to the base64 `atob` reverses", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    const encoded = bytesToBase64(bytes);

    // Asserting on the round trip rather than a literal: the literal would pass
    // just as well against a function that returned a constant.
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("encodes an input far larger than one chunk without overflowing the stack", () => {
    // 300 KB, well past the 8192-byte chunk and past the argument limit that a
    // naive `String.fromCharCode(...bytes)` would hit. This is the whole reason
    // the chunking exists, so it is the case worth asserting — a small fixture
    // would pass against the broken one-liner.
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));

    expect(decoded.length).toBe(bytes.length);
    expect(Array.from(decoded.subarray(0, 16))).toEqual(Array.from(bytes.subarray(0, 16)));
    // The chunk boundary itself, where an off-by-one would land.
    expect(Array.from(decoded.subarray(8188, 8196))).toEqual(
      Array.from(bytes.subarray(8188, 8196)),
    );
    expect(decoded[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });

  it("encodes empty bytes to an empty string", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});

describe("toDataUrl", () => {
  it("carries the caller's content type verbatim", () => {
    const url = toDataUrl(new Uint8Array([1, 2, 3]), "image/png");

    expect(url).toBe(`data:image/png;base64,${bytesToBase64(new Uint8Array([1, 2, 3]))}`);
  });
});
