// @vitest-environment jsdom
// #1335. Each test's card: protects=...; fails_when=...; no_claim=...
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/auth-client", () => ({
	authClient: { useSession: vi.fn() },
}));
vi.mock("#/server/ballot-session-voter", () => ({
	getBallotSessionVoter: vi.fn(),
}));

import { authClient } from "#/lib/auth-client";
import { getBallotSessionVoter } from "#/server/ballot-session-voter";
import {
	MeetingRunOfShow,
	type MeetingRunOfShowProps,
	type RunOfShowSlot,
} from "./meeting-run-of-show";

const MEETING_ID = "22222222-2222-4222-8222-222222222222";

function slot(over: Partial<RunOfShowSlot>): RunOfShowSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		assigneeId: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

const SLOTS = (): RunOfShowSlot[] => [
	slot({
		id: "tm",
		roleKey: "toastmaster_of_the_day",
		roleName: "Toastmaster of the Day",
		category: "leadership",
		assigneeName: "Faisal",
		assigneeId: "m-faisal",
	}),
	slot({
		id: "sp",
		roleKey: "speaker",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "Jagpal",
		assigneeId: "m-jagpal",
		speechTitle: "Icebreaker Jitters",
		projectLevel: "Level 1 Ice Breaker",
		minMinutes: 5,
		maxMinutes: 7,
	}),
	slot({
		id: "ev",
		roleKey: "evaluator",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Sudheer",
		assigneeId: "m-sudheer",
		evaluatesSlotId: "sp",
	}),
	slot({
		id: "ge",
		roleKey: "general_evaluator",
		roleName: "General Evaluator",
		category: "leadership",
		assigneeName: null,
	}),
];

function props(over: Partial<MeetingRunOfShowProps> = {}) {
	return {
		clubParam: "downtown",
		meetingParam: "2026-07-31",
		meeting: {
			id: MEETING_ID,
			scheduledAt: "2026-07-31T18:45:00Z",
			lengthMinutes: 60,
			location: "Room 4",
			theme: "Beginnings",
			wordOfTheDay: "Ephemeral",
			wodDefinition: "Lasting for a very short time.",
			wodExample: "The applause was ephemeral.",
		},
		slots: SLOTS(),
		timezone: "UTC",
		clubName: "Downtown Toastmasters",
		logoUrl: null,
		cancelled: false,
		roleDescriptions: {},
		geIntroducesFunctionaries: false,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
		template: null,
		...over,
	} satisfies MeetingRunOfShowProps;
}

function session(state: "out" | { userId: string }) {
	vi.mocked(authClient.useSession).mockReturnValue(
		(state === "out"
			? { data: null, isPending: false }
			: {
					data: { user: { id: state.userId } },
					isPending: false,
				}) as never,
	);
}

async function renderPage(p: MeetingRunOfShowProps) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<MeetingRunOfShow {...p} />
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const out = render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	await screen.findByRole("heading", { level: 1 });
	return out;
}

beforeEach(() => {
	session("out");
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const rowOf = (text: string) => screen.getByText(text).closest("li") as Element;

describe("header", () => {
	// protects=every set header field is drawn and the link goes to the meeting page;
	// fails_when=a field is dropped or the link target is wrong;
	// no_claim=says nothing about layout or DESIGN.md fit
	it("shows club, date, range, location, theme and the word with its definition", async () => {
		await renderPage(props());
		expect(screen.getByText("Downtown Toastmasters")).toBeTruthy();
		expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
			"July 31, 2026",
		);
		expect(screen.getByText("Room 4")).toBeTruthy();
		expect(screen.getByText(/Beginnings/)).toBeTruthy();
		expect(screen.getByText(/Ephemeral/)).toBeTruthy();
		expect(screen.getByText("Lasting for a very short time.")).toBeTruthy();
		expect(screen.getByText("The applause was ephemeral.")).toBeTruthy();
		const link = screen.getByRole("link", { name: "Meeting page" });
		expect(link.getAttribute("href")).toBe("/club/downtown/meeting/2026-07-31");
		expect(screen.queryByText(/edit agenda/i)).toBeNull();
	});

	// protects=unset header fields draw nothing, not an empty label;
	// fails_when=a "Theme:" or "Word of the Day:" label renders with no value;
	// no_claim=says nothing about the fields that are set
	it("omits location, theme and word when unset", async () => {
		await renderPage(
			props({
				meeting: {
					...props().meeting,
					location: null,
					theme: null,
					wordOfTheDay: null,
					wodDefinition: null,
					wodExample: null,
				},
			}),
		);
		expect(screen.queryByText(/Theme:/)).toBeNull();
		expect(screen.queryByText(/Word of the Day/)).toBeNull();
		expect(screen.queryByText("Room 4")).toBeNull();
	});
});

describe("rows", () => {
	// protects=a speaker row draws title, project, the timing window and the evaluator;
	// fails_when=any is missing, or the evaluator is attached to the wrong row;
	// no_claim=says nothing about rows without a slot
	it("a speaker row shows title, project, min-max window and who evaluates", async () => {
		await renderPage(props());
		const row = rowOf("Speaker");
		expect(row.textContent).toContain("Jagpal");
		expect(row.textContent).toContain("Icebreaker Jitters");
		expect(row.textContent).toContain("Level 1 Ice Breaker");
		expect(row.textContent).toContain("5–7 min");
		expect(row.textContent).toContain("Evaluated by Sudheer");
	});

	// protects=an unfilled evaluator slot is omitted, not shown as "Evaluated by —";
	// fails_when=the line appears with a placeholder;
	// no_claim=says nothing about the evaluator's own row
	it("omits 'Evaluated by' when the evaluator slot is unfilled", async () => {
		const slots = SLOTS();
		slots[2] = { ...slots[2], assigneeName: null, assigneeId: null };
		await renderPage(props({ slots }));
		expect(rowOf("Speaker").textContent).not.toContain("Evaluated by");
	});

	// protects=every evaluator of a speech is named, in slot order, as the run sheet names them;
	// fails_when=only the first evaluator is drawn;
	// no_claim=says nothing about how the evaluators' own rows read
	it("names two evaluators, joined with a comma", async () => {
		const slots = SLOTS();
		slots.splice(
			3,
			0,
			slot({
				id: "ev2",
				roleKey: "evaluator",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 1,
				assigneeName: "Rehanna",
				assigneeId: "m-rehanna",
				evaluatesSlotId: "sp",
			}),
		);
		await renderPage(props({ slots }));
		expect(rowOf("Speaker").textContent).toContain(
			"Evaluated by Sudheer, Rehanna",
		);
	});

	// protects=a stray evaluatesSlotId on a non-Evaluator slot does not name that person as the evaluator;
	// fails_when=the lookup drops the Evaluator-role filter pairedEvaluatorNames applies;
	// no_claim=says nothing about how such a link could arise
	it("ignores a non-evaluator slot that points at the speaker", async () => {
		const slots = SLOTS();
		slots.push(
			slot({
				id: "stray",
				roleKey: "timer",
				roleName: "Timer",
				assigneeName: "Strayperson",
				assigneeId: "m-stray",
				evaluatesSlotId: "sp",
			}),
		);
		await renderPage(props({ slots }));
		const text = rowOf("Speaker").textContent ?? "";
		expect(text).toContain("Evaluated by Sudheer");
		expect(text).not.toContain("Strayperson");
	});

	// protects=a role nobody holds reads "—" rather than the sheet's "open" wording;
	// fails_when=the OPEN placeholder or an empty cell is drawn;
	// no_claim=says nothing about which rows are open
	it("an unfilled role shows an em dash", async () => {
		await renderPage(props());
		const row = screen.getAllByText("General Evaluator")[0].closest("li");
		expect(row?.textContent).toContain("—");
		expect(row?.textContent).not.toContain("open");
	});

	// protects=detail text shows on non-speaker rows and is replaced on speaker rows;
	// fails_when=a speaker row still draws its detail, or an event row loses it;
	// no_claim=does not pin the wording of any detail
	it("detail appears on non-speaker rows only", async () => {
		await renderPage(props());
		const rows = Array.from(
			document.querySelectorAll('[data-testid="run-of-show"] > li'),
		);
		const speaker = rowOf("Speaker");
		const withDetail = rows.filter((r) => r !== speaker);
		// Some non-speaker row carries a secondary detail line.
		expect(withDetail.some((r) => r.querySelector("p.text-sm"))).toBe(true);
		const detailLines = Array.from(speaker.querySelectorAll("p")).map(
			(p) => p.textContent,
		);
		expect(detailLines.join("|")).not.toMatch(/Introduces/);
	});

	// protects=a multi-holder row names every holder, joined with ", ";
	// fails_when=only the first holder, or the OPEN placeholder, is drawn;
	// no_claim=does not cover the standard (non-template) flow
	it("a multi-holder templated row joins its holders", async () => {
		const names = ["Faisal Ali", "Rehanna Khan"];
		const slots = names.map((n, i) =>
			slot({
				id: `c${i}`,
				roleKey: "contestant",
				roleName: "Contestant",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: i,
				assigneeName: n,
				assigneeId: `m${i}`,
			}),
		);
		await renderPage(
			props({
				slots,
				template: {
					roles: [
						{ key: "contestant", name: "Contestant", isSpeakerRole: true },
					],
					beats: [
						{
							id: "b0",
							sortOrder: 0,
							kind: "role",
							label: "Contest speeches",
							detail: null,
							minutes: 20,
							roleKey: "contestant",
							repeatsRoleKey: null,
							flex: false,
							handoff: false,
							markGreen: null,
							markYellow: null,
							markRed: null,
							clubGoverned: false,
						},
					],
				} as never,
			}),
		);
		expect(rowOf("Contest speeches").textContent).toContain(
			"Faisal Ali, Rehanna Khan",
		);
	});

	// protects=nothing the issue bans is drawn: marks, slide links, claim buttons;
	// fails_when=any button, slide link or timing-mark value appears;
	// no_claim=a source-level absence, not a proof about the print layouts
	it("draws no claim buttons, slide links or green/yellow/red marks", async () => {
		const slots = SLOTS();
		slots[1] = { ...slots[1], presentationUrl: "https://slides.example/deck" };
		const { container } = await renderPage(props({ slots }));
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(container.innerHTML).not.toContain("slides.example");
		expect(container.innerHTML).not.toMatch(/claim|green|yellow|red\b/i);
	});
});

describe("role descriptions", () => {
	// protects=a description renders as native <details> keyed by role key;
	// fails_when=the key lookup is skipped, or a row without one gets <details>;
	// no_claim=says nothing about styling of the disclosure
	it("by role key: that row is <details> with the description, others are plain", async () => {
		await renderPage(
			props({ roleDescriptions: { speaker: "Gives a prepared speech." } }),
		);
		const details = document.querySelectorAll("details");
		expect(details).toHaveLength(1);
		expect(details[0].textContent).toContain("Gives a prepared speech.");
		expect(details[0].textContent).toContain("Jagpal");
	});

	// protects=a custom role works through the role-name fallback;
	// fails_when=only the key is consulted;
	// no_claim=says nothing about key-over-name precedence
	it("falls back to the slot's role name", async () => {
		await renderPage(props({ roleDescriptions: { Speaker: "By name." } }));
		const details = document.querySelectorAll("details");
		expect(details).toHaveLength(1);
		expect(details[0].textContent).toContain("By name.");
	});

	// protects=the row's display label ("Speaker 1") is never a lookup key;
	// fails_when=a description keyed by a display label attaches to a row;
	// no_claim=says nothing about real keys
	it("never matches by the row's display label", async () => {
		await renderPage(props({ roleDescriptions: { "Speaker 1": "nope" } }));
		expect(document.querySelectorAll("details")).toHaveLength(0);
	});

	// protects=an expandable row shows a rotating chevron in its <summary>, a plain row none, and the summary has a focus ring (#1364);
	// fails_when=the chevron is removed, loses group-open:rotate-90 or duration-200, the summary loses its focus-visible ring or shows the webkit marker;
	// no_claim=jsdom has no layout, so it says nothing about the rotation or ring actually rendering
	it("an expandable row has a chevron in its summary; a plain row has none", async () => {
		await renderPage(
			props({ roleDescriptions: { speaker: "Gives a prepared speech." } }),
		);
		const rowFor = (name: string) =>
			Array.from(document.querySelectorAll("li")).find((li) =>
				li.textContent?.includes(name),
			);
		const expandable = rowFor("Icebreaker Jitters");
		const plain = rowFor("Toastmaster of the Day");
		expect(expandable).toBeDefined();
		expect(plain).toBeDefined();
		expect(plain?.querySelector("svg.lucide-chevron-right")).toBeNull();
		const summary = expandable?.querySelector("details > summary");
		const chevron = summary?.querySelector("svg.lucide-chevron-right");
		expect(chevron).not.toBeNull();
		expect(chevron?.getAttribute("aria-hidden")).toBe("true");
		expect(chevron?.classList.contains("group-open:rotate-90")).toBe(true);
		expect(chevron?.classList.contains("duration-200")).toBe(true);
		expect(
			summary?.classList.contains("[&::-webkit-details-marker]:hidden"),
		).toBe(true);
		expect(summary?.classList.contains("focus-visible:ring-[3px]")).toBe(true);
	});

	// protects=no description, no <details>;
	// fails_when=an empty disclosure is drawn;
	// no_claim=says nothing about clubs with descriptions
	it("renders no <details> when the club has no descriptions", async () => {
		await renderPage(props());
		expect(document.querySelectorAll("details")).toHaveLength(0);
	});
});

describe("the 'You' badge", () => {
	const youCount = () => screen.queryAllByText("You").length;

	// protects=the member who holds a slot is told which row is theirs;
	// fails_when=the badge is missing, or lands on another row;
	// no_claim=says nothing about rows with no slotId
	it("shows on exactly the row whose slot the signed-in voter holds", async () => {
		session({ userId: "u1" });
		vi.mocked(getBallotSessionVoter).mockResolvedValue({
			id: "m-jagpal",
			name: "Jagpal",
		} as never);
		await renderPage(props());
		await waitFor(() => expect(youCount()).toBe(1));
		expect(rowOf("Speaker").textContent).toContain("You");
		expect(vi.mocked(getBallotSessionVoter)).toHaveBeenCalledWith({
			data: { meetingId: MEETING_ID },
		});
	});

	// protects=the badge uses DESIGN.md's "yours" treatment (solid green plus ring), never teal;
	// fails_when=the badge goes back to the primary (teal) tokens, which DESIGN.md reserves for navigation;
	// no_claim=does not measure contrast; the tokens carry the AA pairing in both themes
	it("is the green 'yours' fill with the status ring, not teal", async () => {
		session({ userId: "u1" });
		vi.mocked(getBallotSessionVoter).mockResolvedValue({
			id: "m-jagpal",
			name: "Jagpal",
		} as never);
		await renderPage(props());
		const badge = await screen.findByText("You");
		const cls = badge.className;
		expect(cls).toContain("bg-success");
		expect(cls).toContain("text-success-foreground");
		expect(cls).toContain("ring-success-strong");
		expect(cls).not.toMatch(/primary/);
	});

	// protects=a signed-in non-member gets no badge;
	// fails_when=null voter is treated as a match;
	// no_claim=says nothing about members
	it("shows nothing when the voter is null", async () => {
		session({ userId: "u1" });
		vi.mocked(getBallotSessionVoter).mockResolvedValue(null);
		await renderPage(props());
		await waitFor(() =>
			expect(vi.mocked(getBallotSessionVoter)).toHaveBeenCalled(),
		);
		expect(youCount()).toBe(0);
	});

	// protects=a signed-out visitor never triggers the voter lookup or a badge;
	// fails_when=the server fn is called without a session;
	// no_claim=says nothing about signed-in viewers
	it("shows nothing signed out, and does not look the voter up", async () => {
		await renderPage(props());
		expect(youCount()).toBe(0);
		expect(vi.mocked(getBallotSessionVoter)).not.toHaveBeenCalled();
	});

	// protects=a row bound to no single slot never gets the badge (stated limit);
	// fails_when=a multi-holder row is badged;
	// no_claim=says nothing about who actually holds those slots
	it("never badges a row with a null slotId", async () => {
		session({ userId: "u1" });
		vi.mocked(getBallotSessionVoter).mockResolvedValue({
			id: "m0",
			name: "Faisal Ali",
		} as never);
		const slots = ["Faisal Ali", "Rehanna Khan"].map((n, i) =>
			slot({
				id: `c${i}`,
				roleKey: "contestant",
				roleName: "Contestant",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: i,
				assigneeName: n,
				assigneeId: `m${i}`,
			}),
		);
		await renderPage(
			props({
				slots,
				template: {
					roles: [
						{ key: "contestant", name: "Contestant", isSpeakerRole: true },
					],
					beats: [
						{
							id: "b0",
							sortOrder: 0,
							kind: "role",
							label: "Contest speeches",
							detail: null,
							minutes: 20,
							roleKey: "contestant",
							repeatsRoleKey: null,
							flex: false,
							handoff: false,
							markGreen: null,
							markYellow: null,
							markRed: null,
							clubGoverned: false,
						},
					],
				} as never,
			}),
		);
		await waitFor(() =>
			expect(vi.mocked(getBallotSessionVoter)).toHaveBeenCalled(),
		);
		expect(youCount()).toBe(0);
	});
});

describe("cancelled", () => {
	// protects=a cancelled meeting shows the notice in place of rows, header kept;
	// fails_when=rows still render, or the header disappears;
	// no_claim=says nothing about the notice's wording
	it("shows the notice and no run rows", async () => {
		await renderPage(props({ cancelled: true }));
		expect(screen.getByTestId("cancelled-meeting-notice")).toBeTruthy();
		expect(screen.queryByTestId("run-of-show")).toBeNull();
		expect(screen.getByText("Downtown Toastmasters")).toBeTruthy();
	});
});
