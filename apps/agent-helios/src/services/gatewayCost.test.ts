import { describe, expect, it, vi } from "vitest";
import { readGatewayCost } from "./gatewayCost";

/** An `env` carrying just the two things `readGatewayCost` touches. */
function fakeEnv(getLog: ReturnType<typeof vi.fn>, aiGatewayLogId: string | null = "log-1") {
	return {
		AI_GATEWAY_ID: "helios",
		AI: { aiGatewayLogId, gateway: vi.fn().mockReturnValue({ getLog }) },
	} as unknown as Env;
}

describe("readGatewayCost", () => {
	it("returns the cost the gateway log carries, on the first read", async () => {
		const getLog = vi.fn().mockResolvedValue({ cost: 0.0019008 });

		expect(await readGatewayCost(fakeEnv(getLog), "image")).toBe(0.0019008);
		expect(getLog).toHaveBeenCalledTimes(1);
	});

	/**
	 * The bug this function was rewritten for. Production run `bdeb3d8b` billed
	 * for an image, the gateway log showed the cost in the dashboard, and the
	 * image row still landed with `cost_usd` null: the field is populated after
	 * the response comes back, and the old single read always ran too early.
	 */
	it("reads again when the log exists but has no cost on it yet", async () => {
		const getLog = vi.fn().mockResolvedValueOnce({}).mockResolvedValue({ cost: 0.0019008 });

		expect(await readGatewayCost(fakeEnv(getLog), "image")).toBe(0.0019008);
		expect(getLog).toHaveBeenCalledTimes(2);
	});

	it("reads again when the read itself throws", async () => {
		const getLog = vi
			.fn()
			.mockRejectedValueOnce(new Error("log not found"))
			.mockResolvedValue({ cost: 0.0008 });

		expect(await readGatewayCost(fakeEnv(getLog), "planner")).toBe(0.0008);
		expect(getLog).toHaveBeenCalledTimes(2);
	});

	/**
	 * A cached or otherwise free call is a real answer, not a reason to keep
	 * asking. `?? null` would have kept 0 too, but `!cost` would not, and this
	 * pins the distinction.
	 */
	it("keeps a zero cost rather than retrying past it", async () => {
		const getLog = vi.fn().mockResolvedValue({ cost: 0 });

		expect(await readGatewayCost(fakeEnv(getLog), "image")).toBe(0);
		expect(getLog).toHaveBeenCalledTimes(1);
	});

	it("gives up as null, and never calls the gateway, when there is no log id", async () => {
		const getLog = vi.fn();

		expect(await readGatewayCost(fakeEnv(getLog, null), "image")).toBeNull();
		expect(getLog).not.toHaveBeenCalled();
	});

	it("gives up as null after a bounded number of attempts", async () => {
		const getLog = vi.fn().mockResolvedValue({});

		expect(await readGatewayCost(fakeEnv(getLog), "image")).toBeNull();
		expect(getLog).toHaveBeenCalledTimes(3);
	});

	it("names the stage in what it logs, so a null is attributable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await readGatewayCost(fakeEnv(vi.fn(), null), "planner");
			expect(warn.mock.calls[0]?.[0]).toContain("planner");
		} finally {
			warn.mockRestore();
		}
	});
});
