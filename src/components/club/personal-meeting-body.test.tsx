// @vitest-environment jsdom
//
// Render tests for the personal meeting page's body (#665).
//
// These exist because the coverage audit proved the whole component was
// unreachable while it lived inside the route file: ~260 lines of branching,
// including the confirm gate on the ONLY irreversible write on the page, with
// no test surface at all. Extracting it to `components/club/` is what makes
// this file possible; `meeting-nav-strip.test.tsx` supplies the memory-router
// harness and `season-grid.test.tsx` the `vi.mock` of the write seams.
//
// The two most important cases here are the stale-`holdsRole` pair. These links
// sit in a chat for hours, so the cached `view` can be wrong in BOTH directions,
// and the first cut got one of them wrong each way: the write once branched on
// `holdsRole` (declining would leave a member declined AND still holding a role
// assigned after load), and then the CONFIRM still did (a role assigned after
// load meant the button read "No, I can't" and one tap released it silently).
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/availability", () => ({
	markUnavailableReleasing: vi.fn(async () => ({ ok: true, released: 1 })),
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: vi.fn(async () => ({ ok: true })),
}));

const { markUnavailableReleasing } = await import("#/server/availability");
const { setPlannedAttendance } = await import("#/server/attendance-plan");
const { PersonalMeetingBody } = await import("./personal-meeting-body");
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

async function renderBody(view: PersonalMeetingView, canRepick = true) {
	const onChanged = vi.fn(async () => {});
	const onNotYou = vi.fn();
	const rootRoute = createRootRoute({
		component: () => (
			<PersonalMeetingBody
				view={view}
				clubId="harbor-city"
				meetingId="2026-09-05"
				onChanged={onChanged}
				onNotYou={onNotYou}
				canRepick={canRepick}
			/>
		),
	});
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
	return { onChanged, onNotYou };
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
