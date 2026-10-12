// @vitest-environment jsdom
//
// The guest card's cross-club menu items (#1127), at the level a reader sees:
//
//  - "Add to <club>" renders only for a viewer who is an admin/officer of 2+
//    clubs, and lists only the clubs the server said the Person can still be
//    added to (`addableTo`).
//  - "Separate from other clubs" renders when `sharedWithOtherClub` is true.
//  - Neither is offered for a converted guest.
//
// The server decides everything above again; this only pins what is DRAWN.
// Pattern follows
// vp-membership.test.tsx: mock the server-fn module, stub `Route.useLoaderData`,
// render `Route.options.component`.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addGuestToClub,
	type PipelineGuestRow,
	separateGuest,
} from "#/server/guest-pipeline";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/guest-pipeline", () => ({
	addGuestToClub: vi.fn(),
	convertGuestToMember: vi.fn(),
	deleteGuest: vi.fn(),
	getGuestInviteContext: vi.fn(),
	getGuestPipeline: vi.fn(),
	getLinkCandidates: vi.fn(),
	getOtherAdminClubs: vi.fn(),
	linkGuestToMember: vi.fn(),
	recordGuestInvite: vi.fn(),
	separateGuest: vi.fn(),
	setGuestStage: vi.fn(),
	undoGuestConversion: vi.fn(),
	unlinkGuestFromMember: vi.fn(),
	updateGuest: vi.fn(),
}));
vi.mock("#/server/clubs", () => ({ getClubByIdentifier: vi.fn() }));
vi.mock("#/server/guests", () => ({
	getGuestProfile: vi.fn().mockResolvedValue(null),
	getGuestProfiles: vi.fn().mockResolvedValue({ rows: [], brought: [] }),
	updateGuestProfile: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Route } from "./vp-membership";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

const CLUB = "22222222-2222-4222-8222-222222222222";
const OTHER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GUEST = "11111111-1111-4111-8111-111111111111";
const TWO_CLUBS = [
	{ clubId: OTHER_1, name: "Harbor Speakers" },
	{ clubId: OTHER_2, name: "Hilltop Speakers" },
];

function guestRow(over: Partial<PipelineGuestRow> = {}): PipelineGuestRow {
	return {
		id: GUEST,
		name: "Ada Guest",
		preferredName: null,
		email: "ada@example.com",
		phone: "+14155552671",
		phoneRaw: "+14155552671",
		contactRefusal: null,
		stage: "prospect",
		convertedMembershipId: null,
		linkReversible: false,
		conversionUndoable: false,
		firstVisitAt: null,
		visitCount: 0,
		heldSlotCount: 0,
		lastInvite: null,
		inviteCount: 0,
		invitedMeetingIds: [],
		createdAt: new Date("2026-08-01T00:00:00Z"),
		...over,
	};
}

async function renderRoute(
	guests: PipelineGuestRow[],
	otherAdminClubs: { clubId: string; name: string }[],
) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		guests,
		profiles: { rows: [], brought: [] },
		clubId: CLUB,
		clubName: "Downtown Club",
		clubSlug: "downtown",
		inviteContext: {
			timezone: "America/Los_Angeles",
			nextMeeting: null,
		},
		readOnly: false,
		otherAdminClubs,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

function openMoreMenu(name: string) {
	fireEvent.keyDown(
		screen.getByRole("button", { name: `More actions for ${name}` }),
		{ key: "Enter" },
	);
}

const item = (name: RegExp | string) =>
	screen.queryByRole("menuitem", { name });

describe("guest card cross-club menu (#1127)", () => {
	it("a viewer of ONE club sees neither", async () => {
		await renderRoute([guestRow()], []);
		openMoreMenu("Ada Guest");
		await screen.findByRole("menuitem", { name: "Edit" });
		expect(item(/add to/i)).toBeNull();
		expect(item(/separate from other clubs/i)).toBeNull();
	});

	it("an officer of 2+ clubs sees Add to for each addable club only", async () => {
		await renderRoute([guestRow({ addableTo: [OTHER_2] })], TWO_CLUBS);
		openMoreMenu("Ada Guest");
		expect(
			await screen.findByRole("menuitem", { name: "Add to Hilltop Speakers" }),
		).toBeTruthy();
		// Already a guest at Harbor: not offered.
		expect(item("Add to Harbor Speakers")).toBeNull();
		// Not shared with another club: nothing to separate.
		expect(item(/separate from other clubs/i)).toBeNull();
	});

	it("Separate from other clubs renders when the Person is held elsewhere", async () => {
		await renderRoute([guestRow({ sharedWithOtherClub: true })], []);
		openMoreMenu("Ada Guest");
		expect(
			await screen.findByRole("menuitem", {
				name: /separate from other clubs/i,
			}),
		).toBeTruthy();
		expect(item(/add to/i)).toBeNull();
	});

	it("offers none of them for a converted guest", async () => {
		await renderRoute(
			[
				guestRow({
					stage: "joined",
					convertedMembershipId: "33333333-3333-4333-8333-333333333333",
					addableTo: [OTHER_1],
					sharedWithOtherClub: true,
				}),
			],
			TWO_CLUBS,
		);
		openMoreMenu("Ada Guest");
		await screen.findByRole("menuitem", { name: "Edit" });
		expect(item(/add to/i)).toBeNull();
		expect(item(/separate from other clubs/i)).toBeNull();
	});

	it("Add to <club> calls the server with this club as the source", async () => {
		vi.mocked(addGuestToClub).mockResolvedValue({ ok: true });
		await renderRoute([guestRow({ addableTo: [OTHER_1] })], TWO_CLUBS);
		openMoreMenu("Ada Guest");
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Add to Harbor Speakers" }),
		);
		await waitFor(() =>
			expect(addGuestToClub).toHaveBeenCalledWith({
				data: { fromClubId: CLUB, guestId: GUEST, toClubId: OTHER_1 },
			}),
		);
	});

	it("Separate asks first, then calls the server", async () => {
		vi.mocked(separateGuest).mockResolvedValue({ ok: true });
		vi.spyOn(window, "confirm").mockReturnValue(true);
		await renderRoute([guestRow({ sharedWithOtherClub: true })], []);
		openMoreMenu("Ada Guest");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: /separate from other clubs/i,
			}),
		);
		await waitFor(() =>
			expect(separateGuest).toHaveBeenCalledWith({
				data: { clubId: CLUB, guestId: GUEST },
			}),
		);
	});

	it("Separate does nothing when the officer declines", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(false);
		await renderRoute([guestRow({ sharedWithOtherClub: true })], []);
		openMoreMenu("Ada Guest");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: /separate from other clubs/i,
			}),
		);
		expect(separateGuest).not.toHaveBeenCalled();
	});
});
