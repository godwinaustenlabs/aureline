import { describe, expect, it, vi } from "vitest";
import { readGatewayCost } from "./gatewayCost";
import { fakeEnv } from "./test-env";

/**
 * Ported from `apps/agent-helios/src/services/gatewayCost.test.ts`, alongside
 * the function itself, which Iris copies verbatim. The cases are Helios's
 * because the bug they were written for is Helios's, and iris-09 becomes the
 * second caller of the same retry loop.
 *
 * The backoff is real, not mocked, so this file adds roughly three seconds to
 * the suite. That is the timing path the function exists for, and a fake timer
 * mis-sequenced against a bare `await new Promise(setTimeout)` hangs rather
 * than fails, which is a worse trade than three seconds.
 */
function envWith(getLog: ReturnType<typeof vi.fn>, aiGatewayLogId: string | null = "log-1") {
	return fakeEnv({ getLog, aiGatewayLogId }).env;
}

describe("readGatewayCost", () => {
	it("returns the cost the gateway log carries, on the first read", async () => {
		const getLog = vi.fn().mockResolvedValue({ cost: 0.0019008 });

		expect(await readGatewayCost(envWith(getLog), "image")).toBe(0.0019008);
		expect(getLog).toHaveBeenCalledTimes(1);
	});

	/**
	 * The bug this function was rewritten for. A production run billed for an
	 * image, the gateway log showed the cost in the dashboard, and the image row
	 * still landed with `cost_usd` null: the field is populated after the
	 * response comes back, and a single read always ran too early.
	 */
	it("reads again when the log exists but has no cost on it yet", async () => {
		const getLog = vi.fn().mockResolvedValueOnce({}).mockResolvedValue({ cost: 0.0019008 });

		expect(await readGatewayCost(envWith(getLog), "image")).toBe(0.0019008);
		expect(getLog).toHaveBeenCalledTimes(2);
	});

	it("reads again when the read itself throws", async () => {
		const getLog = vi.fn().mockRejectedValueOnce(new Error("log not found")).mockResolvedValue({ cost: 0.0008 });

		expect(await readGatewayCost(envWith(getLog), "planner")).toBe(0.0008);
		expect(getLog).toHaveBeenCalledTimes(2);
	});

	/**
	 * A cached or otherwise free call is a real answer, not a reason to keep
	 * asking. `?? null` would have kept 0 too, but `!cost` would not, and this
	 * pins the distinction.
	 */
	it("keeps a zero cost rather than retrying past it", async () => {
		const getLog = vi.fn().mockResolvedValue({ cost: 0 });

		expect(await readGatewayCost(envWith(getLog), "image")).toBe(0);
		expect(getLog).toHaveBeenCalledTimes(1);
	});

	it("gives up as null, and never calls the gateway, when there is no log id", async () => {
		const getLog = vi.fn();

		// The path every Iris image call takes today: no gateway id means no log
		// id, so the cost is null and the gateway is never asked.
		expect(await readGatewayCost(envWith(getLog, null), "image")).toBeNull();
		expect(getLog).not.toHaveBeenCalled();
	});

	it("gives up as null after a bounded number of attempts", async () => {
		const getLog = vi.fn().mockResolvedValue({});

		// Bounded, because this runs on a path that has already billed. An
		// unbounded wait for a cost would hold a request open indefinitely over an
		// audit field.
		expect(await readGatewayCost(envWith(getLog), "image")).toBeNull();
		expect(getLog).toHaveBeenCalledTimes(3);
	});

	it("names the stage in what it logs, so a null is attributable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await readGatewayCost(envWith(vi.fn(), null), "planner");
			expect(warn.mock.calls[0]?.[0]).toContain("planner");
		} finally {
			warn.mockRestore();
		}
	});
});
