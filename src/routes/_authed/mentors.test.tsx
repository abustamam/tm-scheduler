// @vitest-environment jsdom
/**
 * Find a mentor (#945), driven as a member sees it: the list, the empty state,
 * the refusal a read-only impersonator gets, and the checklist link that leads
 * here. Who may call `listMentors` and what it returns is
 * `list-mentors.integration.test.ts`; this file stubs the server fn and the
 * loader data.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrientationChecklist } from "#/components/members/orientation-checklist";
import { MENTORS_MEMBERS_ONLY_MESSAGE } from "#/lib/mentorship";
import { type OrientationFacts, orientationView } from "#/lib/orientation";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { listMentors } = vi.hoisted(() => ({ listMentors: vi.fn() }));
// The route imports the server-fn module, which reaches `#/db` -> `pg` on
// import and must not load under jsdom.
vi.mock("#/server/mentorship", () => ({ listMentors }));

import { Route } from "./mentors";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

type Loaded = {
	mentors: {
		memberId: string;
		name: string;
		mentorBio: string | null;
		activeMenteeCount: number;
	}[];
	refused: string | null;
};

async function renderPage(data: Loaded) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue(
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		data as any,
	);
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
		listMentors.mockRejectedValueOnce(new Error(MENTORS_MEMBERS_ONLY_MESSAGE));
		const refused = await loader({ context: { activeClubId: "club-1" } });
		expect(refused).toEqual({
			mentors: [],
			refused: "Find a mentor is for club members.",
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
