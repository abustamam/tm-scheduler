// @vitest-environment jsdom
//
// #495 — the print route's LOADER wiring had zero test coverage before this
// file (the route itself had no test file at all, and `clubLogoUrl` — the
// only thing that turns `logoMeta` into `header.logoUrl` — is mocked away at
// the one other real call site, `club-settings.test.tsx`). This is narrowly
// scoped to the loader (not the rendered component, which needs a much larger
// fixture for `buildTimeline`/`buildRosterEntries`/etc.), following the
// pattern in `club.$clubId_.meeting.$meetingId.word.test.tsx`: call
// `Route.options.loader` directly with mocked server-fn/resolver imports.
//
// `#/lib/club-logo-url` is deliberately NOT mocked — using the real
// `clubLogoUrl` here is what actually proves the loader threads the resolved
// club id and the logo's `updatedAt` into it correctly, since the other call
// site can't (it mocks that function away).
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isRedirect,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import {
	CLUB_DEFAULT_LABEL,
	Route,
} from "./club.$clubId_.meeting.$meetingId.print";

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

/** The public-meeting payload shape the loader reads `meeting.clubId` off of
 *  and otherwise passes through untouched. */
function meetingData(clubId: string = CLUB_ID) {
	return {
		meeting: {
			clubId,
			scheduledAt: "2026-07-31T18:45:00Z",
			lengthMinutes: 60,
			theme: null,
			wordOfTheDay: null,
			location: null,
			reminders: null,
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
	};
}

const location = {
	pathname: "/club/downtown/meeting/2026-07-31/print",
	searchStr: "",
};
/** `loaderDeps` for a URL that names a valid layout: the loader renders. */
const NAMED_LAYOUT = { layoutMissing: false, chrome: undefined };

// biome-ignore lint/suspicious/noExplicitAny: loader takes the full router ctx
const runLoader = (ctx: any) => (Route.options.loader as any)(ctx);

describe("Print agenda route — loader logo wiring (#495)", () => {
	it("returns a null logoUrl when the club has no logo", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
		vi.mocked(getClubLogoMeta).mockResolvedValue(null);

		const result = await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
			deps: NAMED_LAYOUT,
		});

		expect(result.logoUrl).toBeNull();
	});

	it("builds the versioned logo URL from the RESOLVED club id and the logo's real updatedAt, through the real clubLogoUrl", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
		const updatedAt = "2026-07-31T00:00:00.000Z";
		vi.mocked(getClubLogoMeta).mockResolvedValue({ updatedAt });

		const result = await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
			deps: NAMED_LAYOUT,
		});

		expect(result.logoUrl).toBe(
			`/api/club/${CLUB_ID}/logo?v=${new Date(updatedAt).getTime()}`,
		);
	});

	// The resolved id, not the raw URL segment — the segment may be a club
	// number, slug, or UUID, and only `resolveClubOrRedirect`'s output is the
	// real club id `club_logos` is keyed on.
	it("fetches the logo meta for the RESOLVED club id, not the raw URL param", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
		vi.mocked(getClubLogoMeta).mockResolvedValue(null);

		await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
			deps: NAMED_LAYOUT,
		});

		expect(getClubLogoMeta).toHaveBeenCalledWith({ data: { clubId: CLUB_ID } });
	});
});

// ---------------------------------------------------------------------------
// The club's default layout (#1069). A URL that names no valid layout is
// redirected to the club's own default by the LOADER (only it knows the club),
// so `validateSearch` must stop defaulting and the loader must redirect.
// ---------------------------------------------------------------------------

const validateSearch = (s: Record<string, unknown>) =>
	// biome-ignore lint/suspicious/noExplicitAny: route option signatures
	(Route.options.validateSearch as any)(s);
const loaderDeps = (search: unknown) =>
	// biome-ignore lint/suspicious/noExplicitAny: route option signatures
	(Route.options.loaderDeps as any)({ search });

/** Run the loader for a URL with the given (raw) search, the way the router
 *  does: validate it, derive the deps, call the loader, and return what it
 *  threw or returned. */
async function loadWithSearch(rawSearch: Record<string, unknown>) {
	const deps = loaderDeps(validateSearch(rawSearch));
	try {
		return {
			result: await runLoader({
				params: { clubId: "downtown", meetingId: "2026-07-31" },
				location,
				deps,
			}),
		};
	} catch (thrown) {
		return { thrown };
	}
}

function mockClub(defaultPrintLayout: string) {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		defaultPrintLayout,
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
	} as any);
	// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
	vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
	vi.mocked(getClubLogoMeta).mockResolvedValue(null);
}

describe("Print agenda route — validateSearch no longer defaults (#1069)", () => {
	it("keeps a valid layout", () => {
		expect(validateSearch({ layout: "editorial" })).toEqual({
			layout: "editorial",
			chrome: undefined,
		});
	});

	it("leaves a missing, empty or unknown layout undefined instead of grid", () => {
		for (const raw of [
			{},
			{ layout: "" },
			{ layout: "bogus" },
			{ layout: 3 },
		]) {
			expect(validateSearch(raw).layout).toBeUndefined();
		}
	});

	it("derives only WHETHER a layout is named, so switching tabs does not re-run the loader", () => {
		expect(loaderDeps({ layout: "grid" })).toEqual(
			loaderDeps({ layout: "timing" }),
		);
		expect(loaderDeps({ layout: undefined }).layoutMissing).toBe(true);
	});
});

describe("Print agenda route — loader redirects to the club default (#1069)", () => {
	it("a bare /…/print redirects (307) to ?layout=<the club's default>, before fetching the meeting", async () => {
		mockClub("timing");
		const { thrown } = await loadWithSearch({});
		expect(isRedirect(thrown)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: redirect options
		const opts = (thrown as any).options;
		expect(opts.to).toBe("/club/$clubId/meeting/$meetingId/print");
		expect(opts.params).toEqual({
			clubId: "downtown",
			meetingId: "2026-07-31",
		});
		expect(opts.search).toEqual({ layout: "timing", chrome: undefined });
		expect((thrown as Response).status).toBe(307);
		expect(getPublicMeetingByKey).not.toHaveBeenCalled();
	});

	it("an unknown layout redirects to the club default too, and chrome=none survives", async () => {
		mockClub("spacious");
		const { thrown } = await loadWithSearch({
			layout: "bogus",
			chrome: "none",
		});
		expect(isRedirect(thrown)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: redirect options
		expect((thrown as any).options.search).toEqual({
			layout: "spacious",
			chrome: "none",
		});
	});

	it("a valid layout renders without a redirect, whatever the club's default, and returns the default for the tab marker", async () => {
		mockClub("timing");
		const { result, thrown } = await loadWithSearch({ layout: "editorial" });
		expect(thrown).toBeUndefined();
		expect(result.defaultPrintLayout).toBe("timing");
	});

	it("an unknown club is still a not-found, not a redirect", async () => {
		const notFoundError = new Error("not found");
		vi.mocked(resolveClubOrRedirect).mockRejectedValue(notFoundError);
		const { thrown } = await loadWithSearch({});
		expect(thrown).toBe(notFoundError);
	});
});

describe("Print agenda route — the Club default tab marker (#1069)", () => {
	async function renderPrint(search: { layout?: string; chrome?: "none" }) {
		vi.spyOn(Route, "useSearch").mockReturnValue(
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
			search as any,
		);
		vi.spyOn(Route, "useParams").mockReturnValue({
			clubId: "downtown",
			meetingId: "2026-07-31",
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		vi.spyOn(Route, "useLoaderData").mockReturnValue({
			...meetingData(),
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
			template: null,
			logoUrl: null,
			defaultPrintLayout: "timing",
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		const Component = Route.options.component as () => React.ReactElement;
		const rootRoute = createRootRoute({ component: () => <Component /> });
		const router = createRouter({
			routeTree: rootRoute,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		render(<RouterProvider router={router} />);
		// The toolbar is what these cases read, so wait for IT rather than for
		// the router to settle: under a full parallel run the router can still
		// read "pending" at waitFor's 1s default with the page already drawn.
		await waitFor(
			() =>
				expect(document.querySelector("[data-print-toolbar]")).not.toBeNull(),
			{ timeout: 10_000 },
		);
	}

	afterEach(cleanup);

	it("marks the club default's tab, and only that tab", async () => {
		await renderPrint({ layout: "grid" });
		const markers = screen.getAllByText(CLUB_DEFAULT_LABEL);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.closest("a")?.textContent).toBe(
			`Timing${CLUB_DEFAULT_LABEL}`,
		);
	});

	it("shows no marker under chrome=none, where there are no tabs", async () => {
		await renderPrint({ layout: "grid", chrome: "none" });
		expect(screen.queryByText(CLUB_DEFAULT_LABEL)).toBeNull();
	});
});
