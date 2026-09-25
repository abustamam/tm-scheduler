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
import { readdirSync } from "node:fs";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isNotFound,
	isRedirect,
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
// The agenda route's editor, stubbed to a prop recorder: what is under test is
// the meeting id the ROUTE hands each write, not the editor's own UI (covered
// by `agenda-editor.test.tsx`).
const editorProps = vi.hoisted(() => ({
	current: null as null | Record<string, (...args: never[]) => unknown>,
}));
vi.mock("#/components/agenda/agenda-editor", () => ({
	AgendaEditor: (props: Record<string, (...args: never[]) => unknown>) => {
		editorProps.current = props;
		return null;
	},
}));

import { MeetingNotFound } from "#/components/meeting-not-found";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import {
	addAgendaRowFn,
	getAgendaDraft,
	updateAgendaRowFn,
} from "#/server/meeting-agenda-edit";
import { resolveMeetingKeyForUser } from "#/server/meeting-key";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";
import { Route as AgendaRoute } from "./club.$clubId.meeting.$meetingId_.agenda";
import { Route as MeRoute } from "./club.$clubId.meeting.$meetingId_.me";
import { Route as ThemeRoute } from "./club.$clubId.meeting.$meetingId_.me_.theme";
import { Route as TimerRoute } from "./club.$clubId.meeting.$meetingId_.me_.timer";
import { Route as MeTopicsRoute } from "./club.$clubId.meeting.$meetingId_.me_.topics";
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

const FOREIGN_CLUB = "99999999-9999-4999-8999-999999999999";

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

const AGENDA_FILE = "club.$clubId.meeting.$meetingId_.agenda.tsx";

/**
 * Every sub-route that reads the meeting through `getPublicMeetingByKey` /
 * `getMeetingByKey`. `shell` picks which of the two the PII fork reaches; the
 * resolver half is identical, which is what is under test. `crossClubCheck` is
 * false for `me`, whose loader leaves that to the club-scoped resolver rather
 * than comparing `meeting.clubId` afterwards.
 */
const KEY_READER_ROUTES: {
	name: string;
	file: string;
	route: AnyRoute;
	shell: boolean;
	reader: typeof getPublicMeetingByKey;
	crossClubCheck: boolean;
}[] = [
	{
		name: "me",
		file: "club.$clubId.meeting.$meetingId_.me.tsx",
		route: MeRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: false,
	},
	{
		name: "me (signed-in member)",
		file: "club.$clubId.meeting.$meetingId_.me.tsx",
		route: MeRoute,
		shell: true,
		reader: getPublicMeetingByKey,
		crossClubCheck: false,
	},
	{
		name: "me/theme",
		file: "club.$clubId.meeting.$meetingId_.me_.theme.tsx",
		route: ThemeRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "me/theme (signed-in member)",
		file: "club.$clubId.meeting.$meetingId_.me_.theme.tsx",
		route: ThemeRoute,
		shell: true,
		reader: getMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "me/timer",
		file: "club.$clubId.meeting.$meetingId_.me_.timer.tsx",
		route: TimerRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "me/word",
		file: "club.$clubId.meeting.$meetingId_.me_.word.tsx",
		route: MeWordRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "me/topics",
		file: "club.$clubId.meeting.$meetingId_.me_.topics.tsx",
		route: MeTopicsRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "me/topics (signed-in member)",
		file: "club.$clubId.meeting.$meetingId_.me_.topics.tsx",
		route: MeTopicsRoute,
		shell: true,
		reader: getMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "present",
		file: "club.$clubId_.meeting.$meetingId.present.tsx",
		route: PresentRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "print",
		file: "club.$clubId_.meeting.$meetingId.print.tsx",
		route: PrintRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "vote",
		file: "club.$clubId_.meeting.$meetingId.vote.tsx",
		route: VoteRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
	{
		name: "word",
		file: "club.$clubId_.meeting.$meetingId.word.tsx",
		route: WordRoute,
		shell: false,
		reader: getPublicMeetingByKey,
		crossClubCheck: true,
	},
];

/** Every sub-route renders the MEETING not-found page, not the root's. */
const NOT_FOUND_ROUTES: { name: string; file: string; route: AnyRoute }[] = [
	{ name: "agenda", file: AGENDA_FILE, route: AgendaRoute },
	...KEY_READER_ROUTES.filter((r) => !r.name.includes("(")).map(
		({ name, file, route }) => ({ name, file, route }),
	),
];

/**
 * The sub-route set, DERIVED from the route directory rather than listed, so a
 * new `club.$clubId.meeting.$meetingId_.minutes.tsx` fails here until it is
 * added to both tables above — which means until someone has checked that it
 * resolves a key and renders the meeting not-found page. The two filename
 * shapes are the two ways a sub-route escapes the outlet-less meeting page:
 * `$meetingId_` under the club shell, `$clubId_` out of it.
 */
const SUBROUTE_FILE =
	/^club\.\$clubId(\.meeting\.\$meetingId_|_\.meeting\.\$meetingId)\..+\.tsx$/;

function meetingSubrouteFiles(files: string[]): string[] {
	return files.filter((f) => SUBROUTE_FILE.test(f) && !f.includes(".test."));
}

describe("every meeting sub-route is covered here (#877)", () => {
	const derived = meetingSubrouteFiles(readdirSync(__dirname));
	const resolved = new Set([
		AGENDA_FILE,
		...KEY_READER_ROUTES.map((r) => r.file),
	]);
	const notFound = new Set(NOT_FOUND_ROUTES.map((r) => r.file));

	// A walk that finds nothing would pass every case below.
	it("finds the sub-routes at all", () => {
		expect(derived.length).toBeGreaterThanOrEqual(9);
	});

	it("matches both escape shapes, and neither the meeting page nor a test", () => {
		expect(
			meetingSubrouteFiles([
				"club.$clubId.meeting.$meetingId_.minutes.tsx",
				"club.$clubId_.meeting.$meetingId.slides.tsx",
				"club.$clubId.meeting.$meetingId.tsx",
				"club.$clubId_.meeting.$meetingId.vote.test.tsx",
			]),
		).toEqual([
			"club.$clubId.meeting.$meetingId_.minutes.tsx",
			"club.$clubId_.meeting.$meetingId.slides.tsx",
		]);
	});

	for (const file of derived) {
		it(`${file} is tested for key resolution`, () => {
			expect(
				resolved.has(file),
				`${file} is a meeting sub-route with no key-resolution case. Add it to KEY_READER_ROUTES (or give it its own block like the agenda editor) after checking its loader sends the raw $meetingId to a key resolver and turns "Meeting not found." into notFound().`,
			).toBe(true);
		});

		it(`${file} is tested for the meeting not-found page`, () => {
			expect(
				notFound.has(file),
				`${file} is a meeting sub-route with no not-found case. Give it notFoundComponent (MeetingNotFound) and add it to NOT_FOUND_ROUTES.`,
			).toBe(true);
		});
	}
});

describe("meeting sub-routes resolve a date key (#877)", () => {
	for (const {
		name,
		route,
		shell,
		reader,
		crossClubCheck,
	} of KEY_READER_ROUTES) {
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

		if (crossClubCheck) {
			it(`${name}: a meeting from another club is notFound()`, async () => {
				mockClub();
				vi.mocked(reader).mockResolvedValue(
					// biome-ignore lint/suspicious/noExplicitAny: partial detail
					detail(FOREIGN_CLUB) as any,
				);

				await expect(runLoader(route, DATE_KEY, shell)).rejects.toSatisfy(
					isNotFound,
				);
			});
		}

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

	// The resolver is club-scoped (`resolveMeetingKey`'s own cross-club case is
	// DB-backed in `meeting-resolve.integration.test.ts`), so another club's
	// uuid arrives here as "Meeting not found." — and must stop before the draft,
	// or the editor would open someone else's agenda by uuid.
	it("is notFound() for another club's meeting uuid, without fetching a draft", async () => {
		vi.mocked(resolveMeetingKeyForUser).mockRejectedValue(NOT_FOUND());
		const foreignMeeting = "33333333-3333-4333-8333-333333333333";

		await expect(runLoader(AgendaRoute, foreignMeeting)).rejects.toSatisfy(
			isNotFound,
		);
		expect(resolveMeetingKeyForUser).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, key: foreignMeeting },
		});
		expect(getAgendaDraft).not.toHaveBeenCalled();
	});

	it("still redirects to the meeting page when the key resolves but the draft is null", async () => {
		vi.mocked(resolveMeetingKeyForUser).mockResolvedValue({
			meetingId: MEETING_ID,
		});
		vi.mocked(getAgendaDraft).mockResolvedValue(null);

		const thrown = await runLoader(AgendaRoute, DATE_KEY).catch(
			(e: unknown) => e,
		);
		expect(isRedirect(thrown), "the null-draft branch must redirect").toBe(
			true,
		);
		expect(thrown).toMatchObject({
			options: {
				to: "/club/$clubId/meeting/$meetingId",
				params: { clubId: "downtown", meetingId: DATE_KEY },
			},
		});
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

describe("the agenda editor's writes use the resolved uuid from a date URL (#877)", () => {
	async function renderEditorAtDateUrl() {
		editorProps.current = null;
		// The page as a date URL leaves it: the URL segment is the DATE, the
		// loader's draft carries the uuid it resolved to.
		vi.spyOn(AgendaRoute, "useParams").mockReturnValue({
			clubId: "downtown",
			meetingId: DATE_KEY,
		});
		vi.spyOn(AgendaRoute, "useLoaderData").mockReturnValue({
			meetingId: MEETING_ID,
			templateName: "Club agenda",
			// biome-ignore lint/suspicious/noExplicitAny: partial draft
		} as any);
		vi.spyOn(AgendaRoute, "useRouteContext").mockReturnValue({
			clubUuid: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial context
		} as any);
		await renderInRouter(
			AgendaRoute.options.component as () => React.ReactElement,
		);
		// Re-read through a cast: TypeScript narrowed `current` to `null` at the
		// reset above and cannot see the render assign it.
		const props = editorProps.current as Record<
			string,
			(...args: never[]) => unknown
		> | null;
		if (!props) throw new Error("the route did not render AgendaEditor");
		return props;
	}

	it("a pure edit submits the uuid, not the date", async () => {
		const props = await renderEditorAtDateUrl();
		vi.mocked(updateAgendaRowFn).mockResolvedValue(undefined);

		await (props.onUpdateRow as (r: string, p: object) => Promise<void>)(
			"row-1",
			{ title: "Opening" },
		);

		expect(updateAgendaRowFn).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING_ID,
				rowId: "row-1",
				patch: { title: "Opening" },
			},
		});
	});

	it("a structural write submits the uuid, not the date", async () => {
		const props = await renderEditorAtDateUrl();
		// biome-ignore lint/suspicious/noExplicitAny: partial row
		vi.mocked(addAgendaRowFn).mockResolvedValue({ id: "row-2" } as any);

		await (
			props.onAddRow as (after: string | null, kind: string) => Promise<unknown>
		)(null, "event");

		expect(addAgendaRowFn).toHaveBeenCalledWith({
			data: { meetingId: MEETING_ID, afterRowId: null, kind: "event" },
		});
	});
});

describe("a missing meeting shows the meeting-not-found page (#877)", () => {
	for (const { name, route } of NOT_FOUND_ROUTES) {
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
