/**
 * Transport test for `getMyMilestones` (#1425): the handler runs through a
 * minimal Start adapter with the guards and the counts mocked, so the two
 * branches the integration suite cannot reach are executed, not grepped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

const requireUser = vi.fn();
const requireClubViewAccess = vi.fn();
vi.mock("./guards", () => ({
	requireUser: (...a: unknown[]) => requireUser(...a),
	requireClubViewAccess: (...a: unknown[]) => requireClubViewAccess(...a),
}));
const loadMilestoneCounts = vi.fn();
vi.mock("./milestones-logic", () => ({
	loadMilestoneCounts: (...a: unknown[]) => loadMilestoneCounts(...a),
}));

const { getMyMilestones } = await import("./milestones");

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.clearAllMocks();
	requireUser.mockResolvedValue({ id: "u1" });
});

describe("getMyMilestones transport", () => {
	// protects=a viewer with no membership (e.g. a superadmin viewing a club) gets null and no counts query runs; fails_when=the null branch is dropped and counts are read for an undefined member; no_claim=the counts themselves
	it("returns null and reads no counts when the viewer has no membership", async () => {
		requireClubViewAccess.mockResolvedValue({ membership: null });
		const out = await (
			getMyMilestones as unknown as (i: { data: unknown }) => Promise<unknown>
		)({ data: { clubId: CLUB_ID } });
		expect(out).toBeNull();
		expect(loadMilestoneCounts).not.toHaveBeenCalled();
	});

	// protects=the counts are read for the SESSION's membership, never an input id; fails_when=another member id is used or memberId is not returned; no_claim=authorization of the club
	it("reads counts for the resolved membership and returns its id", async () => {
		requireClubViewAccess.mockResolvedValue({ membership: { id: "mem-1" } });
		loadMilestoneCounts.mockResolvedValue({
			speechesDelivered: 2,
			meetingsAttended: 3,
		});
		const out = await (
			getMyMilestones as unknown as (i: { data: unknown }) => Promise<unknown>
		)({ data: { clubId: CLUB_ID } });
		expect(loadMilestoneCounts).toHaveBeenCalledWith("mem-1");
		expect(out).toEqual({
			memberId: "mem-1",
			speechesDelivered: 2,
			meetingsAttended: 3,
		});
	});
});
