// @vitest-environment jsdom
//
// Render tests for the personal meeting page's body (#665) and its non-happy
// page states (#676).
//
// These exist because the coverage audit proved the whole component was
// unreachable while it lived inside the route file: ~260 lines of branching,
// including the confirm gate on the ONLY irreversible write on the page, with
// no test surface at all. Extracting it to `components/club/` is what makes
// this file possible; `meeting-nav-strip.test.tsx` supplies the memory-router
// harness and `season-grid.test.tsx` the `vi.mock` of the write seams. #676
// moved the shell, the four page states and the meeting-key label across the
// same boundary, and everything under "(#676)" below is what that bought.
//
// The two most important cases here are the stale-`holdsRole` pair. These links
// sit in a chat for hours, so the cached `view` can be wrong in BOTH directions,
// and the first cut got one of them wrong each way: the write once branched on
// `holdsRole` (declining would leave a member declined AND still holding a role
// assigned after load), and then the CONFIRM still did (a role assigned after
// load meant the button read "No, I can't" and one tap released it silently).
//
// ## What a class assertion in this file does and does not buy
//
// jsdom performs no layout — CODING_STANDARDS.md, "Test coverage" — so the
// tap-target block below asserts that `min-h-11` is ON the element, NOT that
// the element renders 44px tall. That is a deletion gate and nothing more: it
// fails if a call site drops the class, and it would pass on a `min-h-11` that
// some later ancestor clipped or that a competing utility beat. The block says
// so again in situ, because the trap this repo has been burned by is exactly a
// class grep read as a geometry proof. Every other assertion here is about the
// DOM (text, roles, headings, hrefs, aria state), where jsdom is authoritative.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMeetingDate, formatMeetingTime } from "#/lib/format";

vi.mock("#/server/availability", () => ({
	markUnavailableReleasing: vi.fn(async () => ({ ok: true, released: 1 })),
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: vi.fn(async () => ({ ok: true })),
}));

const { markUnavailableReleasing } = await import("#/server/availability");
const { setPlannedAttendance } = await import("#/server/attendance-plan");
const {
	formatMeetingKeyLabel,
	FullMeetingLink,
	PersonalMeetingBody,
	PersonalMeetingLoading,
	PersonalMeetingNotice,
} = await import("./personal-meeting-body");
type PersonalMeetingView =
	import("#/server/personal-meeting").PersonalMeetingView;

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

/** A live, upcoming meeting where the member holds one duty-owning role. */
function makeView(
	over: Partial<PersonalMeetingView> = {},
): PersonalMeetingView {
	return {
		club: {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Harbor City Speakers",
			timezone: "America/Chicago",
		},
		meeting: {
			id: "22222222-2222-4222-8222-222222222222",
			// Comfortably in the future so `isMeetingOver`'s day check is false
			// regardless of when the suite runs — no wall-clock time bomb.
			scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			theme: null,
			wordOfTheDay: null,
			status: "scheduled",
		},
		member: { id: "33333333-3333-4333-8333-333333333333", name: "Marcus Lee" },
		roles: [
			{
				slotId: "44444444-4444-4444-8444-444444444444",
				roleName: "Toastmaster of the Day",
				roleKey: "toastmaster_of_the_day",
				speechTitle: null,
			},
		],
		planStatus: null,
		...over,
	};
}

/** Mounts anything that contains a router `<Link>`; `/club/$clubId/meeting/…`
 *  is registered so the duty rows and the forward link resolve real hrefs. */
async function renderInRouter(node: ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{node}</> });
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/meeting/$meetingId",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

async function renderBody(view: PersonalMeetingView, canRepick = true) {
	const onChanged = vi.fn(async () => {});
	const onNotYou = vi.fn();
	await renderInRouter(
		<PersonalMeetingBody
			view={view}
			clubId="harbor-city"
			meetingId="2026-09-05"
			onChanged={onChanged}
			onNotYou={onNotYou}
			canRepick={canRepick}
		/>,
	);
	return { onChanged, onNotYou };
}

/** A promise the test resolves by hand, so an in-flight write can be observed
 *  rather than raced. */
function deferred() {
	let settle!: () => void;
	const promise = new Promise<void>((resolve) => {
		settle = () => resolve();
	});
	return { promise, settle };
}

describe("PersonalMeetingBody — the confirm gate (#665)", () => {
	it("asks before releasing a role, and writes NOTHING until confirmed", async () => {
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "Can't make it" }),
		);

		// The whole point: the tap alone must not write. `markUnavailableReleasing`
		// nulls assigned_member_id and speech_id with no undo.
		expect(markUnavailableReleasing).not.toHaveBeenCalled();
		expect(await screen.findByText("Give up your role?")).toBeTruthy();

		await userEvent.click(
			screen.getByRole("button", { name: "Release & mark me away" }),
		);
		expect(markUnavailableReleasing).toHaveBeenCalledTimes(1);
	});

	it("confirms even when the cached view shows NO role", async () => {
		// The stale-state case. A role assigned after this page loaded is invisible
		// here, so a `holdsRole`-gated confirm would release it on one tap with no
		// warning. The dialog must appear whatever the cached roles say; only the
		// COPY changes.
		await renderBody(makeView({ roles: [] }));
		await userEvent.click(screen.getByRole("button", { name: "No, I can't" }));

		expect(markUnavailableReleasing).not.toHaveBeenCalled();
		expect(await screen.findByText("Tell us you can't make it?")).toBeTruthy();
	});

	it("keeps the role when the confirm is dismissed", async () => {
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "Can't make it" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Keep my role" }));
		expect(markUnavailableReleasing).not.toHaveBeenCalled();
	});

	it("declines through the RELEASING writer, never a plain not_coming", async () => {
		// `setPlannedAttendance({status:"not_coming"})` would leave the member
		// declined and still holding the role — the contradiction this page exists
		// to prevent.
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "Can't make it" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Release & mark me away" }),
		);
		expect(markUnavailableReleasing).toHaveBeenCalledTimes(1);
		expect(setPlannedAttendance).not.toHaveBeenCalled();
	});
});

describe("PersonalMeetingBody — confirming attendance", () => {
	it("writes coming in ONE tap, with no dialog", async () => {
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "I'll be there" }),
		);
		expect(setPlannedAttendance).toHaveBeenCalledTimes(1);
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({ status: "coming" }),
		});
		expect(screen.queryByText("Give up your role?")).toBeNull();
	});

	it("writes against the meeting UUID, not the URL segment", async () => {
		// Both writers validate `z.string().uuid()`; the `meetingId` prop here is
		// the date key "2026-09-05", which would be rejected at the write.
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "I'll be there" }),
		);
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({
				meetingId: "22222222-2222-4222-8222-222222222222",
			}),
		});
	});
});

describe("PersonalMeetingBody — when the window is closed", () => {
	it("offers no answer buttons for a meeting whose DAY has passed", async () => {
		// The destructive case red-team found: clubs routinely never press
		// Complete, so a past meeting sits at "scheduled" forever while its link
		// stays in the chat. `isMeetingLocked` alone would leave the buttons live.
		await renderBody(
			makeView({
				meeting: {
					...makeView().meeting,
					scheduledAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
					status: "scheduled",
				},
			}),
		);
		expect(screen.getByText(/answers are closed/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "I'll be there" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Can't make it" })).toBeNull();
	});

	it("offers no answer buttons for a completed meeting", async () => {
		await renderBody(
			makeView({
				meeting: { ...makeView().meeting, status: "completed" },
			}),
		);
		expect(
			screen.getByText("This meeting is finished, so answers are closed."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "I'll be there" })).toBeNull();
	});

	it("says cancelled, not finished, for a cancelled meeting", async () => {
		await renderBody(
			makeView({
				meeting: { ...makeView().meeting, status: "cancelled" },
			}),
		);
		expect(screen.getByText("This meeting was cancelled.")).toBeTruthy();
	});

	it("drops the call to action from a stored answer once writes are shut", async () => {
		// "Changed your mind? Tap below" with nothing below is the normal end
		// state of every link that outlived its meeting in a chat thread.
		await renderBody(
			makeView({
				planStatus: "coming",
				meeting: { ...makeView().meeting, status: "completed" },
			}),
		);
		expect(screen.getByText("You said you were coming.")).toBeTruthy();
		expect(screen.queryByText(/Tap below/)).toBeNull();
	});
});

describe("PersonalMeetingBody — what it renders", () => {
	it("names the roles the member holds", async () => {
		await renderBody(makeView());
		expect(
			screen.getByRole("heading", {
				name: /You're our Toastmaster of the Day for/,
			}),
		).toBeTruthy();
	});

	it("asks a plain coming question when the member holds nothing", async () => {
		await renderBody(makeView({ roles: [] }));
		expect(
			screen.getByRole("heading", { name: /Coming to the .* meeting\?/ }),
		).toBeTruthy();
	});

	it("shows a stored answer and still allows changing it", async () => {
		await renderBody(makeView({ planStatus: "not_coming" }));
		expect(screen.getByText(/You've said you can't make it/)).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "I'll be there",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("shows the duty checklist, with state readable without the icon", async () => {
		// The icons are aria-hidden, so the sr-only prefix is the only thing
		// carrying done/not-done to assistive tech.
		await renderBody(makeView());
		expect(
			screen.getByRole("link", { name: /Set the meeting theme/ }),
		).toBeTruthy();
		expect(screen.getByText("To do:")).toBeTruthy();
	});

	it("marks a duty done once the meeting carries the answer", async () => {
		await renderBody(
			makeView({ meeting: { ...makeView().meeting, theme: "New Beginnings" } }),
		);
		expect(screen.getByText("Done:")).toBeTruthy();
	});

	it("offers the confirm prompt for a role that owns no recordable duty", async () => {
		await renderBody(
			makeView({
				roles: [
					{
						slotId: "s2",
						roleName: "Table Topics Master",
						roleKey: "table_topics_master",
						speechTitle: null,
					},
				],
			}),
		);
		expect(screen.getByRole("link", { name: /Confirm the role/ })).toBeTruthy();
	});

	it("offers 'Not you?' to an anonymous visitor and hides it from a session", async () => {
		const { onNotYou } = await renderBody(makeView(), true);
		await userEvent.click(screen.getByRole("button", { name: "Not you?" }));
		expect(onNotYou).toHaveBeenCalledTimes(1);

		cleanup();
		await renderBody(makeView(), false);
		expect(screen.queryByRole("button", { name: "Not you?" })).toBeNull();
	});
});

describe("PersonalMeetingBody — the meeting TIME (#676)", () => {
	/** ~7 days out (so the write window is never shut by the clock) and at
	 *  23:30 UTC, which is a DIFFERENT calendar hour in America/Chicago. */
	function atNightUtc() {
		const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		d.setUTCHours(23, 30, 0, 0);
		return d;
	}

	it("shows the start time, in the CLUB's timezone", async () => {
		// The single job of this surface is a coming/not-coming decision, and
		// until #676 the only temporal string on it was `formatMeetingDate`'s
		// "Tue, Sep 9" — the start time, the fact the decision turns on, was
		// nowhere on the page.
		//
		// Asserted against the club zone AND against UTC because "no time at all"
		// is not the only failure: `formatMeetingTime(scheduledAt)` with the
		// timezone argument dropped typechecks, renders a plausible clock time,
		// and is wrong for every reader outside the club's zone. The fixture is
		// built to straddle midnight so the two strings cannot coincide, and the
		// first assertion fails loudly if that ever stops being true.
		const scheduledAt = atNightUtc();
		await renderBody(
			makeView({ meeting: { ...makeView().meeting, scheduledAt } }),
		);

		const inClub = formatMeetingTime(scheduledAt, "America/Chicago");
		const inUtc = formatMeetingTime(scheduledAt, "UTC");
		expect(inClub).not.toBe(inUtc);
		expect(inClub).toMatch(/\d{1,2}:\d{2}/);
		expect(screen.getByText(inClub)).toBeTruthy();
		expect(screen.queryByText(inUtc)).toBeNull();
	});

	it("no longer repeats the club name the shell header already prints", async () => {
		// The club shell renders `{clubName}` in a `text-[11px] … uppercase`
		// strip; this page's eyebrow printed it again ~50px below in near
		// identical styling. That band now carries the time instead.
		await renderBody(makeView());
		expect(screen.queryByText("Harbor City Speakers")).toBeNull();
	});
});

describe("PersonalMeetingBody — in-flight answers (#676)", () => {
	it("spins inside the answer that was tapped, and disables the other", async () => {
		// `busy` used to set `disabled` and nothing else, so both buttons faded
		// with no indication that anything was happening or which one was tapped.
		const d = deferred();
		vi.mocked(setPlannedAttendance).mockImplementationOnce((async () => {
			await d.promise;
			return { ok: true };
		}) as never);
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "I'll be there" }),
		);

		expect(await screen.findByText("Saving…")).toBeTruthy();
		const tapped = screen.getByRole("button", { name: /I'll be there/ });
		expect(tapped.getAttribute("aria-busy")).toBe("true");

		const other = screen.getByRole("button", {
			name: /Can't make it/,
		}) as HTMLButtonElement;
		expect(other.disabled).toBe(true);
		// The untapped answer must NOT claim to be working — that is the half of
		// the finding a plain boolean cannot express.
		expect(other.getAttribute("aria-busy")).not.toBe("true");

		await act(async () => {
			d.settle();
		});
		await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
	});

	it("spins inside the dialog's destructive commit, not the button that opens it", async () => {
		// Opening the confirm writes nothing, so the spinner belongs on the
		// commit. Anything else would report work that has not started.
		const d = deferred();
		vi.mocked(markUnavailableReleasing).mockImplementationOnce((async () => {
			await d.promise;
			return { ok: true, released: 1 };
		}) as never);
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "Can't make it" }),
		);
		// Merely opening it is not "working".
		expect(screen.queryByText("Saving…")).toBeNull();

		await userEvent.click(
			screen.getByRole("button", { name: /Release & mark me away/ }),
		);
		expect(await screen.findByText("Saving…")).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: /Release & mark me away/ })
				.getAttribute("aria-busy"),
		).toBe("true");

		await act(async () => {
			d.settle();
		});
		await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
	});
});

describe("PersonalMeetingBody — heading structure (#676)", () => {
	it("gives the role group a heading, and each role a heading of its own", async () => {
		// The page's only heading used to be the h1: the roles `<section>` had no
		// heading at all and the role NAME was a `<p>` at the same size as the
		// duty labels beneath it, so a heading-navigation pass saw one node.
		await renderBody(makeView());
		expect(
			screen.getByRole("heading", { level: 2, name: "Before the meeting" }),
		).toBeTruthy();
		expect(
			screen.getByRole("heading", { level: 3, name: "Toastmaster of the Day" }),
		).toBeTruthy();
	});

	it("gives one heading per role when the member holds two", async () => {
		const base = makeView();
		await renderBody(
			makeView({
				roles: [
					...base.roles,
					{
						slotId: "55555555-5555-4555-8555-555555555555",
						roleName: "Grammarian",
						roleKey: "grammarian",
						speechTitle: null,
					},
				],
			}),
		);
		expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
	});

	it("raises no group heading when the member holds nothing", async () => {
		await renderBody(makeView({ roles: [] }));
		expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
		expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
	});
});

describe("PersonalMeetingBody — tap targets (#676)", () => {
	// HONEST SCOPE, restated where it is easy to misread: every assertion in
	// this block is a CLASS assertion, not a geometry one. jsdom performs no
	// layout, so none of it can see that the element renders 44px tall — it
	// fails when a call site DROPS the class and it would pass on a `min-h-11`
	// that something else clipped or overrode. The repo's browser harnesses
	// (print sheets, pinned columns) are the only things here that can measure a
	// box, and standing a fifth one up for two buttons is not the trade.
	it("floors the two answer buttons above the 40px that `size=lg` gives", async () => {
		await renderBody(makeView());
		for (const name of ["I'll be there", "Can't make it"]) {
			expect(screen.getByRole("button", { name }).className).toContain(
				"min-h-11",
			);
		}
	});

	it("floors the destructive commit and its way out", async () => {
		await renderBody(makeView());
		await userEvent.click(
			screen.getByRole("button", { name: "Can't make it" }),
		);
		for (const name of ["Keep my role", "Release & mark me away"]) {
			expect(screen.getByRole("button", { name }).className).toContain(
				"min-h-11",
			);
		}
	});

	it("floors every duty row — they were bare ~20px text links", async () => {
		await renderBody(makeView());
		const rows = screen.getAllByRole("link");
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.className).toContain("min-h-11");
	});

	it("floors the confirm-prompt row a duty-less role gets instead", async () => {
		await renderBody(
			makeView({
				roles: [
					{
						slotId: "s2",
						roleName: "Table Topics Master",
						roleKey: "table_topics_master",
						speechTitle: null,
					},
				],
			}),
		);
		expect(
			screen.getByRole("link", { name: /Confirm the role/ }).className,
		).toContain("min-h-11");
	});

	it("gives 'Not you?' the page's own link colour and a real target", async () => {
		// It is the only correction affordance on a page designed to be
		// forwarded, and it was a muted ~20px run of underlined words whose only
		// other affordance was a hover state a phone cannot produce.
		await renderBody(makeView(), true);
		const btn = screen.getByRole("button", { name: "Not you?" });
		expect(btn.className).toContain("text-primary");
		expect(btn.className).toContain("min-h-11");
	});
});

describe("FullMeetingLink (#676)", () => {
	it("points FORWARD at the full meeting page", async () => {
		// This was a `BackLink` sitting above the h1. That component hard-codes an
		// `ArrowLeft` and is documented as the "Back to …" pattern for in-chrome
		// standalone pages — but arrival here is a chat link, so there is no
		// history behind the arrow, and it took the most prominent position on a
		// page whose job is to collect one answer.
		await renderInRouter(
			<FullMeetingLink clubId="harbor-city" meetingId="2026-09-05" />,
		);
		const link = screen.getByRole("link", { name: /full meeting page/i });
		expect(link.getAttribute("href")).toBe(
			"/club/harbor-city/meeting/2026-09-05",
		);
		expect(link.className).toContain("min-h-11");
	});
});

describe("the four non-happy page states (#676)", () => {
	it("gives a notice a real heading and names the meeting it is about", async () => {
		// All four rendered a bare grey `<p>`, so unless the happy path rendered
		// the page had no heading at all — and a failed load never told the
		// member which meeting they had landed on.
		render(
			<PersonalMeetingNotice
				title="We couldn't load this"
				meetingKey="2026-09-05"
			>
				Something went wrong on the way to us.
			</PersonalMeetingNotice>,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "We couldn't load this" }),
		).toBeTruthy();
		expect(
			screen.getByText(formatMeetingDate(new Date(2026, 8, 5))),
		).toBeTruthy();
		expect(
			screen.getByText("Something went wrong on the way to us."),
		).toBeTruthy();
	});

	it("says nothing about the date when the URL segment is a uuid", async () => {
		// The seam accepts a uuid segment too. Printing a guess there would be
		// worse than printing nothing.
		render(
			<PersonalMeetingNotice
				title="We couldn't find that meeting"
				meetingKey="22222222-2222-4222-8222-222222222222"
			>
				This link may be out of date.
			</PersonalMeetingNotice>,
		);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"We couldn't find that meeting",
		);
		expect(
			screen.queryByText("22222222-2222-4222-8222-222222222222"),
		).toBeNull();
	});

	it("loads with the repo's spinner AND the meeting it is loading", async () => {
		// The finding: a member on a slow connection saw a page whose entire
		// content was the word "Loading…".
		render(<PersonalMeetingLoading meetingKey="2026-09-05" />);
		const label = formatMeetingDate(new Date(2026, 8, 5));
		expect(screen.getByText(`Loading your ${label} meeting…`)).toBeTruthy();
	});

	it("still loads readably when the segment carries no date", async () => {
		render(
			<PersonalMeetingLoading meetingKey="22222222-2222-4222-8222-222222222222" />,
		);
		expect(screen.getByText("Loading your meeting…")).toBeTruthy();
	});
});

describe("formatMeetingKeyLabel (#676)", () => {
	it("reads a date key as a LOCAL calendar date", () => {
		// The reason the implementation builds `new Date(y, m - 1, d)` rather than
		// `new Date("2026-09-05")`: the string form is parsed as UTC midnight, so
		// any reader west of Greenwich is shown the day BEFORE the one in their
		// own URL. This asserts the round trip; whether the naive form would
		// differ depends on the runner's zone (CI is UTC, where it would not), so
		// what is pinned here is the calendar contract, not the westward shift.
		expect(formatMeetingKeyLabel("2026-09-05")).toBe(
			formatMeetingDate(new Date(2026, 8, 5)),
		);
		// Boundaries, where an off-by-one crosses a month and a year.
		expect(formatMeetingKeyLabel("2026-01-01")).toBe(
			formatMeetingDate(new Date(2026, 0, 1)),
		);
		expect(formatMeetingKeyLabel("2025-12-31")).toBe(
			formatMeetingDate(new Date(2025, 11, 31)),
		);
	});

	it("accepts the date-HHmm collision key and drops its time", () => {
		// `meetingUrlKey`'s second shape. The time in the URL is a disambiguator,
		// not a fact about the meeting, so printing it here would be inventing one.
		expect(formatMeetingKeyLabel("2026-09-05-1845")).toBe(
			formatMeetingKeyLabel("2026-09-05"),
		);
	});

	it("returns null for anything that is not a date key", () => {
		expect(
			formatMeetingKeyLabel("22222222-2222-4222-8222-222222222222"),
		).toBeNull();
		expect(formatMeetingKeyLabel("")).toBeNull();
		expect(formatMeetingKeyLabel("next-week")).toBeNull();
		expect(formatMeetingKeyLabel("2026-9-5")).toBeNull();
	});

	it("returns null for a date the calendar does not have", () => {
		// `new Date(2026, 12, 40)` rolls over silently, so the shape check alone
		// would print a real-looking wrong date for a nonsense URL.
		expect(formatMeetingKeyLabel("2026-13-40")).toBeNull();
		expect(formatMeetingKeyLabel("2026-02-30")).toBeNull();
		expect(formatMeetingKeyLabel("2025-02-29")).toBeNull();
	});
});
