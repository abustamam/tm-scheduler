// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { MeetingPresent } from "./meeting-present";

// `MeetingPresent` polls `getVoteParticipation` for the bare-count badge
// (#510). Stubbed rather than left to hit a real server fn: this suite is
// about slide navigation and content, not the participation query, and an
// unmocked call would hang every one of these renders on a network request
// jsdom cannot make.
//
// `getVoteParticipation` itself has to come from `vi.hoisted` (the factory
// below is hoisted above this file's own imports, same reason
// `club-switcher.test.tsx` uses the pattern) so the participation-badge tests
// can point it at their own fixture with `mockResolvedValue`, rather than
// every test in this file being stuck with one shared canned response.
const { getVoteParticipation } = vi.hoisted(() => ({
	getVoteParticipation: vi.fn(),
}));
vi.mock("#/server/voting", () => ({ getVoteParticipation }));

/** The default every test gets unless it overrides — zero ballots, no
 *  attendance marked yet. Reset in `beforeEach` rather than set once, so a
 *  participation-badge test's override never leaks into the next test. */
function defaultParticipation() {
	getVoteParticipation.mockResolvedValue({
		categories: {
			best_speaker: { ballotsIn: 0 },
			best_evaluator: { ballotsIn: 0 },
			best_table_topics: { ballotsIn: 0 },
		},
		presentCount: null,
	});
}
beforeEach(() => defaultParticipation());

const CLUB_NAME = "MCF Toastmasters Club";
const MEETING_ID = "11111111-1111-4111-8111-111111111111";

const deck: Slide[] = [
	{
		kind: "title",
		clubName: CLUB_NAME,
		logoUrl: null,
		district: "District 39",
		clubNumber: "28677176",
		meetingNumber: null,
		scheduledAt: new Date("2026-06-25T23:45:00Z"),
		timezone: "America/Chicago",
	},
	{
		kind: "wordOfDay",
		word: "Serendipity",
		definition: "A fortunate happenstance.",
		example: "Meeting my mentor was pure serendipity.",
		presenter: { role: "Grammarian", name: "Mona" },
	},
	{
		kind: "voteSpeaker",
		names: ["Jane Doe"],
		hasTimer: true,
		caller: { role: "Toastmaster of the Day", name: "Faisal" },
		ballotUrl: "https://gavelup.test/club/mcf/meeting/2026-06-25/vote",
	},
	{
		kind: "thankYou",
		meetingSchedule: "2nd & 4th Thursday",
		nextMeetingAt: null,
		timezone: "America/Chicago",
	},
];

/** Ten slides — enough rows for ↑/↓ to have somewhere to go in a 4-wide grid. */
const longDeck: Slide[] = Array.from({ length: 10 }, (_, n) => ({
	kind: "speech",
	label: `Section ${n + 1}`,
	speaker: "Jane Doe",
	title: null,
	projectLevel: null,
	time: "5–7 min",
	link: null,
}));

/** Wraps `MeetingPresent` in the `QueryClientProvider` its participation
 *  query needs (#510) — absent before this feature, so no render in this
 *  file had one — and defaults `deck`/`clubName`/`meetingId` to the standard
 *  fixtures, matching `renderSearch` in `global-search.test.tsx`. */
function renderPresent(
	props: Partial<ComponentProps<typeof MeetingPresent>> = {},
) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MeetingPresent
				deck={deck}
				clubName={CLUB_NAME}
				meetingId={MEETING_ID}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

function clickNext() {
	fireEvent.click(screen.getByLabelText("Next slide"));
}

function press(key: string) {
	fireEvent.keyDown(window, { key });
}

/** The overview overlay, or null when it is closed. */
function overview() {
	return screen.queryByRole("dialog", { name: "Jump to a slide" });
}

describe("MeetingPresent", () => {
	afterEach(() => cleanup());

	it("renders the title slide's club name as the splash headline", () => {
		renderPresent();
		expect(screen.getByText(CLUB_NAME)).toBeTruthy();
	});

	it("shows a slide position indicator", () => {
		renderPresent();
		expect(screen.getByText("1 / 4")).toBeTruthy();
	});

	it("shows the section-title header on a content slide, unprefixed by the club name, while the club name still appears in the footer", () => {
		renderPresent();
		clickNext(); // -> wordOfDay

		// Exact match proves the header is just the section title, not
		// "<clubName>: Word of the Day" or similar.
		expect(screen.getByText("Word of the Day")).toBeTruthy();

		// The club name now lives in the footer, not a running per-slide header.
		expect(screen.getAllByText(CLUB_NAME).length).toBeGreaterThanOrEqual(1);
	});

	it("credits the Grammarian on the Word of the Day slide (#354)", () => {
		renderPresent();
		clickNext(); // -> wordOfDay

		expect(screen.getByText("Presented by the Grammarian · Mona")).toBeTruthy();
	});

	// #355. The word is announced up front and then a dozen slides go by before
	// Table Topics, which is where it is meant to be USED. Projecting it again
	// here is a reminder, not a second presentation — hence no Grammarian credit
	// and no example, both of which belong to the slide #354 moved up front.
	it("keeps the Word of the Day on screen through Table Topics (#355)", () => {
		renderPresent({
			deck: [
				{
					kind: "tableTopics",
					master: "Rasheed",
					timing: "1–2 minutes per speaker",
					word: "Momentum",
					definition: "impetus gained by a moving object",
				},
			],
		});

		expect(screen.getByText("Word of the Day: “Momentum”")).toBeTruthy();
		expect(screen.getByText("impetus gained by a moving object")).toBeTruthy();
	});

	it("shows the Toastmasters non-affiliation disclaimer in the content-slide footer", () => {
		renderPresent();
		clickNext(); // -> wordOfDay (content slide with footer)

		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	it("renders the vote prompt on a vote slide", () => {
		renderPresent();
		clickNext(); // -> wordOfDay
		clickNext(); // -> voteSpeaker

		expect(screen.getByText("Please Vote for Best Speaker:")).toBeTruthy();
	});

	// #510 review finding 1. The QR is the feature's entire entry point — the
	// room has no other way to reach the ballot — and a reviewer proved it had
	// no regression net at all: disabling BOTH QR renderings (this one and the
	// printed footer's) left the full 230-file suite green. These assertions,
	// and their print-surface counterpart in `print-page-count.test.tsx`, close
	// that gap.
	it("renders the vote slide's QR inside its white plate, with a scan-to-vote label", () => {
		const { container } = renderPresent();
		clickNext(); // -> wordOfDay
		clickNext(); // -> voteSpeaker

		// The fixture's `ballotUrl` is non-empty from the very first render (no
		// async origin-effect gap in this deck), so unlike the badge below this
		// needs no `findBy` wait.
		const plate = container.querySelector('[data-testid="vote-qr"]');
		expect(plate).toBeTruthy();
		expect(plate?.querySelector("svg")).toBeTruthy();
		expect(screen.getByText("Scan to vote")).toBeTruthy();
	});

	it("renders no QR plate at all on a non-vote content slide", () => {
		const { container } = renderPresent();
		clickNext(); // -> wordOfDay: a content slide, but not a vote slide

		expect(container.querySelector('[data-testid="vote-qr"]')).toBeNull();
	});

	describe("the participation badge (#510 review finding 1)", () => {
		it('reads "N votes in" (singular) when attendance has not been marked', async () => {
			getVoteParticipation.mockResolvedValue({
				categories: {
					best_speaker: { ballotsIn: 1 },
					best_evaluator: { ballotsIn: 0 },
					best_table_topics: { ballotsIn: 0 },
				},
				presentCount: null,
			});
			renderPresent();
			clickNext(); // -> wordOfDay
			clickNext(); // -> voteSpeaker

			expect(await screen.findByText("1 vote in")).toBeTruthy();
		});

		it('reads "N votes in" (plural) for zero, never fabricating "0 of 0"', async () => {
			// `presentCount` stays null until attendance is marked — the server
			// cannot know who is in the room until someone votes. Zero ballots
			// with a null `presentCount` must read as "0 votes in", not
			// "0 of 0 present have voted".
			getVoteParticipation.mockResolvedValue({
				categories: {
					best_speaker: { ballotsIn: 0 },
					best_evaluator: { ballotsIn: 0 },
					best_table_topics: { ballotsIn: 0 },
				},
				presentCount: null,
			});
			renderPresent();
			clickNext();
			clickNext();

			expect(await screen.findByText("0 votes in")).toBeTruthy();
			expect(screen.queryByText(/of 0/)).toBeNull();
		});

		it('reads "N of M present have voted" once attendance IS marked', async () => {
			getVoteParticipation.mockResolvedValue({
				categories: {
					best_speaker: { ballotsIn: 7 },
					best_evaluator: { ballotsIn: 0 },
					best_table_topics: { ballotsIn: 0 },
				},
				presentCount: 12,
			});
			renderPresent();
			clickNext();
			clickNext();

			expect(
				await screen.findByText("7 of 12 present have voted"),
			).toBeTruthy();
		});
	});

	it("shows Thank You on the closing splash slide", () => {
		renderPresent();
		clickNext(); // -> wordOfDay
		clickNext(); // -> voteSpeaker
		clickNext(); // -> thankYou

		expect(screen.getByText("Thank You")).toBeTruthy();
	});

	// #360 — arrowing through twenty slides in front of the room is not a
	// navigation model. The overview must be invisible until asked for, so the
	// projection is unchanged during normal use.
	describe("slide overview (#360)", () => {
		it("is hidden until it is invoked", () => {
			renderPresent();

			expect(overview()).toBeNull();
			// Nothing from a later slide is on screen either.
			expect(screen.queryByText("Vote for Best Speaker")).toBeNull();
		});

		it("opens on `b` and lists every slide by its header", () => {
			renderPresent();
			press("b");

			const panel = overview();
			expect(panel).toBeTruthy();
			const items = within(panel as HTMLElement).getAllByRole("button", {
				name: /^Slide \d+:/,
			});
			expect(items.map((b) => b.getAttribute("aria-label"))).toEqual([
				`Slide 1: ${CLUB_NAME}`,
				"Slide 2: Word of the Day",
				"Slide 3: Vote for Best Speaker",
				"Slide 4: Thank You",
			]);
		});

		// #446. The test above pins the whole label list, which looks like it
		// covers this — but its four-slide deck has no evaluation and no
		// evaluator vote, so it passed while the bug was live. The grid is the
		// only place the collision is visible: three evaluators legitimately
		// produce three identical "Speech Evaluation" cells, and the vote used to
		// return that same header, making a fourth. Find-the-vote became counting.
		it("does not add the evaluator vote to the run of Speech Evaluations (#446)", () => {
			const evaluators = ["Ana", "Ben", "Cara"];
			renderPresent({
				deck: [
					...evaluators.map(
						(evaluator, n): Slide => ({
							kind: "evaluation",
							label: `Evaluation ${n + 1}`,
							evaluator,
							speaker: "Jane Doe",
							time: "2–3 min",
						}),
					),
					{
						kind: "voteEvaluator",
						names: evaluators,
						hasTimer: true,
						caller: { role: "General Evaluator", name: "Faisal" },
						ballotUrl: "https://gavelup.test/club/mcf/meeting/2026-06-25/vote",
					},
				],
			});
			press("b");

			const items = within(overview() as HTMLElement).getAllByRole("button", {
				name: /^Slide \d+:/,
			});
			expect(items.map((b) => b.getAttribute("aria-label"))).toEqual([
				"Slide 1: Speech Evaluation",
				"Slide 2: Speech Evaluation",
				"Slide 3: Speech Evaluation",
				"Slide 4: Vote for Best Evaluator",
			]);
		});

		it("also opens on `o` and from the slide counter", () => {
			renderPresent();
			press("o");
			expect(overview()).toBeTruthy();
			press("Escape");
			expect(overview()).toBeNull();

			fireEvent.click(screen.getByText("1 / 4"));
			expect(overview()).toBeTruthy();
		});

		it("jumps straight to a chosen slide and closes", () => {
			renderPresent();
			press("b");
			fireEvent.click(
				screen.getByRole("button", { name: "Slide 3: Vote for Best Speaker" }),
			);

			expect(overview()).toBeNull();
			expect(screen.getByText("3 / 4")).toBeTruthy();
			expect(screen.getByText("Please Vote for Best Speaker:")).toBeTruthy();
		});

		it("closes on Escape without changing position or exiting present mode", () => {
			const onExit = vi.fn();
			renderPresent({ onExit });
			clickNext(); // -> wordOfDay
			press("b");
			// Move the highlight around; Escape must still discard it.
			press("ArrowRight");
			press("ArrowRight");
			press("Escape");

			expect(overview()).toBeNull();
			expect(screen.getByText("2 / 4")).toBeTruthy();
			expect(screen.getByText("Word of the Day")).toBeTruthy();
			// Escape closed the overview; it did not also leave the deck.
			expect(onExit).not.toHaveBeenCalled();
		});

		it("navigates the overview with the arrow keys and commits on Enter", () => {
			renderPresent();
			press("b");
			press("ArrowRight");
			press("ArrowRight");
			// The deck itself has not moved while the overview is open.
			expect(screen.getByText("1 / 4")).toBeTruthy();
			press("Enter");

			expect(overview()).toBeNull();
			expect(screen.getByText("3 / 4")).toBeTruthy();
		});

		it("still exits present mode on Escape when the overview is closed", () => {
			const onExit = vi.fn();
			renderPresent({ onExit });
			press("Escape");

			expect(onExit).toHaveBeenCalledTimes(1);
		});

		// The hardware this feature exists for: a Logitech R400/R800 and its clones
		// send PageDown/PageUp for forward/back and `b` for blank — no Enter, no
		// Space, no ↑/↓. If those three keys do the wrong thing in the overview, the
		// presenter at the back of the room walks to the laptop, which is the exact
		// failure #360 exists to eliminate.
		describe("driven from a presenter remote", () => {
			it("moves the highlight one slide on PageDown/PageUp, not one row", () => {
				renderPresent({ deck: longDeck });
				press("b");
				press("PageDown");
				press("PageDown");
				// Still parked on slide 1 — the remote moved the highlight, not the
				// projection.
				expect(screen.getByText("1 / 10")).toBeTruthy();
				press("Enter");

				// 1 + 1 + 1. A row-sized PageDown would have landed on slide 9 and
				// left slides 2–4 unreachable from the remote entirely.
				expect(screen.getByText("3 / 10")).toBeTruthy();
			});

			it("commits on `b` — the only button the remote has left", () => {
				renderPresent({ deck: longDeck });
				press("b");
				press("PageDown");
				press("PageDown");
				press("b");

				expect(overview()).toBeNull();
				expect(screen.getByText("3 / 10")).toBeTruthy();
			});

			it("is an unchanged close when `b` is pressed without moving the highlight", () => {
				renderPresent();
				clickNext(); // -> slide 2
				press("b");
				press("b");

				// The cursor is seeded to the current slide, so committing it is the
				// same thing as backing out — b-b is a safe peek.
				expect(overview()).toBeNull();
				expect(screen.getByText("2 / 4")).toBeTruthy();
			});

			it("keeps Space, PageDown and PageUp off the deck while the overview is open", () => {
				renderPresent();
				press("b");
				press("PageDown");
				press("PageUp"); // net zero on the cursor
				expect(screen.getByText("1 / 4")).toBeTruthy();
				expect(overview()).toBeTruthy();

				press(" "); // commits the (unmoved) cursor and closes

				// Space must not ALSO have reached the deck's next(); an early
				// `return` in the overview branch is the only thing stopping it.
				expect(overview()).toBeNull();
				expect(screen.getByText("1 / 4")).toBeTruthy();
			});

			it("never tells the presenter to press Escape — that drops the projector out of fullscreen", () => {
				renderPresent();
				press("b");

				const panel = overview() as HTMLElement;
				expect(panel.textContent).not.toMatch(/esc/i);
				expect(panel.textContent).toContain("B or Enter go");
			});
		});

		it("moves the highlight one whole row at a time on ↑/↓", () => {
			renderPresent({ deck: longDeck });
			press("b");
			press("ArrowDown");
			press("Enter");
			// One row down from slide 1 in the 4-wide grid. This is the only reason
			// OVERVIEW_COLUMNS exists — it cannot be changed with a green suite.
			expect(screen.getByText("5 / 10")).toBeTruthy();

			press("b");
			press("ArrowUp");
			press("Enter");
			expect(screen.getByText("1 / 10")).toBeTruthy();

			// And ↑ clamps at the top rather than wrapping to the end of the deck.
			press("b");
			press("ArrowUp");
			press("Enter");
			expect(screen.getByText("1 / 10")).toBeTruthy();
		});
	});
});

describe("club logo on the projected splash (#496)", () => {
	afterEach(() => cleanup());

	const LOGO = "/api/club/abc/logo?v=1754000000000";
	const withLogo: Slide[] = deck.map((s) =>
		s.kind === "title" ? { ...s, logoUrl: LOGO } : s,
	);

	it("renders the logo on the opening splash when the club has one", () => {
		renderPresent({ deck: withLogo });
		const img = document.querySelector<HTMLImageElement>(`img[src="${LOGO}"]`);
		expect(img).not.toBeNull();
		expect(img?.getAttribute("alt")).toBe("");
	});

	// Everything on a slide is sized in cqw so it scales to whatever the deck is
	// projected onto. A px height here would be a postage stamp on a projector,
	// which is the whole reason ClubLogo takes a size at all.
	it("sizes the projected logo in container units, not pixels", () => {
		renderPresent({ deck: withLogo });
		const img = document.querySelector<HTMLImageElement>(`img[src="${LOGO}"]`);
		expect(img?.style.height).toContain("cqw");
		expect(img?.style.height).not.toContain("px");
	});

	it("renders no image at all when the club has no logo", () => {
		renderPresent();
		expect(document.querySelector(`img[src^="/api/club/"]`)).toBeNull();
	});

	it("still shows the club name as the splash headline beside the logo", () => {
		renderPresent({ deck: withLogo });
		expect(screen.getByText(CLUB_NAME)).toBeTruthy();
	});
});

/**
 * A templated meeting's deck through the SAME presenter (#agenda-templates PR 2).
 *
 * The two new slide kinds were put on the existing `Slide` union precisely so
 * this component, the jump grid and `deckToPptx` need no new dispatch. That is a
 * claim about the RENDERER, not about the builder, so it is asserted here rather
 * than in `agenda-template-slides.test.ts`: an unhandled kind falls through
 * `slideLayout` and renders an empty slide, which on a projector reads as a
 * broken app in front of the whole club.
 */
describe("a templated meeting's deck (#agenda-templates)", () => {
	afterEach(() => cleanup());

	const contestDeck: Slide[] = [
		{
			kind: "title",
			clubName: CLUB_NAME,
			logoUrl: null,
			district: null,
			clubNumber: null,
			meetingNumber: null,
			scheduledAt: new Date("2026-09-10T01:00:00Z"),
			timezone: "America/Chicago",
		},
		{ kind: "templateSection", title: "PREPARED SPEECH CONTEST" },
		{
			kind: "templateBeat",
			label: "Prepared speech 1 · Ada Lovelace",
			detail: "Judged. Chair calls the contestant.",
			minutes: 7,
			timing: {
				green: "5:00",
				yellow: "6:00",
				red: "7:00",
				qualifies: "4:30–7:30",
			},
		},
		{
			kind: "thankYou",
			meetingSchedule: null,
			nextMeetingAt: null,
			timezone: "America/Chicago",
		},
	];

	it("projects a section band as its own slide", () => {
		renderPresent({ deck: contestDeck });
		clickNext();
		expect(screen.getByText("PREPARED SPEECH CONTEST")).toBeTruthy();
	});

	it("projects a beat with its presenter, detail and contest timing", () => {
		renderPresent({ deck: contestDeck });
		clickNext();
		clickNext();
		expect(screen.getByText("Prepared speech 1 · Ada Lovelace")).toBeTruthy();
		expect(
			screen.getByText("Judged. Chair calls the contestant."),
		).toBeTruthy();
		expect(
			screen.getByText("Signals: 5:00 green · 6:00 yellow · 7:00 red"),
		).toBeTruthy();
		// The disqualification window (#357) reaches the wall, not just the paper.
		expect(screen.getByText("Qualifies: 4:30–7:30")).toBeTruthy();
	});

	it("lists both new kinds in the jump-to-slide grid", () => {
		renderPresent({ deck: contestDeck });
		fireEvent.click(screen.getByLabelText(/jump to a slide/i));
		const grid = overview();
		if (!grid) throw new Error("overview did not open");
		// Named off content, through the same `slideName` the standard kinds use, so
		// a contest is navigable mid-meeting rather than only steppable.
		expect(within(grid).getByText(/PREPARED SPEECH CONTEST/)).toBeTruthy();
		expect(
			within(grid).getByText(/Prepared speech 1 · Ada Lovelace/),
		).toBeTruthy();
	});
});
