// @vitest-environment jsdom
/**
 * The agenda editor's "Club settings" link carries the club whose agenda is
 * open (#685).
 *
 * ## Why this needs its own file, and its own router
 *
 * `agenda-editor-table-topics.test.tsx` already asserts this link's href, and
 * it will keep passing after this change — because `renderUnderMemoryRouter`
 * mounts a bare root route at `/`, where there are no path params at all. That
 * is the DEGRADED path (no club known ⇒ no `?club`, today's context-scoped
 * behaviour), and asserting it is worth keeping. It just cannot see the fix:
 * the club the link must carry only exists when the component is mounted under
 * `/club/$clubId/…`, which is the one place it ships. So this file builds a
 * router with that real path shape, and the shared harness stays untouched for
 * everything that does not need params.
 *
 * ## The bug
 *
 * The editor is URL-scoped, `/admin/club-settings` was context-scoped, and
 * nothing reconciled them. A multi-club admin editing club B's agenda whose
 * active club was A followed this link into A's settings and changed A's Table
 * Topics window — leaving the agenda in front of them untouched, which reads as
 * "the setting did nothing". A grep for the `<Link>` cannot tell the two cases
 * apart; only the rendered href can.
 *
 * The route's half (does `?club` select the right club, and is a club the
 * viewer has no rights on refused) is in
 * `src/routes/_authed/admin/club-settings-club-param.test.ts`. The two halves
 * meet at the parameter NAME, so they are written against the same literal
 * `club=` rather than against each other.
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft, AgendaDraftRow } from "#/server/meeting-agenda-edit";
import { AgendaEditor } from "./agenda-editor";

afterEach(cleanup);

const CLUB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEETING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** MCF's window as `loadAgendaDraft` hands it over: MINUTES, club-owned. */
const CLUB_MARKS = {
	markGreen: 1,
	markYellow: 1.8833333333333333,
	markRed: 2.75,
};

/** The Table Topics row, the one row whose detail panel carries the link. */
const TT_ROW: AgendaDraftRow = {
	id: "tt",
	sortOrder: 0,
	kind: "role",
	label: "Table Topics Master",
	detail: null,
	minutes: 5,
	roleKey: "table_topics_master",
	repeatsRoleKey: null,
	flex: true,
	handoff: false,
	...CLUB_MARKS,
};

const DRAFT: AgendaDraft = {
	templateId: "tpl",
	templateName: "Standard",
	editable: true,
	rows: [TT_ROW],
	roles: [
		{
			key: "table_topics_master",
			name: "Table Topics Master",
			category: "leadership",
			defaultCount: 1,
			isSpeakerRole: false,
		},
	],
	slots: [],
	scheduledAt: "2026-09-30T02:00:00.000Z",
	timeZone: "America/Chicago",
	lengthMinutes: 90,
	geIntroducesFunctionaries: false,
};

const noop = vi.fn(async () => ({}) as never);

function editor() {
	return (
		<AgendaEditor
			draft={DRAFT}
			onAddRow={vi.fn(async () => TT_ROW)}
			onUpdateRow={noop}
			onRemoveRow={noop}
			onMoveRow={noop}
			onRefresh={noop}
			onAddRole={noop}
			planRoleRemoval={vi.fn(async () => [])}
			onRemoveRole={noop}
		/>
	);
}

/**
 * Mount the editor at the URL it actually ships at, so `$clubId` resolves.
 *
 * Deliberately NOT `renderUnderMemoryRouter` — that harness's whole point is a
 * single parameterless root route, and giving it a params story would make
 * every caller pay for one. Pass `path: null` for the parameterless control.
 */
async function renderAt(path: string | null): Promise<void> {
	const rootRoute = createRootRoute(
		path === null ? { component: () => editor() } : {},
	);
	const routeTree =
		path === null
			? rootRoute
			: rootRoute.addChildren([
					createRoute({
						getParentRoute: () => rootRoute,
						path: "/club/$clubId/meeting/$meetingId/agenda",
						component: () => editor(),
					}),
				]);
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path ?? "/"] }),
	});
	render(<RouterProvider router={router as never} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

/** Open the Table Topics row's detail panel — the link lives behind it. */
async function openDetail() {
	await userEvent
		.setup()
		.click(screen.getAllByRole("button", { name: "Show row details" })[0]);
}

function settingsLinkHref(): string | null {
	const panel = screen.getByTestId("agenda-row-club-marks-tt");
	return within(panel)
		.getByRole("link", { name: /Club settings/ })
		.getAttribute("href");
}

describe("the agenda editor's Club settings link (#685)", () => {
	it("carries the club whose agenda is open, not the workspace's active one", async () => {
		// The reproduction. Before the fix this href was a bare
		// "/admin/club-settings" no matter which club's agenda was open, and the
		// settings page then resolved the ACTIVE club — a different one for the
		// multi-club admin this bug was reported by.
		await renderAt(`/club/${CLUB_B}/meeting/${MEETING}/agenda`);
		await openDetail();
		expect(settingsLinkHref()).toBe(`/admin/club-settings?club=${CLUB_B}`);
	});

	it("names the parameter `club`, which is the seam with the route", async () => {
		// Spelled out separately because the two halves of this fix can only
		// disagree here: rename the search key on either side and the link still
		// renders, the page still loads, and it silently shows the wrong club
		// again. Asserting the whole href above already covers it; this case
		// exists so the failure message says which half moved.
		await renderAt(`/club/${CLUB_B}/meeting/${MEETING}/agenda`);
		await openDetail();
		const href = settingsLinkHref() ?? "";
		expect(new URL(href, "https://example.test").searchParams.get("club")).toBe(
			CLUB_B,
		);
	});

	it("degrades to the plain link when there is no club in the URL", async () => {
		// The vacuity control, and the promise made to the two global-navigation
		// links: mounted anywhere without a `$clubId`, this emits no `?club` at
		// all rather than `?club=undefined`, so the route resolves from context
		// exactly as it does today.
		await renderAt(null);
		await openDetail();
		expect(settingsLinkHref()).toBe("/admin/club-settings");
	});
});
