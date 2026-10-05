// One poller tick runs two passes: deliver the request-access form's email
// (#866), then sweep retention. Delivery has its own try, so it throwing cannot
// skip the sweep, which is the only thing that deletes a pending plan or an old
// access request. There is no role-reminder pass (ADR-0028, #902).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mcp-pending-logic", () => ({ sweepExpiredPendingPlans: vi.fn() }));
vi.mock("./access-requests-logic", () => ({
	deliverAccessRequestMail: vi.fn(),
	sweepExpiredAccessRequests: vi.fn(),
}));
vi.mock("#/lib/pending-plan", () => ({ describePendingSweep: () => null }));

import {
	deliverAccessRequestMail,
	sweepExpiredAccessRequests,
} from "./access-requests-logic";
import { sweepExpiredPendingPlans } from "./mcp-pending-logic";
import { runPollerTick } from "./reminder-poller";

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(deliverAccessRequestMail).mockResolvedValue({
		sent: 0,
		failed: 0,
		alertsSent: 0,
		alertsFailed: 0,
	});
	vi.mocked(sweepExpiredPendingPlans).mockResolvedValue({} as never);
	vi.mocked(sweepExpiredAccessRequests).mockResolvedValue({
		requests: 0,
		alerts: 0,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("runPollerTick isolation (#866)", () => {
	it("delivers access-request mail and runs both sweeps once per tick", async () => {
		await runPollerTick();
		expect(deliverAccessRequestMail).toHaveBeenCalledTimes(1);
		expect(sweepExpiredPendingPlans).toHaveBeenCalledTimes(1);
		expect(sweepExpiredAccessRequests).toHaveBeenCalledTimes(1);
	});

	it("still sweeps when access-request delivery throws", async () => {
		vi.mocked(deliverAccessRequestMail).mockRejectedValue(new Error("boom"));
		await runPollerTick();
		expect(sweepExpiredPendingPlans).toHaveBeenCalledTimes(1);
		expect(sweepExpiredAccessRequests).toHaveBeenCalledTimes(1);
	});

	it("still runs the access-request sweep when the pending-plan sweep throws", async () => {
		vi.mocked(sweepExpiredPendingPlans).mockRejectedValue(new Error("boom"));
		await runPollerTick();
		expect(sweepExpiredAccessRequests).toHaveBeenCalledTimes(1);
	});
});
