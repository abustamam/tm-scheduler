// One poller tick runs four passes: produce role reminders, send them, deliver
// the request-access form's email (#866), and sweep retention. Each has its own
// try, so one throwing cannot skip the rest — least of all the sweep, which is
// the only thing that deletes a pending plan or an old access request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./role-reminders-logic", () => ({ produceRoleReminders: vi.fn() }));
vi.mock("./notifications-logic", () => ({ processDueNotifications: vi.fn() }));
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
import { processDueNotifications } from "./notifications-logic";
import { runReminderTick } from "./reminder-poller";
import { produceRoleReminders } from "./role-reminders-logic";

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(produceRoleReminders).mockResolvedValue({
		enqueued: 0,
	} as never);
	vi.mocked(processDueNotifications).mockResolvedValue({ due: 0 } as never);
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

describe("runReminderTick isolation (#866)", () => {
	it("still delivers access-request mail and sweeps when the reminder send pass throws", async () => {
		vi.mocked(processDueNotifications).mockRejectedValue(new Error("boom"));
		await runReminderTick();
		expect(deliverAccessRequestMail).toHaveBeenCalledTimes(1);
		expect(sweepExpiredPendingPlans).toHaveBeenCalledTimes(1);
		expect(sweepExpiredAccessRequests).toHaveBeenCalledTimes(1);
	});

	it("still sweeps when access-request delivery throws", async () => {
		vi.mocked(deliverAccessRequestMail).mockRejectedValue(new Error("boom"));
		await runReminderTick();
		expect(sweepExpiredPendingPlans).toHaveBeenCalledTimes(1);
		expect(sweepExpiredAccessRequests).toHaveBeenCalledTimes(1);
	});

	it("still sends reminders when the producer throws", async () => {
		vi.mocked(produceRoleReminders).mockRejectedValue(new Error("boom"));
		await runReminderTick();
		expect(processDueNotifications).toHaveBeenCalledTimes(1);
		expect(deliverAccessRequestMail).toHaveBeenCalledTimes(1);
	});
});
