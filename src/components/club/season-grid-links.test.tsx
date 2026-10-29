// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeasonGridData } from "#/server/season-grid";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/slots", () => ({ claimSlot: vi.fn(), releaseSlot: vi.fn() }));
vi.mock("#/server/availability", () => ({
	clearAvailability: vi.fn(),
	markUnavailableReleasing: vi.fn(),
	setAvailability: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), message: vi.fn(), error: vi.fn() },
}));

import { SeasonGrid } from "./season-grid";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const UUID = "11111111-2222-3333-4444-555555555555";

function gridData(clubSlug: string | null, members = false): SeasonGridData {
	return {
		clubSlug,
		meetings: [
			{
				id: UUID,
				scheduledAt: "2026-07-01T19:00:00Z",
				timezone: "UTC",
				urlKey: "2026-07-01",
				openCount: 1,
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
		members: members ? [{ id: "c1", name: "Carla Nguyen" }] : [],
		memberNames: members ? [{ id: "c1", name: "Carla Nguyen" }] : [],
		guestNames: [],
		cells: [
			{
				slotId: "slot-1",
				meetingId: UUID,
				roleDefinitionId: "ti",
				slotIndex: 0,
				memberId: null,
				guestId: null,
				status: "open",
			},
		],
		unavailable: [],
		contacted: [],
	} as SeasonGridData;
}

const hrefs = () =>
	screen
		.queryAllByRole("link")
		.map((a) => a.getAttribute("href") ?? "")
		.filter((h) => /meeting/.test(h));

describe("SeasonGrid meeting links (#1401)", () => {
	for (const orientation of ["roles", "members"] as const) {
		it(`signed in (no public-shell flag), ${orientation}: every meeting link is slug + date key`, async () => {
			await renderUnderMemoryRouter(
				<SeasonGrid
					data={gridData("downtown", true)}
					orientation={orientation}
					count="all"
					currentMemberId="me"
					currentMemberSource="session"
				/>,
			);
			const found = hrefs();
			expect(found.length).toBeGreaterThan(0);
			for (const h of found)
				expect(h).toBe("/club/downtown/meeting/2026-07-01");
		});
	}

	it("falls back to /meetings/$id only when the grid has no slug", async () => {
		await renderUnderMemoryRouter(
			<SeasonGrid data={gridData(null)} orientation="roles" count="all" />,
		);
		const found = hrefs();
		expect(found.length).toBeGreaterThan(0);
		for (const h of found) expect(h).toBe(`/meetings/${UUID}`);
	});

	it("the empty-state Roster view is a /roster link signed in, plain text in the public shell", async () => {
		const empty = gridData("downtown");
		await renderUnderMemoryRouter(
			<SeasonGrid data={empty} orientation="members" count="all" />,
		);
		expect(
			screen.getByRole("link", { name: "Roster view" }).getAttribute("href"),
		).toBe("/roster");
		cleanup();
		await renderUnderMemoryRouter(
			<SeasonGrid data={empty} orientation="members" count="all" publicShell />,
		);
		expect(screen.queryByRole("link", { name: "Roster view" })).toBeNull();
		expect(screen.getByText(/Roster view/)).toBeTruthy();
	});
});
