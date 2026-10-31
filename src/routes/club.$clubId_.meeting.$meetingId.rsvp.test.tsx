// @vitest-environment jsdom
//
// The one-tap RSVP page (#1442): what a tap may write, signed in and out.
// Server fns are mocked at the module edge (they reach `#/db`); the server's own
// rules (ADR-0026's fill-blank refusal, the release's session gate) are covered
// by `attendance-decline.integration.test.ts`, so what is pinned HERE is what the
// page sends and, as important, what it refuses to send.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isNotFound,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/attendance-plan", () => ({ setPlannedAttendance: vi.fn() }));
vi.mock("#/server/guest-rsvp", () => ({ submitGuestRsvp: vi.fn() }));
vi.mock("#/server/personal-meeting", () => ({
	getPublicPersonalMeetingView: vi.fn(),
}));
vi.mock("#/lib/auth-client", () => ({
	authClient: { useSession: vi.fn() },
}));
vi.mock("#/server/ballot-session-voter", () => ({
	getBallotSessionVoter: vi.fn(),
}));
vi.mock("#/components/club/pick-name-form", () => ({
	PickNameForm: () => <div>pick-name-form</div>,
}));
vi.mock("#/components/club/cover-sheet", () => ({
	CoverSheet: (p: { slots: { roleLabel: string }[]; mode?: string }) => (
		<div data-testid="cover-sheet" data-mode={p.mode}>
			{p.slots.map((s) => s.roleLabel).join(",")}
		</div>
	),
}));

import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { memberKey } from "#/lib/member-identity";
import { Route } from "#/routes/club.$clubId_.meeting.$meetingId.rsvp";
import { setPlannedAttendance } from "#/server/attendance-plan";
import { getBallotSessionVoter } from "#/server/ballot-session-voter";
import { submitGuestRsvp } from "#/server/guest-rsvp";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getPublicPersonalMeetingView } from "#/server/personal-meeting";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const SOON = new Date(Date.now() + 3 * 86_400_000).toISOString();

// biome-ignore lint/suspicious/noExplicitAny: route loaders take a router ctx
function runLoader(ctx: unknown): Promise<any> {
	// biome-ignore lint/suspicious/noExplicitAny: loader union has no call sig
	return (Route.options as any).loader(ctx);
}

function mockClub() {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		name: "Downtown Toastmasters",
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
	} as any);
}

describe("rsvp route loader", () => {
	afterEach(() => vi.clearAllMocks());

	it("404s on an unknown meeting key", async () => {
		mockClub();
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(
			new Error("Meeting not found."),
		);
		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location: { href: "/" },
			}),
		).rejects.toSatisfy(isNotFound);
	});

	it("404s when the meeting belongs to another club", async () => {
		mockClub();
		vi.mocked(getPublicMeetingByKey).mockResolvedValue({
			meeting: { id: MEETING_ID, clubId: "other" },
			// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough
		} as any);
		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location: { href: "/" },
			}),
		).rejects.toSatisfy(isNotFound);
	});
});

function view(
	over: {
		planStatus?: "coming" | "not_coming" | null;
		roles?: { slotId: string; roleName: string }[];
	} = {},
) {
	return {
		club: { id: CLUB_ID, name: "Downtown Toastmasters", timezone: "UTC" },
		meeting: {
			id: MEETING_ID,
			scheduledAt: SOON,
			status: "scheduled",
			theme: null,
		},
		member: { id: MEMBER_ID, name: "Ada Lovelace" },
		roles: over.roles ?? [],
		planStatus: over.planStatus ?? null,
		// biome-ignore lint/suspicious/noExplicitAny: partial view is enough
	} as any;
}

async function renderPage() {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		clubId: CLUB_ID,
		clubName: "Downtown Toastmasters",
		timezone: "UTC",
		meeting: {
			id: MEETING_ID,
			status: "scheduled",
			scheduledAt: SOON,
			lengthMinutes: 90,
			theme: null,
		},
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useParams").mockReturnValue({
		clubId: "downtown",
		meetingId: "2026-01-01",
	} as never);
	const Component = Route.options.component as () => React.ReactElement;
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<Component />
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

function signedOutAs(picked: boolean) {
	vi.mocked(authClient.useSession).mockReturnValue({
		data: null,
		isPending: false,
		// biome-ignore lint/suspicious/noExplicitAny: partial hook return
	} as any);
	localStorage.clear();
	if (picked) {
		localStorage.setItem(
			memberKey("downtown"),
			JSON.stringify({ id: MEMBER_ID, name: "Ada Lovelace" }),
		);
	}
}

function signedIn() {
	vi.mocked(authClient.useSession).mockReturnValue({
		data: { user: { id: "user-1" } },
		isPending: false,
		// biome-ignore lint/suspicious/noExplicitAny: partial hook return
	} as any);
	vi.mocked(getBallotSessionVoter).mockResolvedValue({
		id: MEMBER_ID,
		name: "Ada Lovelace",
		// biome-ignore lint/suspicious/noExplicitAny: partial voter is enough
	} as any);
	localStorage.clear();
}

describe("rsvp page", () => {
	beforeEach(() => {
		vi.mocked(setPlannedAttendance).mockResolvedValue({
			released: 0,
			changed: true,
			confirmedRoles: [],
			// biome-ignore lint/suspicious/noExplicitAny: partial write result
		} as any);
	});
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("signed out, nobody picked: asks who you are and offers no answer yet", async () => {
		signedOutAs(false);
		await renderPage();
		expect(await screen.findByText("Who are you?")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /coming/i })).toBeNull();
	});

	it("signed out, a pick and I'm coming: writes `coming` for that member, asserted", async () => {
		signedOutAs(true);
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(view());
		await renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "I'm coming" }));
		await waitFor(() => expect(setPlannedAttendance).toHaveBeenCalledTimes(1));
		const { data } = vi.mocked(setPlannedAttendance).mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(data).toMatchObject({
			memberId: MEMBER_ID,
			meetingId: MEETING_ID,
			status: "coming",
		});
		expect(data.releaseHeldRoles).toBeUndefined();
	});

	it("signed out and already answered: says so, offers sign-in, no buttons, no write", async () => {
		signedOutAs(true);
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(
			view({ planStatus: "coming" }),
		);
		await renderPage();
		expect(await screen.findByText("You said Coming.")).toBeTruthy();
		expect(screen.getByText("Sign in to change it")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Can't make it" })).toBeNull();
		expect(setPlannedAttendance).not.toHaveBeenCalled();
	});

	it("signed out, holding a role, Can't make it: writes NOTHING and offers the hand-off sign-in", async () => {
		signedOutAs(true);
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(
			view({ roles: [{ slotId: "s1", roleName: "Toastmaster" }] }),
		);
		await renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Can't make it" }),
		);
		const link = await screen.findByText("Sign in to hand off Toastmaster");
		expect(link.closest("a")?.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-01-01",
		);
		expect(setPlannedAttendance).not.toHaveBeenCalled();
	});

	it("signed out with no role, Can't make it: records the answer without a release", async () => {
		signedOutAs(true);
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(view());
		await renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Can't make it" }),
		);
		await waitFor(() => expect(setPlannedAttendance).toHaveBeenCalledTimes(1));
		const { data } = vi.mocked(setPlannedAttendance).mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(data.status).toBe("not_coming");
		expect(data.releaseHeldRoles).toBeUndefined();
	});

	it("signed in, holding two roles, Can't make it: releases and offers cover for both", async () => {
		signedIn();
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(
			view({
				planStatus: "coming",
				roles: [
					{ slotId: "s1", roleName: "Toastmaster" },
					{ slotId: "s2", roleName: "Timer" },
				],
			}),
		);
		vi.mocked(setPlannedAttendance).mockResolvedValue({
			released: 2,
			changed: true,
			confirmedRoles: [],
			// biome-ignore lint/suspicious/noExplicitAny: partial write result
		} as any);
		await renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Can't make it" }),
		);
		await waitFor(() => expect(setPlannedAttendance).toHaveBeenCalledTimes(1));
		const { data } = vi.mocked(setPlannedAttendance).mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(data).toMatchObject({
			status: "not_coming",
			releaseHeldRoles: true,
		});
		const sheet = await screen.findByTestId("cover-sheet");
		await waitFor(() => expect(sheet.textContent).toBe("Toastmaster,Timer"));
		expect(sheet.getAttribute("data-mode")).toBe("released");
	});
	it("a late session success does not replace a name picked after the timeout", async () => {
		vi.mocked(authClient.useSession).mockReturnValue({
			data: { user: { id: "user-1" } },
			isPending: false,
			// biome-ignore lint/suspicious/noExplicitAny: partial hook return
		} as any);
		let answer: (v: unknown) => void = () => {};
		vi.mocked(getBallotSessionVoter).mockReturnValue(
			new Promise((r) => {
				answer = r;
			}) as never,
		);
		localStorage.clear();
		localStorage.setItem(
			memberKey("downtown"),
			JSON.stringify({ id: MEMBER_ID, name: "Pat Picked" }),
		);
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(
			view({ planStatus: null }),
		);
		await renderPage();
		// The session never answered: the page falls back to the picked name.
		expect(
			await screen.findByRole(
				"button",
				{ name: "I'm coming" },
				{ timeout: 4500 },
			),
		).toBeTruthy();
		expect(screen.getByText("Not Ada Lovelace?")).toBeTruthy();

		answer({
			id: "99999999-9999-4999-8999-999999999999",
			name: "Sally Session",
		});
		await new Promise((r) => setTimeout(r, 50));

		// Signed-out chrome ("Not …?") is still there: the identity was not swapped.
		expect(screen.getByText(/^Not .*\?$/)).toBeTruthy();
		const memberIds = vi
			.mocked(getPublicPersonalMeetingView)
			.mock.calls.map(
				(c) => (c[0] as { data: { memberId: string } }).data.memberId,
			);
		expect(new Set(memberIds)).toEqual(new Set([MEMBER_ID]));
	}, 8000);
	it("a session answer after the timeout still signs in a member who picked nobody (#1457)", async () => {
		vi.mocked(authClient.useSession).mockReturnValue({
			data: { user: { id: "user-1" } },
			isPending: false,
			// biome-ignore lint/suspicious/noExplicitAny: partial hook return
		} as any);
		let answer: (v: unknown) => void = () => {};
		vi.mocked(getBallotSessionVoter).mockReturnValue(
			new Promise((r) => {
				answer = r;
			}) as never,
		);
		localStorage.clear();
		vi.mocked(getPublicPersonalMeetingView).mockResolvedValue(
			view({ planStatus: null }),
		);
		await renderPage();
		// The timeout fired first: the signed-out name pick shows.
		await screen.findByText("pick-name-form", {}, { timeout: 4500 });

		answer({ id: MEMBER_ID, name: "Ada Lovelace" });

		expect(
			await screen.findByRole("button", { name: "I'm coming" }),
		).toBeTruthy();
		expect(screen.queryByText("pick-name-form")).toBeNull();
	}, 8000);
});

describe("guest RSVP (#1444)", () => {
	const CONFIRMATION = {
		rsvpId: "44444444-4444-4444-8444-444444444444",
		clubName: "Downtown Toastmasters",
		scheduledAt: SOON,
		timeZone: "UTC",
		location: "12 Main St",
		joinUrl: null as string | null,
		toastmasterFirstName: null as string | null,
	};

	async function startGuest() {
		signedOutAs(false);
		await renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "I'm a guest" }));
		return screen.findByLabelText("First name");
	}

	async function submitFirstName(name = "Dana") {
		fireEvent.change(await startGuest(), { target: { value: name } });
		fireEvent.click(screen.getByRole("button", { name: "I'm coming" }));
	}

	beforeEach(() => {
		vi.mocked(submitGuestRsvp).mockResolvedValue({
			ok: true,
			confirmation: { ...CONFIRMATION },
			// biome-ignore lint/suspicious/noExplicitAny: confirmation dates
		} as any);
	});
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	/*
	 * protects: AC1, a guest with a first name only is submitted and sees the
	 *   confirmation; no contact is sent, the honeypot is empty, fillMs is a number.
	 * fails_when: the page demands a contact, sends the honeypot filled, or drops
	 *   fillMs (the server reads a missing one as a bot).
	 */
	it("first name only: submits that and shows 'See you <Weekday>, <Name>!'", async () => {
		await submitFirstName("Dana");
		const weekday = new Intl.DateTimeFormat("en-US", {
			weekday: "long",
			timeZone: "UTC",
		}).format(new Date(SOON));
		expect(await screen.findByText(`See you ${weekday}, Dana!`)).toBeTruthy();
		const { data } = vi.mocked(submitGuestRsvp).mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(data).toMatchObject({
			clubId: CLUB_ID,
			meetingId: MEETING_ID,
			firstName: "Dana",
			email: "",
			phone: "",
			website: "",
		});
		expect(typeof data.fillMs).toBe("number");
		expect(data.clientKey).toMatch(/^[0-9a-f-]{36}$/);
	});

	// protects=an email-looking contact goes to `email`, anything else to `phone`.
	// fails_when=both are sent in one field, or a phone is sent as an email.
	it("routes the optional contact to email or phone by its shape", async () => {
		fireEvent.change(await startGuest(), { target: { value: "Dana" } });
		fireEvent.change(screen.getByLabelText(/Email or phone/), {
			target: { value: "dana@example.test" },
		});
		fireEvent.click(screen.getByRole("button", { name: "I'm coming" }));
		await screen.findByText(/^See you/);
		expect(vi.mocked(submitGuestRsvp).mock.calls[0][0]).toMatchObject({
			data: { email: "dana@example.test", phone: "" },
		});
	});

	// protects=a non-empty phone value reaches the `phone` field, trimmed, and
	//   `email` stays blank.
	// fails_when=a phone is dropped, sent in `email`, or sent untrimmed.
	it("sends a phone-shaped contact as phone", async () => {
		fireEvent.change(await startGuest(), { target: { value: "Dana" } });
		fireEvent.change(screen.getByLabelText(/Email or phone/), {
			target: { value: "  555 010 1234 " },
		});
		fireEvent.click(screen.getByRole("button", { name: "I'm coming" }));
		await screen.findByText(/^See you/);
		expect(vi.mocked(submitGuestRsvp).mock.calls[0][0]).toMatchObject({
			data: { email: "", phone: "555 010 1234" },
		});
	});

	// protects=AC2 on the page: a street address gets the map link.
	// fails_when=the address has no link, or the link is not the maps search.
	it("shows the address with a map link", async () => {
		await submitFirstName();
		const link = await screen.findByRole("link", { name: /Open in maps/ });
		expect(link.getAttribute("href")).toBe(
			"https://www.google.com/maps/search/?api=1&query=12%20Main%20St",
		);
	});

	// protects=AC2 on the page: a URL location is text, never a map search.
	it("shows no map link when the location is a URL", async () => {
		vi.mocked(submitGuestRsvp).mockResolvedValue({
			ok: true,
			confirmation: { ...CONFIRMATION, location: "https://zoom.us/j/1" },
			// biome-ignore lint/suspicious/noExplicitAny: confirmation dates
		} as any);
		await submitFirstName();
		await screen.findByText(/^See you/);
		expect(screen.queryByRole("link", { name: /Open in maps/ })).toBeNull();
	});

	// protects=the video link appears exactly when the confirmation carries it
	// (hybrid included), and the Toastmaster line uses the D8 copy, only when filled.
	// fails_when=a link is shown without joinUrl, or the old copy returns.
	it("shows Join the video call and the Toastmaster line only when present", async () => {
		await submitFirstName();
		await screen.findByText(/^See you/);
		expect(screen.queryByText("Join the video call")).toBeNull();
		expect(screen.getByText("The club knows you're coming.")).toBeTruthy();
		cleanup();

		vi.mocked(submitGuestRsvp).mockResolvedValue({
			ok: true,
			confirmation: {
				...CONFIRMATION,
				joinUrl: "https://meet.example/abc",
				toastmasterFirstName: "Lena",
			},
			// biome-ignore lint/suspicious/noExplicitAny: confirmation dates
		} as any);
		await submitFirstName();
		const join = await screen.findByText("Join the video call");
		expect(join.closest("a")?.getAttribute("href")).toBe(
			"https://meet.example/abc",
		);
		expect(
			screen.getByText(
				"Lena is Toastmaster tonight. The club knows you're coming.",
			),
		).toBeTruthy();
	});

	// protects=a success-shaped bot answer (nothing written) is never shown as a
	// confirmation. fails_when=the page confirms an RSVP the server did not record.
	it("does not confirm when the server wrote nothing", async () => {
		vi.mocked(submitGuestRsvp).mockResolvedValue({
			ok: true,
			confirmation: null,
		});
		await submitFirstName();
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.queryByText(/^See you/)).toBeNull();
	});

	// protects=a refusal's message reaches the guest. fails_when=it is swallowed.
	it("shows the server's refusal", async () => {
		vi.mocked(submitGuestRsvp).mockRejectedValue(
			new Error("This meeting isn't taking RSVPs."),
		);
		await submitFirstName();
		expect(
			await screen.findByText("This meeting isn't taking RSVPs."),
		).toBeTruthy();
	});

	// protects=a first name is required before anything is sent.
	it("sends nothing without a first name", async () => {
		await startGuest();
		fireEvent.click(screen.getByRole("button", { name: "I'm coming" }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(submitGuestRsvp).not.toHaveBeenCalled();
	});
});
