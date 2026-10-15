// @vitest-environment jsdom
/**
 * Find a mentor (#945), driven as a member sees it: the list, the empty state,
 * the refusal a read-only impersonator gets, and the checklist link that leads
 * here. Who may call `listMentors` and what it returns is
 * `list-mentors.integration.test.ts`; this file stubs the server fn and the
 * loader data.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrientationChecklist } from "#/components/members/orientation-checklist";
import { MENTORS_MEMBERS_ONLY_MESSAGE } from "#/lib/mentorship";
import { type OrientationFacts, orientationView } from "#/lib/orientation";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const {
	listMentors,
	getMyMentorships,
	getMyMentorRequests,
	requestMentor,
	withdrawMentorRequest,
	loadClubTimezoneSettings,
} = vi.hoisted(() => ({
	loadClubTimezoneSettings: vi.fn(),
	listMentors: vi.fn(),
	getMyMentorships: vi.fn(),
	getMyMentorRequests: vi.fn(),
	requestMentor: vi.fn(),
	withdrawMentorRequest: vi.fn(),
}));
// The route imports the server-fn module, which reaches `#/db` -> `pg` on
// import and must not load under jsdom.
vi.mock("#/server/mentorship", () => ({
	listMentors,
	getMyMentorships,
	getMyMentorRequests,
	requestMentor,
	withdrawMentorRequest,
}));

// The loader reads the club's zone through this, which reaches `#/db`.
vi.mock("#/server/clubs", () => ({ loadClubTimezoneSettings }));

import { Route } from "./mentors";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

type Loaded = {
	clubId?: string;
	timezone?: string;
	mentors: {
		memberId: string;
		name: string;
		mentorBio: string | null;
		activeMenteeCount: number;
	}[];
	refused: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: loader payload stand-ins
	pairings?: any[];
	// biome-ignore lint/suspicious/noExplicitAny: loader payload stand-ins
	request?: any;
};

async function renderPage(data: Loaded) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		clubId: "club-1",
		timezone: "UTC",
		pairings: [],
		request: null,
		...data,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	await renderUnderMemoryRouter(
		(Route.options.component as () => React.ReactElement)(),
	);
}

describe("/mentors (#945)", () => {
	// protects=each willing mentor is one card with their name, their bio (or
	// "No bio yet") and how many people they mentor now, in that order, with the singular and
	// plural right and a mentor with none reading "Not mentoring anyone yet";
	// no email or phone appears;
	// fails_when=a card drops its bio or count, "1 people" reads wrong, or a
	// missing bio renders blank or the string "null";
	// no_claim=that the list is the right people (the integration test)
	it("shows each mentor's name, bio and how many they mentor now", async () => {
		await renderPage({
			refused: null,
			mentors: [
				{
					memberId: "m1",
					name: "Abe Archer",
					mentorBio: "Pathways and evaluations.",
					activeMenteeCount: 1,
				},
				{
					memberId: "m2",
					name: "Bea Bell",
					mentorBio: null,
					activeMenteeCount: 3,
				},
				{
					memberId: "m3",
					name: "Cy Cole",
					mentorBio: "Contests.",
					activeMenteeCount: 0,
				},
			],
		});
		expect(
			screen.getByRole("heading", { level: 1, name: "Find a mentor" }),
		).toBeTruthy();
		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(3);
		const [abe, bea, cy] = cards as HTMLElement[];
		expect(
			within(abe).getByRole("heading", { name: "Abe Archer" }),
		).toBeTruthy();
		expect(within(abe).getByText("Pathways and evaluations.")).toBeTruthy();
		expect(within(abe).getByText("Mentoring 1 person now")).toBeTruthy();
		expect(within(bea).getByText("No bio yet")).toBeTruthy();
		expect(within(bea).getByText("Mentoring 3 people now")).toBeTruthy();
		expect(within(cy).getByText("Not mentoring anyone yet")).toBeTruthy();
		// Order inside a card: name, then the bio (or "No bio yet"), then the
		// "Mentoring ..." line.
		for (const [card, name, bio, count] of [
			[abe, "Abe Archer", "Pathways and evaluations.", "Mentoring 1 person"],
			[bea, "Bea Bell", "No bio yet", "Mentoring 3 people"],
		] as const) {
			const text = card?.textContent ?? "";
			expect(text.indexOf(name), name).toBe(0);
			expect(text.indexOf(bio), bio).toBeGreaterThan(text.indexOf(name));
			expect(text.indexOf(count), count).toBeGreaterThan(text.indexOf(bio));
		}
		expect(document.body.textContent).not.toMatch(/@|null/);
	});

	// protects=a club with no willing mentor sees the empty state and no list;
	// fails_when=an empty list renders a bare heading, or the message loses its
	// pointer to the VP Education;
	// no_claim=that anything offers to change that from this page
	it("says so when nobody has offered to mentor", async () => {
		await renderPage({ refused: null, mentors: [] });
		expect(
			screen.getByText(
				"Nobody in your club has offered to mentor yet. Ask your VP Education.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("listitem")).toBeNull();
	});

	// protects=the one refusal the page explains: a caller with no membership
	// of their own (a read-only impersonation) reads the server's message in an
	// alert, with no list; any OTHER failure is not swallowed by the loader;
	// fails_when=the loader hides every error as an empty club, or lets the
	// members-only refusal fall through to the generic error page (which never
	// shows a message);
	// no_claim=that the server refuses (the integration test); the redirect for
	// a signed-out visitor, which is `_authed`'s own
	it("explains the members-only refusal and rethrows anything else", async () => {
		const loader = Route.options.loader as (a: {
			context: { activeClubId: string | null };
		}) => Promise<Loaded>;
		getMyMentorships.mockResolvedValue(null);
		getMyMentorRequests.mockResolvedValue(null);
		listMentors.mockRejectedValueOnce(new Error(MENTORS_MEMBERS_ONLY_MESSAGE));
		const refused = await loader({ context: { activeClubId: "club-1" } });
		expect(refused).toEqual({
			clubId: "club-1",
			timezone: "UTC",
			mentors: [],
			refused: "Find a mentor is for club members.",
			pairings: [],
			request: null,
		});
		expect(listMentors).toHaveBeenCalledWith({ data: { clubId: "club-1" } });
		await renderPage(refused);
		expect(screen.getByRole("alert").textContent).toBe(
			"Find a mentor is for club members.",
		);
		expect(screen.queryByRole("listitem")).toBeNull();

		listMentors.mockRejectedValueOnce(new Error("connection reset"));
		await expect(
			loader({ context: { activeClubId: "club-1" } }),
		).rejects.toThrow("connection reset");

		// No active club: sent to the dashboard, the server fn never asked.
		listMentors.mockClear();
		await expect(
			loader({ context: { activeClubId: null } }),
		).rejects.toMatchObject({ options: { to: "/dashboard" } });
		expect(listMentors).not.toHaveBeenCalled();
	});
});

const facts = (over: Partial<OrientationFacts> = {}): OrientationFacts => ({
	startedAt: new Date("2026-09-01T00:00:00Z"),
	dismissedAt: null,
	basecampSetupAt: null,
	activePathCount: 0,
	slots: [],
	menteePairings: [],
	...over,
});

describe("the orientation checklist's Get a mentor item (#945)", () => {
	// protects=the undone "Get a mentor" item sends the member to /mentors
	// under the label "Find a mentor", with the new hint; once a mentor is
	// found the link is gone (a done item has no action);
	// fails_when=the item has no link, links elsewhere, or keeps the old hint
	// that said only the VP Education pairs;
	// no_claim=the rest of the checklist (`orientation-checklist.test.tsx`)
	it("links to /mentors and says the member may choose", async () => {
		const view = orientationView(facts());
		await renderUnderMemoryRouter(
			<OrientationChecklist
				view={view}
				onToggleBaseCamp={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		);
		const li = document.querySelector('li[data-item="get-a-mentor"]');
		expect(li?.getAttribute("data-done")).toBe("false");
		const link = within(li as HTMLElement).getByRole("link", {
			name: "Find a mentor",
		});
		expect(link.getAttribute("href")).toBe("/mentors");
		expect(li?.textContent).toContain(
			"Choose a mentor, or your VP Education will pair you.",
		);
		expect(li?.textContent).not.toContain("pairs you with");
	});
});

const mentorMia = {
	memberId: "mia",
	name: "Mia Mentor",
	mentorBio: "Contests.",
	activeMenteeCount: 0,
};
const mentorBo = {
	memberId: "bo",
	name: "Bo Bell",
	mentorBio: null,
	activeMenteeCount: 2,
};
const party = (id: string, name: string) => ({
	id,
	name,
	email: "mia@example.org",
	phone: "+15555550111",
	preferredContact: null,
});
const outgoing = (
	status: "pending" | "declined" | "accepted" | "withdrawn",
	over: object = {},
) => ({
	id: "req-1",
	status,
	focus: "contest",
	focusOther: null,
	createdAt: new Date("2026-10-10T12:00:00Z"),
	mentor: party("mia", "Mia Mentor"),
	...over,
});
const cardOf = (id: string) =>
	document.querySelector(`li[data-mentor="${id}"]`) as HTMLElement;

describe("asking a mentor (#1209)", () => {
	// protects=the loader hands the page the member's own pairings and latest
	// request alongside the list, and a failure of EITHER side read leaves the
	// list standing (the buttons stay on and the server refuses what it must);
	// fails_when=a failed side read blanks the page or the payload drops them;
	// no_claim=what the server returns (integration tests)
	it("loads the list with the member's pairings and request", async () => {
		const loader = Route.options.loader as (a: {
			context: { activeClubId: string | null };
		}) => Promise<Loaded>;
		listMentors.mockResolvedValue([mentorMia]);
		loadClubTimezoneSettings.mockResolvedValue({
			timezone: "America/Los_Angeles",
		});
		getMyMentorships.mockResolvedValue({ mentors: [{ id: "p1" }] });
		getMyMentorRequests.mockResolvedValue({
			outgoing: outgoing("pending"),
			incoming: [],
		});
		const ok = await loader({ context: { activeClubId: "club-1" } });
		expect(ok.pairings).toEqual([{ id: "p1" }]);
		expect(ok.request?.id).toBe("req-1");
		expect(ok.timezone).toBe("America/Los_Angeles");
		expect(loadClubTimezoneSettings).toHaveBeenCalledWith({ data: "club-1" });
		loadClubTimezoneSettings.mockRejectedValue(new Error("boom"));
		getMyMentorships.mockRejectedValue(new Error("boom"));
		getMyMentorRequests.mockRejectedValue(new Error("boom"));
		const degraded = await loader({ context: { activeClubId: "club-1" } });
		expect(degraded.mentors).toEqual([mentorMia]);
		expect(degraded.pairings).toEqual([]);
		expect(degraded.request).toBeNull();
		expect(degraded.timezone).toBe("UTC");
	});

	// protects=every card offers "Ask to mentor me"; the dialog defaults the
	// focus to New member, shows the 80-character text field only for Other, and
	// Send calls requestMentor with the club, the mentor, the focus (and the
	// trimmed text for Other); once sent it reads "Request sent to {name}. Let
	// them know:" with the draft addressed to that mentor;
	// fails_when=the default is another focus, the text field shows for a
	// non-other focus, the call names the wrong mentor or drops the text, or the
	// draft is missing after a send;
	// no_claim=that the server accepted it (stubbed), the draft's wording
	// (nudge.test.ts); the loader data after the send is a stub
	it("asks with a focus and then offers the mentor a draft", async () => {
		const user = userEvent.setup();
		requestMentor.mockResolvedValue({
			requestId: "req-1",
			mentor: party("mia", "Mia Mentor"),
		});
		await renderPage({ refused: null, mentors: [mentorMia, mentorBo] });
		const ask = within(cardOf("mia")).getByRole("button", {
			name: "Ask to mentor me",
		});
		await user.click(ask);
		const dialog = await screen.findByRole("dialog");
		const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
		expect(select.value).toBe("new_member");
		expect(within(dialog).queryByLabelText("Describe the focus")).toBeNull();
		await user.selectOptions(select, "other");
		await user.type(
			within(dialog).getByLabelText("Describe the focus"),
			"  Humor ",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Send request" }),
		);
		expect(requestMentor).toHaveBeenCalledWith({
			data: {
				clubId: "club-1",
				mentorMemberId: "mia",
				focus: "other",
				focusOther: "Humor",
			},
		});
		// The draft rides on what requestMentor returned: no second read.
		expect(getMyMentorRequests).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByText(/Request sent to Mia Mentor/)).toBeTruthy(),
		);
		// The draft is addressed to Mia's contact and names the focus.
		await waitFor(() => {
			const hrefs = [...dialog.querySelectorAll("a")].map(
				(a) => a.getAttribute("href") ?? "",
			);
			expect(hrefs.some((h) => h.startsWith("mailto:mia@example.org"))).toBe(
				true,
			);
			expect(hrefs.some((h) => decodeURIComponent(h).includes("(Humor)"))).toBe(
				true,
			);
		});
	});

	// protects=a mentor with neither phone nor email gets a fallback line after
	// the send, not a "Let them know:" prompt with nothing under it;
	// fails_when=the dialog says "Let them know:" with no buttons, or says
	// nothing about how to reach them;
	// no_claim=the loader refresh after the send (stubbed)
	it("says so when the mentor has no contact to send the draft to", async () => {
		const user = userEvent.setup();
		requestMentor.mockResolvedValue({
			requestId: "req-1",
			mentor: { ...party("mia", "Mia Mentor"), email: null, phone: null },
		});
		await renderPage({ refused: null, mentors: [mentorMia] });
		await user.click(screen.getByRole("button", { name: "Ask to mentor me" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Send request" }),
		);
		await within(dialog).findByText(/Request sent to Mia Mentor\./);
		expect(dialog.textContent).not.toContain("Let them know");
		expect(
			dialog.querySelector('[data-slot="no-mentor-contact"]')?.textContent,
		).toContain("no contact details");
		expect(dialog.querySelectorAll("a")).toHaveLength(0);
	});

	// protects=the pending banner dates the request in the CLUB's zone, not UTC;
	// fails_when=a request made at 02:00 UTC on Oct 10 reads "Oct 10" for a club
	// in Los Angeles, where it is still Oct 9;
	// no_claim=the loader reading the zone (the loader test)
	it("dates the pending banner in the club's timezone", async () => {
		await renderPage({
			refused: null,
			mentors: [mentorMia],
			timezone: "America/Los_Angeles",
			request: outgoing("pending", {
				createdAt: new Date("2026-10-10T02:00:00Z"),
			}),
		});
		expect(screen.getByText(/You asked Mia Mentor on Oct 9\./)).toBeTruthy();
	});

	// protects=a refused request (already waiting, not available) shows the
	// server's message inside the dialog and keeps the form, with no "Request
	// sent";
	// fails_when=the error is swallowed, or the dialog claims success;
	// no_claim=the wording of the refusals (integration test)
	it("shows a refusal in the dialog and does not claim success", async () => {
		const user = userEvent.setup();
		requestMentor.mockRejectedValue(
			new Error(
				"You already have a request waiting. Withdraw it to ask someone else.",
			),
		);
		await renderPage({ refused: null, mentors: [mentorMia] });
		await user.click(screen.getByRole("button", { name: "Ask to mentor me" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Send request" }),
		);
		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"You already have a request waiting. Withdraw it to ask someone else.",
		);
		expect(screen.queryByText(/Request sent/)).toBeNull();
	});

	// protects=while a request is pending a banner reads "You asked {name} on
	// {date}." with Withdraw, which calls withdrawMentorRequest with the request
	// id, and EVERY Ask button is disabled;
	// fails_when=an Ask button stays live (a second request would be refused
	// only by the server), the banner drops the name or date, or Withdraw names
	// the wrong id;
	// no_claim=that the page refreshes afterwards (router.invalidate, not
	// observable under this stub)
	it("shows a pending banner with Withdraw and disables every Ask", async () => {
		const user = userEvent.setup();
		withdrawMentorRequest.mockResolvedValue({ ok: true });
		await renderPage({
			refused: null,
			mentors: [mentorMia, mentorBo],
			request: outgoing("pending"),
		});
		expect(screen.getByText(/You asked Mia Mentor on Oct 10\./)).toBeTruthy();
		const asks = screen.getAllByRole("button", { name: "Ask to mentor me" });
		expect(asks).toHaveLength(2);
		for (const b of asks) expect((b as HTMLButtonElement).disabled).toBe(true);
		await user.click(screen.getByRole("button", { name: "Withdraw" }));
		expect(withdrawMentorRequest).toHaveBeenCalledWith({
			data: { requestId: "req-1" },
		});
	});

	// protects=after a decline the page says "{name} can't take you on right
	// now. You can ask someone else." with no reason, and the Ask buttons are
	// on; an accepted or withdrawn latest request says nothing;
	// fails_when=the decline message is missing or carries a reason, the buttons
	// stay off after a decline, or an accepted request shows a banner;
	// no_claim=that declined is the latest (the integration test)
	it("tells a declined mentee they can ask someone else", async () => {
		await renderPage({
			refused: null,
			mentors: [mentorMia],
			request: outgoing("declined"),
		});
		expect(
			screen.getByText(
				"Mia Mentor can't take you on right now. You can ask someone else.",
			),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "Ask to mentor me",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		cleanup();
		for (const status of ["accepted", "withdrawn"] as const) {
			await renderPage({
				refused: null,
				mentors: [mentorMia],
				request: outgoing(status),
			});
			expect(document.querySelector("[data-slot^='request-']")).toBeNull();
			cleanup();
		}
	});

	// protects=a mentor the member already has an active pairing with wears a
	// "Your mentor" badge, their Ask button stays available, and the focuses
	// already paired are disabled in the select (the default moves off New
	// member); another mentor has no badge;
	// fails_when=the badge is on the wrong card, a paired focus can be chosen
	// (the server would refuse it), or the Ask button is disabled;
	// no_claim=that the pairing is active (the loader's read)
	it("badges the member's own mentor and disables the focuses already paired", async () => {
		const user = userEvent.setup();
		await renderPage({
			refused: null,
			mentors: [mentorMia, mentorBo],
			pairings: [
				{ id: "p1", focus: "new_member", member: { id: "mia", name: "Mia" } },
			],
		});
		expect(within(cardOf("mia")).getByText("Your mentor")).toBeTruthy();
		expect(within(cardOf("bo")).queryByText("Your mentor")).toBeNull();
		const ask = within(cardOf("mia")).getByRole("button", {
			name: "Ask to mentor me",
		}) as HTMLButtonElement;
		expect(ask.disabled).toBe(false);
		await user.click(ask);
		const dialog = await screen.findByRole("dialog");
		const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
		const newMember = [...select.options].find((o) => o.value === "new_member");
		const contest = [...select.options].find((o) => o.value === "contest");
		expect(newMember?.disabled).toBe(true);
		expect(contest?.disabled).toBe(false);
		expect(select.value).toBe("contest");
	});
});

describe("the orientation checklist while a request is pending (#1209)", () => {
	// protects=with a pending request the "Get a mentor" item reads "Waiting for
	// {mentor} to answer." and is still NOT done; without one it keeps the
	// default hint;
	// fails_when=the hint ignores the request, or the item ticks before a pairing
	// exists;
	// no_claim=that the server supplies the name (the integration test)
	it("shows who the member is waiting on", async () => {
		const view = orientationView(facts({ pendingMentorName: "Mia Mentor" }));
		await renderUnderMemoryRouter(
			<OrientationChecklist
				view={view}
				onToggleBaseCamp={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		);
		const li = document.querySelector('li[data-item="get-a-mentor"]');
		expect(li?.getAttribute("data-done")).toBe("false");
		expect(li?.textContent).toContain("Waiting for Mia Mentor to answer.");
		expect(li?.textContent).not.toContain("Choose a mentor");
	});
});
