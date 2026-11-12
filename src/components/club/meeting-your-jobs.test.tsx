// @vitest-environment jsdom
//
// Render tests for the meeting page's "Your jobs" card (#1376).
// jsdom performs no layout: every assertion is about DOM text, roles and hrefs.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/personal-meeting", () => ({
	getPublicPersonalMeetingView: vi.fn(),
}));

vi.mock("#/server/slots", () => ({ confirmSlot: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), message: vi.fn() } }));
vi.mock("#/components/write-error-toast", () => ({ showWriteError: vi.fn() }));

const { confirmSlot } = await import("#/server/slots");
const { toast } = await import("sonner");
const { showWriteError } = await import("#/components/write-error-toast");
const { getPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting"
);
const { MeetingYourJobs } = await import("./meeting-your-jobs");
const { buildDutyContext } = await import("./duty-context");
type PersonalMeetingView =
	import("#/server/personal-meeting").PersonalMeetingView;

import { dutiesForRole } from "#/lib/role-duties";

const mockView = vi.mocked(getPublicPersonalMeetingView);
const MEMBER = "33333333-3333-4333-8333-333333333333";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function role(
	over: Partial<PersonalMeetingView["roles"][number]> = {},
): PersonalMeetingView["roles"][number] {
	return {
		slotId: "slot-tmod",
		roleName: "Toastmaster of the Day",
		roleKey: "toastmaster_of_the_day",
		speechTitle: null,
		status: "claimed",
		...over,
	};
}

function makeView(
	over: Partial<PersonalMeetingView> = {},
	meeting: Partial<PersonalMeetingView["meeting"]> = {},
): PersonalMeetingView {
	return {
		club: { id: "club-uuid", name: "Harbor", timezone: "America/Chicago" },
		meeting: {
			id: "meeting-uuid",
			scheduledAt: new Date(Date.now() + 7 * 86400000),
			lengthMinutes: 90,
			theme: null,
			wordOfTheDay: null,
			tableTopicsNotes: null,
			hasTiming: false,
			status: "scheduled",
			...meeting,
		},
		member: { id: MEMBER, name: "Marcus" },
		roles: [role()],
		planStatus: null,
		...over,
	};
}

async function renderCard(
	view: PersonalMeetingView | null | Error,
	props: {
		memberId?: string | null;
		source?: "session" | "anon";
		qc?: QueryClient;
		onRouter?: (router: { invalidate: () => Promise<void> }) => void;
	} = {},
) {
	if (view instanceof Error) mockView.mockRejectedValue(view);
	else mockView.mockResolvedValue(view);
	const qc =
		props.qc ??
		new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<MeetingYourJobs
					clubId="harbor"
					clubUuid="club-uuid"
					meetingKey="2026-11-03"
					memberId={props.memberId === undefined ? MEMBER : props.memberId}
					source={props.source ?? "session"}
				/>
			</QueryClientProvider>
		),
	});
	rootRoute.addChildren(
		[
			"/club/$clubId/meeting/$meetingId",
			"/club/$clubId/meeting/$meetingId/me",
			"/club/$clubId/meeting/$meetingId/me/theme",
			"/club/$clubId/meeting/$meetingId/me/word",
			"/club/$clubId/meeting/$meetingId/me/topics",
			"/club/$clubId/meeting/$meetingId/me/timer",
			"/signin",
		].map((path) =>
			createRoute({
				getParentRoute: () => rootRoute,
				path,
				component: () => null,
			}),
		),
	);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	props.onRouter?.(router);
	return qc;
}

describe("MeetingYourJobs (#1376)", () => {
	// protects=an unticked theme row linking to the editor; fails_when=the row
	// is missing, ticked, or links elsewhere; no_claim=the editor route works.
	it("lists a TMOD's theme duty, unticked, linking to /me/theme", async () => {
		await renderCard(makeView());
		expect(
			await screen.findByRole("heading", { name: "Your jobs" }),
		).toBeTruthy();
		const link = screen.getByRole("link", { name: /Set the meeting theme/ });
		expect(link.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me/theme",
		);
		expect(link.textContent).toContain("To do:");
	});

	// protects=done rows stay visible and clickable; fails_when=a done duty is
	// hidden or loses its link; no_claim=the theme is actually saved.
	it("ticks a done duty and keeps it a link", async () => {
		await renderCard(makeView({}, { theme: "Courage" }));
		const link = await screen.findByRole("link", {
			name: /Set the meeting theme/,
		});
		expect(link.textContent).toContain("Done:");
		expect(link.getAttribute("href")).toContain("/me/theme");
	});

	// protects=per-slot speech rows; fails_when=one real title ticks both rows or
	// "TBA" counts as done; no_claim=the title is saved server-side.
	it("renders one speech row per speaker slot and ticks only the titled one", async () => {
		await renderCard(
			makeView({
				roles: [
					role({
						slotId: "sp1",
						roleName: "Speaker",
						roleKey: "speaker",
						speechTitle: "Real talk",
					}),
					role({
						slotId: "sp2",
						roleName: "Speaker",
						roleKey: "speaker",
						speechTitle: "TBA",
					}),
				],
			}),
		);
		const rows = await screen.findAllByRole("link", {
			name: /Add your speech details/,
		});
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain("Done:");
		expect(rows[1].textContent).toContain("To do:");
		expect(rows[0].getAttribute("href")).toBe("#slot-sp1");
		expect(rows[1].getAttribute("href")).toBe("#slot-sp2");
	});

	// protects=anon speech link goes to sign-in with a return path; fails_when=an
	// anon visitor gets a dead in-page anchor; no_claim=sign-in returns here.
	it("sends an anonymous pick to sign in for speech details", async () => {
		await renderCard(
			makeView({
				roles: [
					role({ slotId: "sp1", roleName: "Speaker", roleKey: "speaker" }),
				],
			}),
			{ source: "anon" },
		);
		const link = await screen.findByRole("link", {
			name: /Sign in to add your speech details/,
		});
		const href = link.getAttribute("href") ?? "";
		expect(href.startsWith("/signin")).toBe(true);
		expect(decodeURIComponent(href)).toContain(
			"redirect=/club/harbor/meeting/2026-11-03",
		);
	});

	// protects=a cancelled meeting shows no card; fails_when=it renders;
	// no_claim=the page hides other cancelled-meeting surfaces.
	it("renders nothing for a cancelled meeting", async () => {
		await renderCard(makeView({}, { status: "cancelled" }));
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=no card for a member with no role; fails_when=an empty card
	// renders; no_claim=roles are loaded correctly server-side.
	it("renders nothing when the member holds no role", async () => {
		await renderCard(makeView({ roles: [] }));
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=a rejected member id (null view) renders nothing; fails_when=it
	// renders an empty card or throws; no_claim=the server rejects the id.
	it("renders nothing for a rejected member (null view)", async () => {
		await renderCard(null);
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=no identity means no request and no card; fails_when=the fetch
	// fires with a null member id or a card renders; no_claim=identity
	// resolution (the route owns it).
	it("renders nothing and does not fetch without an identity", async () => {
		await renderCard(makeView(), { memberId: null });
		expect(mockView).not.toHaveBeenCalled();
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=a failed fetch must not break the agenda; fails_when=the card
	// throws or shows an error; no_claim=the error is reported anywhere.
	it("renders nothing when the query errors", async () => {
		await renderCard(new Error("boom"));
		await waitFor(() => expect(mockView).toHaveBeenCalled());
		expect(screen.queryByText("Your jobs")).toBeNull();
	});

	// protects=the cache is shared with /me (same key) and one request is made;
	// fails_when=the key shape drifts or a second request fires; no_claim=/me
	// invalidations reach this key (see the remount test below).
	it("shares /me's query key and issues one request", async () => {
		const qc = await renderCard(makeView());
		await screen.findByText("Your jobs");
		expect(mockView).toHaveBeenCalledTimes(1);
		expect(mockView).toHaveBeenCalledWith({
			data: { clubId: "club-uuid", meetingKey: "2026-11-03", memberId: MEMBER },
		});
		expect(
			qc.getQueryData(["personal-meeting", "club-uuid", "2026-11-03", MEMBER]),
		).toBeTruthy();
	});

	// protects=every duty kind renders its row, state and href; fails_when=a
	// kind's row is missing, mis-linked, or ticks off the wrong field;
	// no_claim=the editors exist (personal-duty-routes guard).
	it("renders each duty kind with its href and tick", async () => {
		await renderCard(
			makeView(
				{
					roles: [
						role({
							slotId: "g",
							roleName: "Grammarian",
							roleKey: "grammarian",
						}),
						role({
							slotId: "t",
							roleName: "Table Topics Master",
							roleKey: "table_topics_master",
						}),
						role({ slotId: "ti", roleName: "Timer", roleKey: "timer" }),
					],
				},
				{ wordOfTheDay: "Gregarious", hasTiming: false, tableTopicsNotes: "x" },
			),
		);
		const word = await screen.findByRole("link", {
			name: /Set the Word of the Day/,
		});
		expect(word.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me/word",
		);
		expect(word.textContent).toContain("Done:");
		const topics = screen.getByRole("link", { name: /Set your Table Topics/ });
		expect(topics.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me/topics",
		);
		expect(topics.textContent).toContain("Done:");
		const timing = screen.getByRole("link", { name: /Time the speeches/ });
		expect(timing.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me/timer",
		);
		expect(timing.textContent).toContain("To do:");
	});

	// protects=an anonymous pick whose title is set sees a done, struck row that
	// reads as the duty, not a sign-in prompt; fails_when=the struck row says
	// "Sign in"; no_claim=sign-in works.
	it("shows an anonymous pick's finished speech row without a sign-in prompt", async () => {
		await renderCard(
			makeView({
				roles: [
					role({
						slotId: "sp1",
						roleName: "Speaker",
						roleKey: "speaker",
						speechTitle: "Real talk",
					}),
				],
			}),
			{ source: "anon" },
		);
		const link = await screen.findByRole("link", {
			name: /Add your speech details/,
		});
		expect(link.textContent).toContain("Done:");
		expect(link.getAttribute("href")).toBe("#slot-sp1");
		expect(screen.queryByText(/Sign in to add/)).toBeNull();
	});

	// protects=an edit made on /me under a different key segment is picked up
	// when the card remounts; fails_when=the card trusts a cached view and never
	// revalidates; no_claim=/me's own invalidation keys.
	it("revalidates a stale cached view when it mounts", async () => {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
		});
		qc.setQueryData(
			["personal-meeting", "club-uuid", "2026-11-03", MEMBER],
			makeView(),
		);
		await renderCard(makeView({}, { theme: "Fresh" }), { qc });
		const link = await screen.findByRole("link", {
			name: /Set the meeting theme/,
		});
		await waitFor(() => expect(link.textContent).toContain("Done:"));
		expect(mockView).toHaveBeenCalledTimes(1);
	});

	// protects=the footer link to /me carries no ?as=; fails_when=a search param
	// is added; no_claim=/me resolves the same identity (route test).
	it("links to the personal page without ?as=", async () => {
		await renderCard(makeView());
		const link = await screen.findByRole("link", {
			name: "Open your meeting page",
		});
		expect(link.getAttribute("href")).toBe(
			"/club/harbor/meeting/2026-11-03/me",
		);
	});
});

describe("buildDutyContext", () => {
	// protects=per-slot title, meeting-scoped timing; fails_when=fields drift;
	// no_claim=/me uses the helper (the wiring guards pin that).
	it("maps the view onto the duty context", () => {
		const v = makeView(
			{},
			{ theme: "T", wordOfTheDay: "W", tableTopicsNotes: "N", hasTiming: true },
		);
		expect(buildDutyContext(v, role({ speechTitle: "S" }))).toEqual({
			theme: "T",
			wordOfTheDay: "W",
			tableTopicsNotes: "N",
			speechTitle: "S",
			hasTiming: true,
		});
	});

	// protects=the helper is a faithful extraction of what /me built inline
	// before #1376, for every duty kind; fails_when=any duty's done() differs
	// between the helper's context and the old inline one; no_claim=/me calls it.
	it("gives the same ticks as /me's former inline context, per duty kind", () => {
		const legacy = (
			view: PersonalMeetingView,
			r: PersonalMeetingView["roles"][number],
		) => ({
			theme: view.meeting.theme,
			wordOfTheDay: view.meeting.wordOfTheDay,
			tableTopicsNotes: view.meeting.tableTopicsNotes,
			speechTitle: r.speechTitle,
			hasTiming: view.meeting.hasTiming,
		});
		const keys = [
			"toastmaster_of_the_day",
			"grammarian",
			"speaker",
			"table_topics_master",
			"timer",
		];
		for (const filled of [false, true]) {
			const v = makeView(
				{},
				filled
					? {
							theme: "T",
							wordOfTheDay: "W",
							tableTopicsNotes: "N",
							hasTiming: true,
						}
					: {},
			);
			for (const roleKey of keys) {
				const r = role({ roleKey, speechTitle: filled ? "S" : null });
				expect(buildDutyContext(v, r)).toEqual(legacy(v, r));
				for (const duty of dutiesForRole({ roleName: r.roleName, roleKey })) {
					expect(duty.done(buildDutyContext(v, r))).toBe(
						duty.done(legacy(v, r)),
					);
					expect(duty.done(buildDutyContext(v, r))).toBe(filled);
				}
			}
		}
	});
});

describe("MeetingYourJobs confirm (#1612)", () => {
	const claimed = (slotId: string, roleName: string) =>
		role({ slotId, roleName, roleKey: "x", status: "claimed" });
	const confirmed = (slotId: string, roleName: string) =>
		role({ slotId, roleName, roleKey: "x", status: "confirmed" });
	const confirmBtn = (n: string) => screen.queryByRole("button", { name: n });
	// A confirmSlot that settles when the test says so.
	function heldConfirm() {
		let release: () => void = () => {};
		vi.mocked(confirmSlot).mockReturnValue(
			new Promise((r) => {
				release = () => r({} as never);
			}) as never,
		);
		return () => release();
	}

	// protects=each held role shows its own status and only a claimed role
	// offers Confirm; fails_when=the label ignores status or a confirmed role
	// gets a button; no_claim=the server's own confirm checks.
	it("shows status per role and a Confirm button only for a claimed role", async () => {
		await renderCard(
			makeView({
				planStatus: "coming",
				roles: [claimed("s1", "Timer"), confirmed("s2", "Grammarian")],
			}),
		);
		expect(await screen.findByText("Not confirmed yet")).toBeTruthy();
		expect(screen.getByText("Confirmed")).toBeTruthy();
		expect(confirmBtn("Confirm Timer")).toBeTruthy();
		expect(confirmBtn("Confirm Grammarian")).toBeNull();
	});

	// protects=one tap confirms exactly the tapped slot as the page's member,
	// refreshes the route loader, and the card then shows the truth; fails_when=
	// the slot or memberId is wrong, router.invalidate is dropped, or the other
	// claimed role is confirmed too; no_claim=the count line ("Roles confirmed
	// N/M"), which the route's loader renders.
	it("one tap confirms only that role, invalidates the router, and shows the result", async () => {
		vi.mocked(confirmSlot).mockResolvedValue({} as never);
		let router: { invalidate: () => Promise<void> } | undefined;
		await renderCard(
			makeView({
				planStatus: "coming",
				roles: [claimed("s1", "Timer"), claimed("s2", "Ah-Counter")],
			}),
			{ onRouter: (r) => (router = r) },
		);
		const invalidate = vi.spyOn(router as never, "invalidate" as never);
		const button = await screen.findByRole("button", {
			name: "Confirm Timer",
		});
		mockView.mockResolvedValue(
			makeView({
				planStatus: "coming",
				roles: [confirmed("s1", "Timer"), claimed("s2", "Ah-Counter")],
			}),
		);
		fireEvent.click(button);
		await waitFor(() => expect(confirmSlot).toHaveBeenCalledTimes(1));
		expect(confirmSlot).toHaveBeenCalledWith({
			data: { slotId: "s1", memberId: MEMBER },
		});
		await waitFor(() => expect(confirmBtn("Confirm Timer")).toBeNull());
		expect(screen.getByText("Confirmed")).toBeTruthy();
		expect(confirmBtn("Confirm Ah-Counter")).toBeTruthy();
		expect(invalidate).toHaveBeenCalled();
	});

	// protects=a confirm shows a success toast; fails_when=the success toast is
	// dropped; no_claim=its wording.
	it("a confirm toasts success", async () => {
		vi.mocked(confirmSlot).mockResolvedValue({} as never);
		await renderCard(
			makeView({ planStatus: "coming", roles: [claimed("s1", "Timer")] }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Confirm Timer" }),
		);
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
	});

	// protects=two taps landing before React re-renders send one request (the
	// ref guard; `disabled` cannot help, the DOM is not yet disabled);
	// fails_when=the in-flight ref guard is removed; no_claim=`disabled`, pinned
	// by the next test.
	it("two taps in one tick send one confirmSlot", async () => {
		const release = heldConfirm();
		await renderCard(
			makeView({ planStatus: "coming", roles: [claimed("s1", "Timer")] }),
		);
		const btn = await screen.findByRole("button", { name: "Confirm Timer" });
		await act(async () => {
			fireEvent.click(btn);
			fireEvent.click(btn);
		});
		release();
		await waitFor(() => expect(confirmSlot).toHaveBeenCalledTimes(1));
	});

	// protects=every Confirm button is disabled while one is in flight, and
	// enabled again once it settles even though the refetch has not; fails_when=
	// `disabled` is dropped or is held until the refetch settles; no_claim=the
	// ref guard, pinned by the previous test.
	it("disables every Confirm while one is in flight, then re-enables on settle", async () => {
		const release = heldConfirm();
		await renderCard(
			makeView({
				planStatus: "coming",
				roles: [claimed("s1", "Timer"), claimed("s2", "Ah-Counter")],
			}),
		);
		const timer = await screen.findByRole("button", {
			name: "Confirm Timer",
		});
		const counter = screen.getByRole("button", { name: "Confirm Ah-Counter" });
		// The refetch after the confirm never settles.
		mockView.mockReturnValue(new Promise(() => {}) as never);
		fireEvent.click(timer);
		await waitFor(() =>
			expect((timer as HTMLButtonElement).disabled).toBe(true),
		);
		expect((counter as HTMLButtonElement).disabled).toBe(true);
		release();
		await waitFor(() =>
			expect((counter as HTMLButtonElement).disabled).toBe(false),
		);
		expect((timer as HTMLButtonElement).disabled).toBe(false);
	});

	// protects=a stale-slot error shows the write error and refetches so the
	// button goes; fails_when=the catch swallows the error or the refetch is
	// dropped; no_claim=which message the server sends.
	it("a stale-slot error shows the error and refetches the view", async () => {
		vi.mocked(confirmSlot).mockRejectedValue(new Error("Role not claimed."));
		await renderCard(
			makeView({ planStatus: "coming", roles: [claimed("s1", "Timer")] }),
		);
		const button = await screen.findByRole("button", {
			name: "Confirm Timer",
		});
		// Nothing else fetches from here on, so any new call is the deliberate one.
		const before = mockView.mock.calls.length;
		mockView.mockResolvedValue(makeView({ planStatus: "coming", roles: [] }));
		fireEvent.click(button);
		await waitFor(() => expect(showWriteError).toHaveBeenCalled());
		await waitFor(() =>
			expect(mockView.mock.calls.length).toBeGreaterThan(before),
		);
		await waitFor(() => expect(confirmBtn("Confirm Timer")).toBeNull());
	});

	// protects=Confirm is offered to anyone who has not declined, including a
	// member who never answered (the server's holder arm turns a blank answer
	// into Coming, ADR-0026), and never over a decline; fails_when=the gate
	// reverts to requiring Coming or ignores not_coming; no_claim=the RSVP page,
	// which has its own gate.
	it.each([
		["coming", "coming", true],
		["unanswered", null, true],
		["not_coming", "not_coming", false],
	] as const)("Confirm for an answer of %s: shown=%s", async (_label, planStatus, shown) => {
		await renderCard(makeView({ planStatus, roles: [claimed("s1", "Timer")] }));
		expect(await screen.findByText("Not confirmed yet")).toBeTruthy();
		expect(confirmBtn("Confirm Timer") !== null).toBe(shown);
	});

	// protects=no Confirm once the meeting stopped taking answers; fails_when=
	// the meeting-over arm of the gate is dropped; no_claim=the cancelled card,
	// which renders nothing at all.
	it.each([
		["completed", { status: "completed" as const }, 7 * 86400000],
		["past", {}, -3 * 86400000],
	])("no Confirm on a %s meeting", async (_l, meeting, offset) => {
		await renderCard(
			makeView(
				{ planStatus: "coming", roles: [claimed("s1", "Timer")] },
				{ ...meeting, scheduledAt: new Date(Date.now() + offset) },
			),
		);
		expect(await screen.findByText("Not confirmed yet")).toBeTruthy();
		expect(confirmBtn("Confirm Timer")).toBeNull();
	});
});
