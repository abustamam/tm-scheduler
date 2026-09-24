// @vitest-environment jsdom
//
// Every `/club/<club>/meeting/<key>/…` sub-route takes a URL KEY (#877).
//
// `/meeting/2026-09-26` resolved the club-local date, and
// `/meeting/2026-09-26/agenda` crashed with a 500: the agenda editor handed the
// segment straight to `getAgendaDraft`, whose validator accepts only a uuid. The
// fix is that every sub-route sends the RAW segment to a key resolver, and turns
// its "Meeting not found." into `notFound()` — never into the error boundary.
//
// What this file can and cannot prove. Resolution itself happens server-side
// (`resolveMeetingKey`, DB-backed in `meeting-resolve.integration.test.ts`, which
// covers date, date-HHmm, uuid, a date with no meeting and a garbage key). What
// no test of that seam can see is whether a ROUTE reaches it with the segment
// untouched — the #877 bug was exactly a route that did not. So each loader is
// called directly, as the sibling `word` / `vote` / `print` loader tests do, with
// its server-fn modules mocked (they all reach `#/db`).
//
// Three cases per route, and the second is the one #877 is about:
//   • a DATE key reaches the resolver verbatim and the loader succeeds;
//   • a key the resolver answers "Meeting not found." for — a date with nothing
//     scheduled or a garbage key, which the server does not tell apart — is
//     `notFound()`, not a thrown Error;
//   • any other failure still propagates, so an outage is not disguised as a
//     dead link.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isNotFound,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({
	getPublicMeetingByKey: vi.fn(),
	getMeetingByKey: vi.fn(),
}));
vi.mock("#/server/meeting-key", () => ({
	resolveMeetingKeyForUser: vi.fn(),
}));
vi.mock("#/server/meeting-agenda-edit", () => ({
	addAgendaRoleFn: vi.fn(),
	addAgendaRowFn: vi.fn(),
	getAgendaDraft: vi.fn(),
	moveAgendaRowFn: vi.fn(),
	planRoleRemovalFn: vi.fn(),
	removeAgendaRoleFn: vi.fn(),
	removeAgendaRowFn: vi.fn(),
	updateAgendaRowFn: vi.fn(),
}));
vi.mock("#/server/personal-meeting", () => ({
	getPublicPersonalMeetingView: vi.fn(),
}));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));
vi.mock("#/server/voting", () => ({
	joinBallot: vi.fn(),
	getBallot: vi.fn(),
	submitVote: vi.fn(),
}));
vi.mock("#/server/members", () => ({ listMembers: vi.fn() }));
// Reached only through the components the routes render, none of which this
// file mounts past its not-found page. Empty, so a call would fail loudly.
vi.mock("#/server/attendance-plan", () => ({}));
vi.mock("#/server/availability", () => ({}));
vi.mock("#/server/timings", () => ({}));

import { MeetingNotFound } from "#/components/meeting-not-found";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getAgendaDraft } from "#/server/meeting-agenda-edit";
import { resolveMeetingKeyForUser } from "#/server/meeting-key";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";
import { Route as AgendaRoute } from "./club.$clubId.meeting.$meetingId_.agenda";
import { Route as MeRoute } from "./club.$clubId.meeting.$meetingId_.me";
import { Route as ThemeRoute } from "./club.$clubId.meeting.$meetingId_.me_.theme";
import { Route as TimerRoute } from "./club.$clubId.meeting.$meetingId_.me_.timer";
import { Route as MeWordRoute } from "./club.$clubId.meeting.$meetingId_.me_.word";
import { Route as PresentRoute } from "./club.$clubId_.meeting.$meetingId.present";
import { Route as PrintRoute } from "./club.$clubId_.meeting.$meetingId.print";
import { Route as VoteRoute } from "./club.$clubId_.meeting.$meetingId.vote";
import { Route as WordRoute } from "./club.$clubId_.meeting.$meetingId.word";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const DATE_KEY = "2026-09-26";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

/** A meeting detail generous enough for every loader's pass-through. */
function detail(clubId: string = CLUB_ID) {
	return {
		meeting: {
			id: MEETING_ID,
			clubId,
			scheduledAt: "2026-09-26T18:45:00Z",
			lengthMinutes: 60,
			theme: null,
			wordOfTheDay: null,
			location: null,
			reminders: null,
			status: "scheduled",
		},
		slots: [],
		timezone: "UTC",
		clubName: "Downtown Toastmasters",
		clubNumber: null,
		clubDistrict: null,
		clubMission: null,
		clubMeetingSchedule: null,
		meetingNumber: null,
		officers: [],
		geIntroducesFunctionaries: false,
		digitalVoting: true,
		canManage: false,
	};
}

// biome-ignore lint/suspicious/noExplicitAny: loaders take the full router ctx
type AnyRoute = { options: any; useParams: () => unknown };

function runLoader(route: AnyRoute, meetingId: string, shell = false) {
	return route.options.loader({
		params: { clubId: "downtown", meetingId },
		context: { clubUuid: CLUB_ID, shell, hasSession: true },
		location: {
			href: `/club/downtown/meeting/${meetingId}`,
			pathname: `/club/downtown/meeting/${meetingId}`,
			searchStr: "",
		},
	});
}

/** The public shell-escaping routes resolve the club themselves. */
function mockClub() {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		name: "Downtown Toastmasters",
		clubNumber: null,
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
	} as any);
	vi.mocked(getClubLogoMeta).mockResolvedValue(null);
}

const NOT_FOUND = () => new Error("Meeting not found.");

/**
 * Every sub-route that reads the meeting through `getPublicMeetingByKey` /
 * `getMeetingByKey`. `shell` picks which of the two the PII fork reaches; the
 * resolver half is identical, which is what is under test.
 */
const KEY_READER_ROUTES: {
	name: string;
	route: AnyRoute;
	shell: boolean;
	reader: typeof getPublicMeetingByKey;
}[] = [
	{ name: "me", route: MeRoute, shell: false, reader: getPublicMeetingByKey },
	{
		name: "me (signed-in member)",
		route: MeRoute,
		shell: true,
		reader: getPublicMeetingByKey,
	},
	{
		name: "me/theme",
		route: ThemeRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
	{
		name: "me/theme (signed-in member)",
		route: ThemeRoute,
		shell: true,
		reader: getMeetingByKey,
	},
	{
		name: "me/timer",
		route: TimerRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
	{
		name: "me/word",
		route: MeWordRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
	{
		name: "present",
		route: PresentRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
	{
		name: "print",
		route: PrintRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
	{
		name: "vote",
		route: VoteRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
	{
		name: "word",
		route: WordRoute,
		shell: false,
		reader: getPublicMeetingByKey,
	},
];

describe("meeting sub-routes resolve a date key (#877)", () => {
	for (const { name, route, shell, reader } of KEY_READER_ROUTES) {
		it(`${name}: sends the date key to the resolver verbatim`, async () => {
			mockClub();
			vi.mocked(reader).mockResolvedValue(
				// biome-ignore lint/suspicious/noExplicitAny: partial detail
				detail() as any,
			);

			await runLoader(route, DATE_KEY, shell);
			expect(reader).toHaveBeenCalledWith({
				data: { clubId: CLUB_ID, key: DATE_KEY },
			});
		});

		it(`${name}: a date with no meeting, or a garbage key, is notFound()`, async () => {
			mockClub();
			vi.mocked(reader).mockRejectedValue(NOT_FOUND());

			for (const key of [DATE_KEY, "not-a-meeting"]) {
				await expect(runLoader(route, key, shell)).rejects.toSatisfy(
					isNotFound,
				);
			}
		});

		it(`${name}: a meeting from another club is notFound()`, async () => {
			mockClub();
			vi.mocked(reader).mockResolvedValue(
				// biome-ignore lint/suspicious/noExplicitAny: partial detail
				detail("99999999-9999-4999-8999-999999999999") as any,
			);

			await expect(runLoader(route, DATE_KEY, shell)).rejects.toSatisfy(
				isNotFound,
			);
		});

		it(`${name}: any other failure still reaches the error boundary`, async () => {
			mockClub();
			const boom = new Error("connection terminated");
			vi.mocked(reader).mockRejectedValue(boom);

			await expect(runLoader(route, DATE_KEY, shell)).rejects.toBe(boom);
		});
	}
});

describe("agenda editor resolves the key before fetching the draft (#877)", () => {
	it("opens the editor for a date key, fetching the draft by the RESOLVED uuid", async () => {
		vi.mocked(resolveMeetingKeyForUser).mockResolvedValue({
			meetingId: MEETING_ID,
		});
		vi.mocked(getAgendaDraft).mockResolvedValue({
			templateName: "Standard meeting",
			// biome-ignore lint/suspicious/noExplicitAny: partial draft
		} as any);

		const data = await runLoader(AgendaRoute, DATE_KEY);

		expect(resolveMeetingKeyForUser).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, key: DATE_KEY },
		});
		// The #877 crash: this call used to receive "2026-09-26".
		expect(getAgendaDraft).toHaveBeenCalledWith({
			data: { meetingId: MEETING_ID },
		});
		// And the component's writes read the uuid off the loader, not the URL.
		expect(data).toMatchObject({
			meetingId: MEETING_ID,
			templateName: "Standard meeting",
		});
	});

	it("is notFound() for a date with no meeting or a garbage key, without fetching a draft", async () => {
		vi.mocked(resolveMeetingKeyForUser).mockRejectedValue(NOT_FOUND());

		for (const key of [DATE_KEY, "not-a-meeting"]) {
			await expect(runLoader(AgendaRoute, key)).rejects.toSatisfy(isNotFound);
		}
		expect(getAgendaDraft).not.toHaveBeenCalled();
	});

	it("lets any other resolver failure reach the error boundary", async () => {
		const boom = new Error("connection terminated");
		vi.mocked(resolveMeetingKeyForUser).mockRejectedValue(boom);

		await expect(runLoader(AgendaRoute, DATE_KEY)).rejects.toBe(boom);
		expect(getAgendaDraft).not.toHaveBeenCalled();
	});
});

/** Mount a component inside a bare router so `<Link>` has a context. */
async function renderInRouter(Component: () => React.ReactElement) {
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

/**
 * The routes this change owns render the MEETING not-found page, not the root's
 * generic one. `present`, `print` and `word` throw the same `notFound()` (above)
 * but carry no `notFoundComponent` of their own, so theirs is the root page.
 */
const OWNED_NOT_FOUND_ROUTES: { name: string; route: AnyRoute }[] = [
	{ name: "agenda", route: AgendaRoute },
	{ name: "me", route: MeRoute },
	{ name: "me/theme", route: ThemeRoute },
	{ name: "me/timer", route: TimerRoute },
	{ name: "me/word", route: MeWordRoute },
	{ name: "vote", route: VoteRoute },
];

describe("a missing meeting shows the meeting-not-found page (#877)", () => {
	for (const { name, route } of OWNED_NOT_FOUND_ROUTES) {
		it(`${name}: renders "Meeting not found" with a way back`, async () => {
			// Each route's not-found page reads the club off its own params; there
			// is no matching route in this bare router, so hand them over.
			vi.spyOn(route, "useParams").mockReturnValue({
				clubId: "downtown",
				meetingId: DATE_KEY,
			});
			const NotFound = route.options.notFoundComponent as
				| (() => React.ReactElement)
				| undefined;
			expect(NotFound, `${name} has no notFoundComponent`).toBeTypeOf(
				"function",
			);
			await renderInRouter(NotFound as () => React.ReactElement);

			expect(screen.getByText("Meeting not found")).toBeTruthy();
			const back = screen.getByRole("link", { name: "Back to meetings" });
			expect(back.getAttribute("href")).toContain("/club/downtown");
		});
	}

	it("the shared page names the club it links back to", async () => {
		await renderInRouter(() => <MeetingNotFound clubId="uptown" />);
		expect(
			screen
				.getByRole("link", { name: "Back to meetings" })
				.getAttribute("href"),
		).toContain("/club/uptown");
	});
});
