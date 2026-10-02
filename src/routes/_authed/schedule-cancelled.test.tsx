// @vitest-environment jsdom
/**
 * The schedule's cancelled-meetings strip (#1057): officers see each cancelled
 * meeting struck through and linked by UUID; members get neither the data nor
 * the strip. Two halves, both here: the LOADER asks for the list only for an
 * effective admin, and the PAGE renders it only for one.
 */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficerPosition } from "#/lib/officers";
import type { CancelledMeetingRow } from "#/server/meetings";
import type { SeasonGridData } from "#/server/season-grid";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { getSeasonGrid, listCancelledMeetings } = vi.hoisted(() => ({
	getSeasonGrid: vi.fn(async (_: unknown) => ({}) as SeasonGridData),
	listCancelledMeetings: vi.fn(async (_: unknown) => [] as unknown[]),
}));
vi.mock("#/server/season-grid", () => ({ getSeasonGrid }));
vi.mock("#/server/meetings", () => ({ listCancelledMeetings }));
vi.mock("#/server/slots", () => ({ claimSlot: vi.fn(), releaseSlot: vi.fn() }));
vi.mock("#/server/availability", () => ({
	clearAvailability: vi.fn(),
	markUnavailableReleasing: vi.fn(),
	setAvailability: vi.fn(),
}));

import { Route } from "./schedule";

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const MEETING_UUID = "11111111-2222-4333-8444-555555555555";
const CANCELLED: CancelledMeetingRow[] = [
	{ id: MEETING_UUID, scheduledAt: "2026-10-03T15:00:00Z", timezone: "UTC" },
];

interface Ctx {
	clubs: {
		clubId: string;
		name: string;
		clubNumber: string | null;
		clubRole: "admin" | "member";
	}[];
	activeClubId: string | null;
	officerPositions: OfficerPosition[];
	currentMemberId: string | null;
	impersonating: null;
}

const club = (clubRole: "admin" | "member") => ({
	clubId: "club-1",
	name: "Downtown Speakers",
	clubNumber: null,
	clubRole,
});
const ADMIN: Ctx = {
	clubs: [club("admin")],
	activeClubId: "club-1",
	officerPositions: [],
	currentMemberId: "a",
	impersonating: null,
};
const OFFICER: Ctx = {
	...ADMIN,
	clubs: [club("member")],
	officerPositions: ["vp_education" as OfficerPosition],
};
const MEMBER: Ctx = { ...ADMIN, clubs: [club("member")] };

const gridData: SeasonGridData = {
	clubSlug: "downtown",
	meetings: [],
	rows: [],
	members: [{ id: "a", name: "Amir" }],
	memberNames: [{ id: "a", name: "Amir" }],
	guestNames: [],
	cells: [],
	unavailable: [],
	contacted: [],
};

describe("the loader", () => {
	const loader = Route.options.loader as unknown as (o: {
		context: Ctx;
		deps: { count: unknown; past: number };
	}) => Promise<{ data: unknown; cancelled: unknown[] }>;
	const deps = { count: 8, past: 2 };

	it("asks for cancelled meetings for a stored admin", async () => {
		listCancelledMeetings.mockResolvedValueOnce(CANCELLED);
		const result = await loader({ context: ADMIN, deps });
		expect(listCancelledMeetings).toHaveBeenCalledWith({
			data: { clubId: "club-1" },
		});
		expect(result.cancelled).toEqual(CANCELLED);
	});

	it("asks for them for an officer who is not a stored admin", async () => {
		await loader({ context: OFFICER, deps });
		expect(listCancelledMeetings).toHaveBeenCalledTimes(1);
	});

	it("never asks for a plain member, and hands the page an empty list", async () => {
		const result = await loader({ context: MEMBER, deps });
		expect(listCancelledMeetings).not.toHaveBeenCalled();
		expect(result.cancelled).toEqual([]);
	});

	it("a refused call degrades to no strip, not a failed page", async () => {
		// The officer whose term closed between loads: the server refuses, the
		// grid still renders.
		listCancelledMeetings.mockRejectedValueOnce(new Error("no permission"));
		const result = await loader({ context: ADMIN, deps });
		expect(result.cancelled).toEqual([]);
		expect(getSeasonGrid).toHaveBeenCalledTimes(1);
	});

	it("with no active club asks for nothing", async () => {
		const result = await loader({
			context: { ...ADMIN, activeClubId: null },
			deps,
		});
		expect(listCancelledMeetings).not.toHaveBeenCalled();
		expect(getSeasonGrid).not.toHaveBeenCalled();
		expect(result.cancelled).toEqual([]);
	});
});

async function renderPage(ctx: Ctx, cancelled: CancelledMeetingRow[]) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		data: gridData,
		cancelled,
	} as never);
	vi.spyOn(Route, "useSearch").mockReturnValue({
		view: "members",
		count: 8,
	} as never);
	vi.spyOn(Route, "useRouteContext").mockReturnValue(ctx as never);
	vi.spyOn(Route, "useNavigate").mockReturnValue(vi.fn() as never);
	const Page = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Page />);
}

describe("the strip", () => {
	it("shows an officer each cancelled meeting struck through, linked by UUID to the club slug", async () => {
		await renderPage(ADMIN, CANCELLED);
		const strip = screen.getByTestId("cancelled-meetings");
		expect(strip.textContent).toContain("Cancelled");
		const link = strip.querySelector("a");
		expect(link?.getAttribute("href")).toBe(
			`/club/downtown/meeting/${MEETING_UUID}`,
		);
		// The uuid, never a date key: a bare-date URL skips a cancelled meeting.
		expect(link?.getAttribute("href")).not.toContain("2026-10-03");
		expect(link?.className).toContain("line-through");
		// Review of #1084, G: the strike in the text's own colour, kept on hover
		// (`hover:underline` sets the same `text-decoration-line` and would
		// un-strike it), and a 24px target.
		const classes = link?.className.split(/\s+/) ?? [];
		expect(classes).toContain("decoration-current");
		expect(classes).not.toContain("hover:underline");
		expect(classes).toEqual(
			expect.arrayContaining(["inline-flex", "min-h-6", "items-center"]),
		);
		expect(link?.textContent).toContain("Oct 3");
	});

	it("shows it to an officer who is not a stored admin", async () => {
		await renderPage(OFFICER, CANCELLED);
		expect(screen.getByTestId("cancelled-meetings")).toBeTruthy();
	});

	it("renders nothing when there is nothing cancelled", async () => {
		await renderPage(ADMIN, []);
		expect(screen.queryByTestId("cancelled-meetings")).toBeNull();
	});

	it("renders nothing for a member even if a list somehow arrived", async () => {
		// The loader never hands a member a list; this is the page's own half of
		// the same rule, so a loader mistake still shows a member nothing.
		await renderPage(MEMBER, CANCELLED);
		expect(screen.queryByTestId("cancelled-meetings")).toBeNull();
	});
});
