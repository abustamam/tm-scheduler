// @vitest-environment jsdom

// The grid's own Release and the cover sheet (#1439): a release inside 48h
// opens the sheet and releases nothing; a release further out is today's
// immediate one; a late drop the grid cannot build the sheet for refuses
// instead of releasing.

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
	claimSlot,
	releaseSlot,
	toastSuccess,
	toastError,
	loadCoverCandidates,
} = vi.hoisted(() => ({
	claimSlot: vi.fn(async () => ({ ok: true, proof: "session" })),
	releaseSlot: vi.fn(async () => ({ ok: true })),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	loadCoverCandidates: vi.fn(async () => [] as unknown[]),
}));
vi.mock("#/server/slots", () => ({ claimSlot, releaseSlot }));
vi.mock("#/server/availability", () => ({
	clearAvailability: vi.fn(),
	markUnavailableReleasing: vi.fn(),
	setAvailability: vi.fn(),
}));
vi.mock("#/server/cover", () => ({
	askForCover: vi.fn(),
	loadCoverCandidates,
	releaseOwnSlotForCover: vi.fn(),
	undoReleaseForCover: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: toastSuccess,
		message: vi.fn(),
		error: toastError,
	}),
}));

import type { SeasonGridData } from "#/server/season-grid";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { SeasonGrid } from "./season-grid";

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const ME = "m-me";

function gridData(hoursOut: number, over: Partial<SeasonGridData> = {}) {
	return {
		meetings: [
			{
				id: "m1",
				scheduledAt: new Date(Date.now() + hoursOut * 3_600_000).toISOString(),
				timezone: "UTC",
				urlKey: "2026-11-04",
				openCount: 0,
				totalSlots: 1,
				isPast: false,
				isAnchor: true,
				isCompleted: false,
			},
		],
		rows: [
			{
				roleDefinitionId: "ti",
				slotIndex: 0,
				label: "Timer",
				shortCode: "Time",
				sortOrder: 0,
				isSpeakerRole: false,
			},
		],
		members: [],
		memberNames: [{ id: ME, name: "Me Myself" }],
		guestNames: [],
		cells: [
			{
				slotId: "slot-1",
				meetingId: "m1",
				roleDefinitionId: "ti",
				slotIndex: 0,
				memberId: ME,
				guestId: null,
				status: "claimed",
			},
		],
		unavailable: [],
		contacted: [],
		clubSlug: "demo",
		...over,
	} as unknown as SeasonGridData;
}

async function mountAndRelease(d: SeasonGridData) {
	await renderUnderMemoryRouter(
		<SeasonGrid
			data={d}
			orientation="roles"
			count="all"
			currentMemberId={ME}
			currentMemberSource="session"
		/>,
	);
	await userEvent.click(
		await screen.findByRole("button", { name: /^Release / }),
	);
}

describe("SeasonGrid own Release and the cover sheet (#1439)", () => {
	it("an own release more than 48h out releases at once, no sheet", async () => {
		// protects=AC2: a release further out behaves exactly as today
		// fails_when=the 48h gate stops being a gate and every own drop opens the sheet
		await mountAndRelease(gridData(100));
		await waitFor(() =>
			expect(releaseSlot).toHaveBeenCalledWith({ data: { slotId: "slot-1" } }),
		);
		expect(screen.queryByText(/Who can cover/)).toBeNull();
	});

	it("an own release inside 48h opens the sheet and releases nothing", async () => {
		// protects=AC1 on the grid
		// fails_when=the late release goes straight to releaseSlot
		await mountAndRelease(gridData(20));
		expect(
			await screen.findByRole("heading", { name: "Who can cover Timer?" }),
		).toBeTruthy();
		expect(releaseSlot).not.toHaveBeenCalled();
	});

	it("a late drop the grid cannot build the sheet for refuses, and releases nothing", async () => {
		// protects=finding 2: no slug means no link, and the drop must not fall
		//   through to an immediate release
		// fails_when=coverTargetFor returning null lets release() write
		await mountAndRelease(gridData(20, { clubSlug: null }));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(releaseSlot).not.toHaveBeenCalled();
		expect(screen.queryByText(/Who can cover/)).toBeNull();
	});
});
