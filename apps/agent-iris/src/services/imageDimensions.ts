/**
 * Reading an image's real pixel dimensions out of its bytes.
 *
 * This exists because iris-09 decision 9 requires the *colored* image's real
 * dimensions, and nothing else in the repo can produce them. The model returns
 * `{ image: "<base64>" }` and nothing else, so there is no reported size to
 * trust; the input's size is not the output's (iris-06 sent 640x640 and got
 * 1024x1024 back); and a hardcoded pair is exactly the lying audit row ADR-0001
 * exists to prevent.
 *
 * Cloudflare's `env.IMAGES.info()` would do this natively and is already typed
 * in `worker-configuration.d.ts`, but there is no `images` binding on this
 * Worker and adding one is an account-level change a human makes. When that
 * binding lands, this file is the thing to delete.
 *
 * Scope is deliberately one format. Every image in this pipeline is a JPEG:
 * Helios writes `.jpg`, `saveColoredImage` writes `.jpg`, and the model returns
 * JPEG. A PNG branch here would be untested code guarding a case that cannot
 * occur, so a non-JPEG throws instead.
 */

/** SOI, the two bytes every JPEG starts with. */
const SOI = [0xff, 0xd8];

/**
 * Markers that carry no length field and no payload, so the scan steps straight
 * past them: TEM (0x01), the eight restart markers (0xD0-0xD7), SOI (0xD8) and
 * EOI (0xD9).
 */
function isStandaloneMarker(marker: number): boolean {
	return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/**
 * Start-of-frame markers, which are the ones carrying the dimensions.
 *
 * Three ranges rather than one, because 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC)
 * sit inside 0xC0-0xCF and are *not* frame headers. Treating the range as
 * contiguous is the classic bug here: it reads a Huffman table as a frame and
 * returns two plausible-looking numbers that are not the image's size.
 */
function isStartOfFrame(marker: number): boolean {
	return (
		(marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)
	);
}

/**
 * The pixel dimensions of a JPEG.
 *
 * Throws, naming what was wrong, rather than returning a guess or a zero. A
 * caller records these on an audit row, so wrong numbers are worse than no
 * numbers: a failed run says something went wrong, while a row reading 0x0 or
 * 512x512 says the image is that size and is believed.
 */
export function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
	if (bytes.length < 4 || bytes[0] !== SOI[0] || bytes[1] !== SOI[1]) {
		throw new Error(`readJpegDimensions: not a JPEG (expected FFD8, got ${describeFirstBytes(bytes)})`);
	}

	// Starts after SOI. Every iteration is positioned at what must be a marker.
	let offset = 2;

	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) {
			throw new Error(`readJpegDimensions: expected a marker at byte ${offset}, found 0x${hex(bytes[offset])}`);
		}

		// A run of 0xFF bytes is legal padding before the marker itself.
		while (offset < bytes.length && bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) break;

		const marker = bytes[offset];
		offset++;

		if (isStandaloneMarker(marker)) continue;

		// Every other marker is followed by a two-byte big-endian length that
		// counts itself, so a length under 2 is malformed rather than merely odd.
		if (offset + 1 >= bytes.length) {
			throw new Error(`readJpegDimensions: truncated before the length of marker 0x${hex(marker)}`);
		}
		const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
		if (segmentLength < 2) {
			throw new Error(`readJpegDimensions: marker 0x${hex(marker)} declares an impossible length ${segmentLength}`);
		}

		if (isStartOfFrame(marker)) {
			// Payload layout: length(2) precision(1) height(2) width(2) components(1).
			// Height precedes width, which is the other classic bug in this parser
			// and is silent on a square image -- which the test fixture is, so the
			// non-square assertions in the test file are the ones that catch it.
			if (offset + 6 >= bytes.length) {
				throw new Error(`readJpegDimensions: truncated inside the frame header at byte ${offset}`);
			}

			const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
			const width = (bytes[offset + 5] << 8) | bytes[offset + 6];

			if (width <= 0 || height <= 0) {
				throw new Error(`readJpegDimensions: frame header declares ${width}x${height}`);
			}

			return { width, height };
		}

		offset += segmentLength;
	}

	throw new Error("readJpegDimensions: no start-of-frame marker found before the end of the data");
}

/** Renders the leading bytes for an error message, so a wrong format is legible. */
function describeFirstBytes(bytes: Uint8Array): string {
	if (bytes.length === 0) return "no bytes at all";
	return [...bytes.slice(0, 4)].map((byte) => hex(byte)).join(" ");
}

function hex(byte: number | undefined): string {
	return (byte ?? 0).toString(16).padStart(2, "0").toUpperCase();
}
