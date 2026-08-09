// @vitest-environment jsdom
//
// The Word of the Day poster ROUTE — the first route-component render test in
// this repo (TODOS.md). Everything below the route is already unit-tested
// (`word-poster.test.ts`, `word-of-the-day-poster.test.tsx`,
// `pdf-filename.test.ts`); what had no coverage at all is the route itself: the
// no-word branch, the <title> the browser turns into a saved-PDF filename, and
// the loader's cross-club guard. The no-word branch already regressed once — it
// shipped effectively invisible in dark mode, using the print palette's fixed
// INK on the app background — and the fix carried no regression test.
//
// The pattern, for the next route that needs one:
//   • `vi.mock` the route's server-fn and club-resolver imports. Both reach
//     `#/db` → `pg`, which must not load in a jsdom test; mocking them keeps
//     this a pure component/loader test.
//   • `Route.options.component` / `.head` / `.loader` are plain functions —
//     call `head`/`loader` directly, render `component`.
//   • The component reads `Route.useParams()` / `Route.useLoaderData()`, which
//     need a real match. Spy on those two instead of standing up a full router
//     with a loader, and mount under a minimal memory router so `<Link>`
//     resolves an href — that pattern is packaged as `renderUnderMemoryRouter`
//     in `src/test/router-harness.tsx`; the inline copy below predates it.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isNotFound,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { meetingPdfBasename } from "#/lib/pdf-filename";

vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
// The poster route now fetches the club logo. Mocked for the same reason as
// the two above: the real module reaches `#/db`, which throws without a
// DATABASE_URL in this unit-test environment.
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { Route } from "./club.$clubId_.meeting.$meetingId.word";

// afterEach below calls restoreAllMocks + clearAllMocks, which wipes any
// implementation set in the `vi.mock` factory. The loader awaits this call and
// chains `.catch()`, so a bare `vi.fn()` returning undefined would throw before
// the assertion under test ever runs. Re-establish the no-logo default per
// test; the tests that care about a logo override it.
beforeEach(() => {
	vi.mocked(getClubLogoMeta).mockResolvedValue(null);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// restoreAllMocks does not clear the `vi.fn()`s created by the module
	// factories above, so call history would leak between loader tests.
	vi.clearAllMocks();
	// UNCONDITIONAL, and none of the three calls above do it: a `vi.stubGlobal`
	// undone at the end of a test body is skipped when an assertion before it
	// throws, leaking a stubbed `window.print` into every later test in the file.
	vi.unstubAllGlobals();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const SCHEDULED_AT = "2026-07-31T18:45:00Z";

/** The loader payload shape the component reads, with only what it touches. */
function loaderData(
	overrides: {
		wordOfTheDay?: string | null;
		wodDefinition?: string | null;
		wodExample?: string | null;
		timezone?: string;
		clubName?: string;
	} = {},
) {
	// `??` would be wrong here: `null` is the case under test in half the rows
	// below, and would silently fall back to a real word.
	return {
		meeting: {
			clubId: CLUB_ID,
			scheduledAt: SCHEDULED_AT,
			wordOfTheDay:
				overrides.wordOfTheDay === undefined
					? "Ephemeral"
					: overrides.wordOfTheDay,
			wodDefinition:
				overrides.wodDefinition === undefined
					? "Lasting for a very short time; fleeting."
					: overrides.wodDefinition,
			wodExample:
				overrides.wodExample === undefined
					? "The applause was ephemeral, but the lesson stayed."
					: overrides.wodExample,
		},
		timezone: overrides.timezone ?? "UTC",
		clubName: overrides.clubName ?? "Downtown Toastmasters",
	};
}

/** Render the route's component with `useParams`/`useLoaderData` stubbed. */
async function renderRoute(data: ReturnType<typeof loaderData>) {
	vi.spyOn(Route, "useParams").mockReturnValue({
		clubId: "downtown",
		meetingId: "2026-07-31",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	vi.spyOn(Route, "useLoaderData").mockReturnValue(data as any);

	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("Word of the Day poster route — no-word branch", () => {
	// The button that links here is hidden without a word, so this branch is only
	// reachable by a typed or shared URL. It must offer the way back rather than
	// a blank sheet to print.
	it.each([
		["null", null],
		["an empty string", ""],
		["whitespace only", "   "],
	])("shows the empty state and no poster for %s", async (_label, word) => {
		await renderRoute(loaderData({ wordOfTheDay: word }));

		expect(
			screen.getByRole("heading", {
				name: "No Word of the Day set for this meeting yet.",
			}),
		).toBeTruthy();
		// The negative half is the point: no sheet, and nothing to print.
		expect(screen.queryByText("Word of the Day")).toBeNull();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		expect(screen.queryByTestId("wod-example")).toBeNull();
		expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
	});

	it("links back to the meeting it was opened from", async () => {
		await renderRoute(loaderData({ wordOfTheDay: null }));
		const back = screen.getByText("← Back to the meeting").closest("a");
		expect(back?.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-07-31",
		);
	});

	// It renders no <style> block and keeps the app background, so it must use
	// the app's theme tokens. The print palette's INK is a fixed near-black for
	// white paper and lands at 1.52:1 on the dark-mode background — this branch
	// shipped that way once and was effectively invisible.
	it("colors the empty state with a theme token, not the print ink", async () => {
		await renderRoute(loaderData({ wordOfTheDay: null }));
		const wrap = screen.getByRole("heading").parentElement;
		expect(wrap?.style.color).toBe("var(--sea-ink)");
	});

	// This branch renders no poster, and so none of the poster's <DarkFooter />
	// either — it is still a public club surface (#381 / ADR-0024). The source
	// grep in public-disclaimer.guard.test.ts pins that the element is present;
	// this pins that it actually renders the wording.
	it("carries the TI non-affiliation disclaimer", async () => {
		await renderRoute(loaderData({ wordOfTheDay: null }));
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});
});

describe("Word of the Day poster route — poster branch", () => {
	it("renders the poster with the meeting's word, definition, and example", async () => {
		await renderRoute(loaderData());
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.getByTestId("wod-definition").textContent).toBe(
			"Lasting for a very short time; fleeting.",
		);
		expect(screen.getByTestId("wod-example").textContent).toContain(
			"The applause was ephemeral, but the lesson stayed.",
		);
		expect(screen.queryByText(/No Word of the Day set/)).toBeNull();
	});

	it("names the club in the poster footer", async () => {
		await renderRoute(loaderData({ clubName: "Morning Communicators" }));
		expect(screen.getByText("Morning Communicators")).toBeTruthy();
	});

	// The footer date must be the meeting's calendar day in the CLUB's timezone,
	// not the viewer's. 02:00Z on Aug 1 is still Jul 31 in Los Angeles, so the
	// two renders below cannot agree unless `timezone` reaches the formatter.
	// The expected string is computed with the same Intl options on purpose: the
	// assertion under test is the timezone wiring, not the format, and building
	// the expectation this way keeps it locale-independent.
	it("formats the footer date in the club's timezone", async () => {
		const instant = "2026-08-01T02:00:00Z";
		const long = (tz: string) =>
			new Intl.DateTimeFormat(undefined, {
				weekday: "long",
				month: "long",
				day: "numeric",
				year: "numeric",
				timeZone: tz,
			}).format(new Date(instant));

		const data = loaderData({ timezone: "America/Los_Angeles" });
		data.meeting.scheduledAt = instant;
		await renderRoute(data);
		expect(screen.getByText(long("America/Los_Angeles"))).toBeTruthy();
		// And the two really are different days, or the assertion above would
		// hold for a hardcoded UTC formatter too.
		expect(long("America/Los_Angeles")).not.toBe(long("UTC"));
		expect(screen.queryByText(long("UTC"))).toBeNull();
	});

	it("offers a Print button that calls window.print", async () => {
		const print = vi.fn();
		vi.stubGlobal("print", print);
		await renderRoute(loaderData());
		const button = screen.getByRole("button", { name: "Print" });
		// The toolbar must not print itself.
		expect(button.closest(".no-print")).toBeTruthy();
		button.click();
		expect(print).toHaveBeenCalledTimes(1);
		// The stub is undone in afterEach, not here — see the note there.
	});

	it("treats a whitespace-padded word as a word, trimmed by the poster", async () => {
		await renderRoute(loaderData({ wordOfTheDay: "  Ephemeral  " }));
		expect(screen.getByText("Ephemeral")).toBeTruthy();
	});

	it("renders the word alone when the meeting has no definition or example", async () => {
		await renderRoute(loaderData({ wodDefinition: null, wodExample: null }));
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});
});

describe("Word of the Day poster route — <title> for the saved PDF", () => {
	const head = (loaderData: unknown) =>
		// biome-ignore lint/suspicious/noExplicitAny: head() takes the full ctx
		(
			Route.options.head as (ctx: any) => {
				meta: Array<Record<string, string>>;
			}
		)({ loaderData });

	it("titles the page with the word-of-the-day artifact, not an agenda", () => {
		const meta = head(loaderData()).meta;
		expect(meta[0]?.title).toBe(
			meetingPdfBasename(
				"Downtown Toastmasters",
				SCHEDULED_AT,
				"UTC",
				"word-of-the-day",
			),
		);
		// The artifact segment is the whole reason this route passes one: the
		// saved file must not read as the meeting agenda.
		expect(meta[0]?.title).toContain("word-of-the-day");
		expect(meta[0]?.title).not.toContain("-meeting-");
	});

	it("falls back to a static title during the pending state", () => {
		expect(head(undefined).meta[0]?.title).toBe("Word of the Day — GavelUp");
	});

	it("keeps the poster out of search results", () => {
		const robots = head(loaderData()).meta.find((m) => m.name === "robots");
		expect(robots?.content).toBe("noindex, nofollow");
	});
});

describe("Word of the Day poster route — loader", () => {
	const location = {
		pathname: "/club/downtown/meeting/2026-07-31/word",
		searchStr: "",
	};
	// biome-ignore lint/suspicious/noExplicitAny: loader takes the full router ctx
	const runLoader = (ctx: any) => (Route.options.loader as any)(ctx);

	it("resolves the club slug and loads the meeting through the PUBLIC read", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			slug: "downtown",
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		const data = loaderData();
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(data as any);

		const result = await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
		});

		// Not `toBe(data)` any more: the loader spreads the meeting read and adds
		// `logoUrl`, so identity no longer holds. Assert the contract instead —
		// every field of the meeting read survives, and the logo field is present
		// (null here, since this club has no logo).
		expect(result).toMatchObject(data);
		expect(result.logoUrl).toBeNull();
		// The RESOLVED club id, not the raw URL segment — the segment may be a
		// club number or a UUID.
		expect(getPublicMeetingByKey).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, key: "2026-07-31" },
		});
	});

	// A meeting key that resolves under a different club must not render that
	// club's word under this club's URL.
	it("404s when the meeting belongs to another club", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			slug: "downtown",
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		const foreign = loaderData();
		foreign.meeting.clubId = "22222222-2222-4222-8222-222222222222";
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(foreign as any);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-07-31" },
				location,
			}),
		).rejects.toSatisfy(isNotFound);
	});

	// An unknown meeting key must be a 404, not the error boundary: the server fn
	// signals "no such meeting" by throwing, and the loader has to translate it
	// the way the canonical meeting route does. Asserted through
	// `isMeetingNotFoundError`'s real input — the thrown Error's message — so a
	// change to that wording fails here rather than silently reverting to a 500.
	it("404s when the meeting key does not exist", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			slug: "downtown",
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(
			new Error("Meeting not found."),
		);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location,
			}),
		).rejects.toSatisfy(isNotFound);
	});

	// ...but only that error. Anything else is a real failure and must reach the
	// error boundary rather than being disguised as a missing page.
	it("propagates a non-not-found failure from the meeting read", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			slug: "downtown",
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		const boom = new Error("connection terminated");
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(boom);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-07-31" },
				location,
			}),
		).rejects.toBe(boom);
	});

	// Archived / unknown clubs and wrong-case slugs are `resolveClubOrRedirect`'s
	// job; the loader must not swallow the signal it throws.
	it("propagates the club resolver's redirect or not-found", async () => {
		const signal = new Error("redirect");
		vi.mocked(resolveClubOrRedirect).mockRejectedValue(signal);
		await expect(
			runLoader({
				params: { clubId: "DownTown", meetingId: "2026-07-31" },
				location,
			}),
		).rejects.toBe(signal);
		expect(getPublicMeetingByKey).not.toHaveBeenCalled();
	});
});
