// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GlobalSearch,
	type GlobalSearchHandle,
	type SearchableMeeting,
	searchMeetings,
	searchWorkspace,
} from "./global-search";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("#/server/members", () => ({
	listMembers: vi.fn().mockResolvedValue([
		{ id: "m1", name: "Faisal", officerPositions: [] },
		{ id: "m2", name: "Mahbuba", officerPositions: ["vp_education"] },
	]),
}));

// Hoisted: the meetings fetch is asserted not to happen before focus (#1421).
const meetingsServer = vi.hoisted(() => ({
	listUpcomingMeetings: vi.fn().mockResolvedValue([]),
	listPastMeetings: vi.fn().mockResolvedValue({
		meetings: [],
		timezone: "UTC",
		clubSlug: null,
		hasMore: false,
	}),
}));
vi.mock("#/server/meetings", () => meetingsServer);

const NOBODY = { hasOffice: false, isOfficer: false, isSuperadmin: false };
const OFFICER = { hasOffice: true, isOfficer: true, isSuperadmin: false };

describe("searchWorkspace", () => {
	const members = [
		{ id: "m1", name: "Faisal", officerPositions: [] },
		{ id: "m2", name: "Mahbuba", officerPositions: ["vp_education" as const] },
	];

	it("returns nothing for a blank query", () => {
		expect(searchWorkspace("   ", members, OFFICER)).toEqual({
			members: [],
			pages: [],
		});
	});

	it("matches members by name, case-insensitively", () => {
		const r = searchWorkspace("fai", members, NOBODY);
		expect(r.members.map((m) => m.name)).toEqual(["Faisal"]);
	});

	it("matches members by their current office label ('roles…')", () => {
		const r = searchWorkspace("education", members, NOBODY);
		expect(r.members.map((m) => m.name)).toEqual(["Mahbuba"]);
	});

	// protects=an office label finds the officer; fails_when=extraTerms is not passed; no_claim=page hits
	it("finds an officer by their office label", () => {
		expect(
			searchWorkspace("vp education", members, NOBODY).members.map(
				(m) => m.name,
			),
		).toEqual(["Mahbuba"]);
	});

	// protects=words match in any order and the result rows are the member rows unchanged; fails_when=matching is a plain substring or extraTerms leaks onto the row; no_claim=ranking inside a tier
	it("matches words in any order and returns plain member rows", () => {
		const r = searchWorkspace(
			"smith jo",
			[{ id: "j", name: "Jo Smith", officerPositions: [] }, ...members],
			NOBODY,
		);
		expect(r.members).toEqual([
			{ id: "j", name: "Jo Smith", officerPositions: [] },
		]);
	});

	// protects=results are ordered by match tier before the cap of 8, in a fixture where tier and alphabetical order disagree; fails_when=input order or alphabetical order is used instead; no_claim=localeCompare tie-break
	it("ranks by tier: prefix before substring, against alphabetical order", () => {
		// "Rosamund" sorts before "Samuel" alphabetically, so only tier ranking puts Samuel first.
		const r = searchWorkspace(
			"sam",
			[
				{ id: "a", name: "Rosamund", officerPositions: [] },
				{ id: "b", name: "Samuel", officerPositions: [] },
			],
			NOBODY,
		);
		expect(r.members.map((m) => m.name)).toEqual(["Samuel", "Rosamund"]);
	});

	// protects=the best-tier member survives the 8-result cap even when ten weaker matches sort first; fails_when=the cap is applied before ranking; no_claim=the order of the weaker matches
	it("keeps the best-tier match when the 8-result cap cuts the list", () => {
		const substring = Array.from({ length: 10 }, (_, i) => ({
			id: `s${i}`,
			name: `Rosamund ${i}`,
			officerPositions: [],
		}));
		const r = searchWorkspace(
			"sam",
			[...substring, { id: "p", name: "Samuel", officerPositions: [] }],
			NOBODY,
		);
		expect(r.members).toHaveLength(8);
		expect(r.members[0]?.name).toBe("Samuel");
	});

	// protects=a punctuation-only query lists no members; fails_when=the guard goes back to a bare trim() and the matcher's blank query lists the first 8; no_claim=page matching for punctuation
	it("returns no members for a punctuation-only query", () => {
		const members = [{ id: "a", name: "Ann", officerPositions: [] }];
		expect(searchWorkspace("%", members, NOBODY).members).toEqual([]);
		expect(searchWorkspace(".", members, NOBODY).members).toEqual([]);
	});

	it("caps member results at 8", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			id: `x${i}`,
			name: `Member ${i}`,
			officerPositions: [],
		}));
		expect(searchWorkspace("member", many, NOBODY).members).toHaveLength(8);
	});

	it("hides officer-only pages from plain members", () => {
		const plain = searchWorkspace("roles", [], NOBODY);
		expect(plain.pages.map((p) => p.label)).toEqual(["My roles"]);
		const officer = searchWorkspace("roles", [], OFFICER);
		expect(officer.pages.map((p) => p.label)).toEqual([
			"Meeting roles",
			"My roles",
		]);
	});

	it("hides Superadmin unless the user is a superadmin", () => {
		expect(searchWorkspace("super", [], OFFICER).pages).toEqual([]);
		expect(
			searchWorkspace("super", [], {
				...OFFICER,
				isSuperadmin: true,
			}).pages.map((p) => p.label),
		).toEqual(["Superadmin"]);
	});
});

function renderSearch(props: Partial<Parameters<typeof GlobalSearch>[0]> = {}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<GlobalSearch clubId="club-1" grants={OFFICER} {...props} />
		</QueryClientProvider>,
	);
}

describe("GlobalSearch", () => {
	afterEach(() => {
		cleanup();
		navigateMock.mockClear();
	});

	it("surfaces member and page results while typing (inline variant)", async () => {
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "e");
		expect(await screen.findByText("Mahbuba")).toBeTruthy();
		expect(screen.getByText("Next meeting")).toBeTruthy();
	});

	it("selecting a member navigates to their profile, closes the drawer, and clears the query", async () => {
		const onNavigate = vi.fn();
		renderSearch({ variant: "inline", onNavigate });
		const input = screen.getByRole<HTMLInputElement>("combobox");
		await userEvent.type(input, "mahbuba");
		await userEvent.click(await screen.findByText("Mahbuba"));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/members/$id",
			params: { id: "m2" },
		});
		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("");
	});

	it("selecting a page navigates to it and closes the drawer", async () => {
		const onNavigate = vi.fn();
		renderSearch({ variant: "inline", onNavigate });
		await userEvent.type(screen.getByRole("combobox"), "sign-up");
		await userEvent.click(await screen.findByText("Sign-up sheet"));
		expect(navigateMock).toHaveBeenCalledWith({ to: "/schedule" });
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});

	it("popover variant shows results anchored under the input while typing", async () => {
		renderSearch(); // default variant: popover (desktop top bar)
		await userEvent.type(screen.getByRole("combobox"), "faisal");
		expect(await screen.findByText("Faisal")).toBeTruthy();
	});

	it("Escape clears open results but keeps focus in the input", async () => {
		renderSearch({ variant: "inline" });
		const input = screen.getByRole<HTMLInputElement>("combobox");
		await userEvent.type(input, "faisal");
		expect(await screen.findByText("Faisal")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		expect(input.value).toBe("");
		expect(screen.queryByText("Faisal")).toBeNull();
	});

	it("clearResults() clears once then reports nothing left (drawer Escape ordering)", async () => {
		const ref = createRef<GlobalSearchHandle>();
		renderSearch({ variant: "inline", ref });
		const input = screen.getByRole<HTMLInputElement>("combobox");
		await userEvent.type(input, "faisal");
		let cleared = false;
		act(() => {
			cleared = ref.current?.clearResults() ?? false;
		});
		expect(cleared).toBe(true);
		expect(input.value).toBe("");
		act(() => {
			cleared = ref.current?.clearResults() ?? false;
		});
		expect(cleared).toBe(false);
	});

	it("still searches pages when there is no active club", async () => {
		renderSearch({ variant: "inline", clubId: null });
		await userEvent.type(screen.getByRole("combobox"), "roster");
		expect(await screen.findByText("Roster")).toBeTruthy();
	});

	it("shows an empty state when nothing matches", async () => {
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "zzz");
		expect(await screen.findByText(/No matches for/)).toBeTruthy();
	});
});

const meeting = (
	over: Partial<SearchableMeeting> & { id: string },
): SearchableMeeting => ({
	scheduledAt: new Date("2026-03-04T19:00:00Z"),
	theme: null,
	urlKey: "2026-03-04",
	timezone: "UTC",
	meetingNumber: null,
	upcoming: false,
	...over,
});

describe("searchMeetings", () => {
	const nov = meeting({
		id: "nov",
		scheduledAt: new Date("2026-11-04T19:00:00Z"),
		meetingNumber: 412,
		theme: "Growth Mindset",
	});

	// protects=a query word finds a meeting by day number, 3-letter or full month, in the club's timezone; fails_when=month/day matching is dropped, is prefix-based ("no" hits Nov), or reads UTC instead of the club zone; no_claim=other languages
	it("matches the date by day number, month abbreviation and full month", () => {
		const ids = (q: string) => searchMeetings(q, [nov]).map((m) => m.id);
		expect(ids("4")).toEqual(["nov"]);
		expect(ids("Nov")).toEqual(["nov"]);
		expect(ids("november")).toEqual(["nov"]);
		expect(ids("nov 4")).toEqual(["nov"]);
		expect(ids("no")).toEqual([]);
		expect(ids("nov 5")).toEqual([]);
		// 2026-11-04T01:00Z is Nov 3 in New York.
		const late = meeting({
			id: "ny",
			scheduledAt: new Date("2026-11-04T01:00:00Z"),
			timezone: "America/New_York",
		});
		expect(searchMeetings("3", [late])).toHaveLength(1);
		expect(searchMeetings("4", [late])).toHaveLength(0);
	});

	// protects=meeting number matches with or without '#', exactly; fails_when=41 matches #412 (substring) or '#' breaks it; no_claim=upcoming rows, which carry no number
	it("matches the meeting number, with or without #", () => {
		expect(searchMeetings("#412", [nov])).toHaveLength(1);
		expect(searchMeetings("412", [nov])).toHaveLength(1);
		expect(searchMeetings("41", [nov])).toHaveLength(0);
	});

	// protects=theme matches as a case-insensitive substring; fails_when=theme is ignored or case-sensitive; no_claim=word-order independence for themes
	it("matches the theme as a case-insensitive substring", () => {
		expect(searchMeetings("MINDSET", [nov])).toHaveLength(1);
		expect(searchMeetings("growth m", [nov])).toHaveLength(1);
		expect(searchMeetings("zzz", [nov])).toHaveLength(0);
	});

	// protects=upcoming soonest-first, then past newest-first, capped at 5 across both; fails_when=input order is kept, past precedes upcoming, or the cap is missing; no_claim=ties
	it("orders upcoming first then past newest-first, capped at 5", () => {
		const day = (n: number) => new Date(`2026-03-0${n}T19:00:00Z`);
		const rows = [
			meeting({ id: "p1", scheduledAt: day(1), theme: "x" }),
			meeting({ id: "p3", scheduledAt: day(3), theme: "x" }),
			meeting({ id: "p2", scheduledAt: day(2), theme: "x" }),
			meeting({ id: "u9", scheduledAt: day(9), theme: "x", upcoming: true }),
			meeting({ id: "u5", scheduledAt: day(5), theme: "x", upcoming: true }),
			meeting({
				id: "p0",
				scheduledAt: new Date("2026-02-01T19:00:00Z"),
				theme: "x",
			}),
		];
		expect(searchMeetings("x", rows).map((m) => m.id)).toEqual([
			"u5",
			"u9",
			"p3",
			"p2",
			"p1",
		]);
	});

	// protects=a blank query lists nothing; fails_when=blank matches every meeting; no_claim=punctuation-only queries
	it("returns nothing for a blank query", () => {
		expect(searchMeetings("  ", [nov])).toEqual([]);
	});
});

describe("GlobalSearch meetings group", () => {
	afterEach(() => {
		cleanup();
		navigateMock.mockClear();
		meetingsServer.listUpcomingMeetings.mockReset();
		meetingsServer.listPastMeetings.mockReset();
	});

	function mockMeetings() {
		meetingsServer.listUpcomingMeetings.mockReset();
		meetingsServer.listPastMeetings.mockReset();
		meetingsServer.listUpcomingMeetings.mockResolvedValue([]);
		meetingsServer.listPastMeetings.mockResolvedValue({
			meetings: [
				{
					id: "mt412",
					scheduledAt: new Date("2026-03-04T19:00:00Z"),
					theme: "Roots",
					urlKey: "2026-03-04",
					meetingNumber: 412,
				},
			],
			timezone: "UTC",
			clubSlug: "downtown",
			hasMore: true,
		});
	}

	// protects=nothing meeting-related is fetched on render, and both calls happen after focus (past with limit 52); fails_when=the queries are enabled on mount or the depth changes; no_claim=cache sharing
	it("fetches meetings only once the input is focused", async () => {
		mockMeetings();
		renderSearch();
		await new Promise((r) => setTimeout(r, 20));
		expect(meetingsServer.listUpcomingMeetings).not.toHaveBeenCalled();
		expect(meetingsServer.listPastMeetings).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("combobox"));
		await vi.waitFor(() =>
			expect(meetingsServer.listPastMeetings).toHaveBeenCalledWith({
				data: { clubId: "club-1", limit: 52 },
			}),
		);
		expect(meetingsServer.listUpcomingMeetings).toHaveBeenCalledWith({
			data: "club-1",
		});
	});

	// protects=typing a meeting number lists it under Meetings and choosing it navigates to the key URL; fails_when=the group is missing or navigation uses the id or the wrong slug; no_claim=Enter-key handling (rows are buttons)
	it("lists a meeting by number and navigates to it", async () => {
		mockMeetings();
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "412");
		expect(await screen.findByRole("list", { name: "Meetings" })).toBeTruthy();
		await userEvent.click(await screen.findByText(/#412/));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: "club-1", meetingId: "2026-03-04" },
		});
	});

	// protects=typing an upcoming meeting's number lists it under Meetings and navigates to its key; fails_when=search only matches numbers on past rows; no_claim=how the server derives the number
	it("finds an upcoming meeting by its number", async () => {
		meetingsServer.listUpcomingMeetings.mockResolvedValue([
			{
				id: "up413",
				scheduledAt: new Date("2099-03-11T19:00:00Z"),
				theme: "Horizons",
				urlKey: "2099-03-11",
				timezone: "UTC",
				meetingNumber: 413,
			},
		]);
		meetingsServer.listPastMeetings.mockResolvedValue({
			meetings: [],
			timezone: "UTC",
			clubSlug: "downtown",
			hasMore: false,
		});
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "#413");
		expect(await screen.findByRole("list", { name: "Meetings" })).toBeTruthy();
		await userEvent.click(await screen.findByText(/#413/));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: "club-1", meetingId: "2099-03-11" },
		});
	});

	// protects=upcoming meetings show while the past call is pending or has failed, and navigate; fails_when=the pool waits on the past response; no_claim=past rows
	it.each([
		["pending", () => new Promise(() => {})],
		["rejected", () => Promise.reject(new Error("boom"))],
	])("still lists upcoming meetings when the past call is %s", async (_n, past) => {
		meetingsServer.listUpcomingMeetings.mockResolvedValue([
			{
				id: "up1",
				scheduledAt: new Date("2099-03-04T19:00:00Z"),
				theme: "Horizons",
				urlKey: "2099-03-04",
				timezone: "UTC",
			},
		]);
		meetingsServer.listPastMeetings.mockImplementation(past);
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "horizons");
		await userEvent.click(await screen.findByText("Horizons"));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: "club-1", meetingId: "2099-03-04" },
		});
	});

	// protects=the shortcut hint shows on an empty popover input and hides once there is text; fails_when=it stays over typed text or shows in the drawer; no_claim=the hint's platform wording
	it("shows the shortcut hint only while empty, and only in the popover", async () => {
		const { container, unmount } = renderSearch();
		expect(container.querySelector("kbd")).toBeTruthy();
		await userEvent.type(screen.getByRole("combobox"), "a");
		expect(container.querySelector("kbd")).toBeNull();
		unmount();
		const drawer = renderSearch({ variant: "inline" });
		expect(drawer.container.querySelector("kbd")).toBeNull();
	});

	// protects=focus() on the handle focuses the input; fails_when=the handle method is missing or targets nothing; no_claim=the shell's key wiring
	it("focus() on the handle focuses the input", () => {
		const ref = createRef<GlobalSearchHandle>();
		renderSearch({ ref });
		act(() => ref.current?.focus());
		expect(document.activeElement).toBe(screen.getByRole("combobox"));
	});
});
