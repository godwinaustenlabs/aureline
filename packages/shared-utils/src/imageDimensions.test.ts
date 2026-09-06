import { describe, expect, it } from "vitest";
import { readJpegDimensions } from "./imageDimensions";

/**
 * A minimal but structurally real JPEG header: SOI, then any number of
 * intervening segments, then an SOF0 declaring the given size.
 *
 * Built rather than fixtured because the one real fixture available is square,
 * and a square image cannot distinguish a correct parser from one that reads
 * width and height the wrong way round.
 */
function jpegHeader(width: number, height: number, before: number[] = []): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8, // SOI
		...before,
		0xff,
		0xc0, // SOF0
		0x00,
		0x11, // length: 17
		0x08, // precision
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03, // components
	]);
}

/** A DHT segment, which sits inside 0xC0-0xCF but is not a frame header. */
const DHT_SEGMENT = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];

/**
 * Every case here builds its own header, so this file needs no fixture.
 *
 * The one test that reads a *real* encoder's output — the 128x128
 * `sample-colored.jpg` — stays in `agent-iris`, beside the fixture it needs.
 * Copying a 9KB base64 blob into this package to keep the two together would
 * mean two copies that can drift, and exporting test data from a shared
 * package's public API to avoid that is worse than the split.
 */
describe("readJpegDimensions", () => {
	it("does not confuse width with height on a landscape image", () => {
		// The fixture is square, so this pair is what actually pins the byte order.
		// Swapping the two reads passes every square test and silently reports
		// every real output transposed.
		expect(readJpegDimensions(jpegHeader(1024, 512))).toEqual({ width: 1024, height: 512 });
	});

	it("does not confuse width with height on a portrait image", () => {
		expect(readJpegDimensions(jpegHeader(512, 1024))).toEqual({ width: 512, height: 1024 });
	});

	it("skips a Huffman table rather than reading it as a frame header", () => {
		// 0xC4 sits inside 0xC0-0xCF. A parser that treats that range as one
		// contiguous block of frame markers returns two plausible numbers from a
		// Huffman table and never reaches the real frame.
		expect(readJpegDimensions(jpegHeader(800, 600, DHT_SEGMENT))).toEqual({ width: 800, height: 600 });
	});

	it("throws for bytes that are not a JPEG", () => {
		// A PNG signature. The model is contracted to return JPEG; anything else is
		// a change worth failing on rather than guessing through.
		expect(() => readJpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/not a JPEG/);
	});

	it("throws for an empty buffer", () => {
		expect(() => readJpegDimensions(new Uint8Array())).toThrow(/not a JPEG/);
	});

	it("throws when the frame header is truncated", () => {
		// Cut mid-frame-header: the SOI and the SOF marker are both present and
		// correct, so a parser that only checks the magic bytes reads past the end
		// and returns whatever `undefined | 0` produces.
		const truncated = jpegHeader(1024, 1024).slice(0, 8);

		expect(() => readJpegDimensions(truncated)).toThrow(/truncated/);
	});

	it("throws when there is no frame header at all", () => {
		expect(() => readJpegDimensions(new Uint8Array([0xff, 0xd8, ...DHT_SEGMENT]))).toThrow(/no start-of-frame/);
	});

	it("throws rather than returning a zero dimension", () => {
		// A row reading 0x0 says the image is that size and is believed. A failed
		// run says something went wrong. The second is the useful one.
		expect(() => readJpegDimensions(jpegHeader(0, 0))).toThrow(/0x0/);
	});
});
