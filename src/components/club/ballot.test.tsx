// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BallotData } from "#/server/voting";

// `vi.mock` factories are hoisted above imports, so the mock fns themselves
// have to come from `vi.hoisted` — same pattern as `club-switcher.test.tsx` —
// so each test can point `getBallot` at its own fixture via
// `mockResolvedValue` rather than one shared canned response.
const { getBallot, submitVote } = vi.hoisted(() => ({
	getBallot: vi.fn(),
	submitVote: vi.fn(),
}));
vi.mock("#/server/voting", () => ({ getBallot, submitVote }));

import { Ballot, type VoterIdentity } from "./ballot";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const VOTER: VoterIdentity = { kind: "member", id: "m-1", name: "Jane Doe" };
const GUEST: VoterIdentity = { kind: "guest", id: "g-9", name: "Visitor Vic" };

type Category = BallotData["categories"][keyof BallotData["categories"]];

/** Never opened. */
const UNTOUCHED: Category = { isOpen: false, hasOpened: false, candidates: [] };
/** Opened, then closed by the Vote Counter. `loadBallot` withholds the
 *  candidates of a closed category, so an empty list is the real shape. */
const CLOSED: Category = { isOpen: false, hasOpened: true, candidates: [] };
const open = (...names: [string, string][]): Category => ({
	isOpen: true,
	hasOpened: true,
	candidates: names.map(([id, name]) => ({
		kind: "member",
		id,
		name,
		disqualified: null,
	})),
});
/** An open category where one candidate has been ruled out (#723). The third
 *  tuple slot is the reason; `null` there is an ordinary eligible candidate, so
 *  one fixture covers both halves of the list a real ballot renders — which is
 *  the case that matters, since the bug this guards against is the ruled-out
 *  name staying tappable while its neighbours behave. */
const openWithDisqualified = (
	...names: [string, string, string | null][]
): Category => ({
	isOpen: true,
	hasOpened: true,
	candidates: names.map(([id, name, reason]) => ({
		kind: "member",
		id,
		name,
		disqualified: reason === null ? null : { reason },
	})),
});
/** An open category listing write-ins already cast. `loadWriteInCandidates` ids
 *  each by `writeInKey(name)` — folded — while the NAME it displays is the
 *  first spelling anyone cast, so the two differ whenever the first caster used
 *  capitals. That gap is the point of the fixtures that use this. */
const openWithWriteIn = (...names: [string, string][]): Category => ({
	isOpen: true,
	hasOpened: true,
	candidates: names.map(([id, name]) => ({
		kind: "writeIn",
		id,
		name,
		disqualified: null,
	})),
});

/** Every category defaults to untouched; override just the ones a test cares
 *  about. Matches the real shape `loadBallot` returns. */
function fixture(overrides: Partial<BallotData["categories"]>): BallotData {
	return {
		meetingId: MEETING_ID,
		categories: {
			best_speaker: UNTOUCHED,
			best_evaluator: UNTOUCHED,
			best_table_topics: UNTOUCHED,
			...overrides,
		},
		digitalVotingOff: false,
	};
}

/** The panel shown whenever no category is open — before the first vote and
 *  between votes alike. Pinned as a constant because two tests assert the SAME
 *  panel covers both cases, which is the point (#722 AC 2). */
const WAITING_PANEL = "No vote is open right now";

function renderBallot(voter: VoterIdentity = VOTER) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const utils = render(
		<QueryClientProvider client={qc}>
			<Ballot meetingId={MEETING_ID} voter={voter} />
		</QueryClientProvider>,
	);
	return { ...utils, qc };
}

/**
 * Is this candidate button rendered as this phone's pick?
 *
 * Reads BOTH halves of the component's single `isChosen` ternary: the filled
 * `variant="default"` (the exact `bg-primary` class token — `outline` carries
 * `bg-background` and never matches) and the tick icon (`lucide-circle-check`;
 * `aria-hidden` keeps it out of the accessible name, so it has to come off the
 * DOM). Matching "any `<svg>` in the button" would pass on whatever icon a
 * refactor put there, and either half alone would pass while the other went
 * missing. They come off one ternary, so a disagreement is itself a bug and is
 * asserted here rather than silently resolved.
 */
function isTicked(button: HTMLElement): boolean {
	const filled = button.classList.contains("bg-primary");
	const tick = button.querySelector("svg.lucide-circle-check") !== null;
	expect(
		filled,
		"the filled variant and the tick come off one `isChosen` branch and must agree",
	).toBe(tick);
	return filled;
}

/** Scope queries to one award's card. Two open categories each carry their own
 *  "Someone else…" control, so an unscoped query finds both. */
function card(label: string) {
	const section = screen
		.getByRole("heading", { name: label })
		.closest("section");
	if (!section) throw new Error(`no card rendered for ${label}`);
	return within(section);
}

/** Drive the next poll by hand, for the tests about what a new PAYLOAD does.
 *  That the poll happens at all, unattended, is gated separately below
 *  ("polls by itself"), because a helper that forces a refetch cannot see a
 *  deleted `refetchInterval`. */
async function poll(qc: QueryClient) {
	await act(async () => {
		await qc.refetchQueries({ queryKey: ["ballot", MEETING_ID] });
	});
}

describe("Ballot", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe("digital voting switched off (#770)", () => {
		it("says digital voting is off instead of waiting for a vote", async () => {
			getBallot.mockResolvedValue({
				...fixture({}),
				digitalVotingOff: true,
			});
			renderBallot();

			expect(
				await screen.findByText("Digital voting is off for this meeting"),
			).toBeTruthy();
			expect(screen.queryByText(WAITING_PANEL)).toBeNull();
		});
	});

	describe("which categories get a card (#722)", () => {
		it("renders no card at all for a category that has closed", async () => {
			getBallot.mockResolvedValue(fixture({ best_speaker: CLOSED }));
			renderBallot();

			// The whole point: a closed category is not a dead card, it is nothing.
			expect(await screen.findByText(WAITING_PANEL)).toBeTruthy();
			expect(screen.queryByText("Best Speaker")).toBeNull();
			expect(screen.queryByText("Voting closed")).toBeNull();
		});

		it("renders an interactive card for a category that is open", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			renderBallot();

			expect(await screen.findByText("Best Speaker")).toBeTruthy();
			const button = screen.getByRole("button", { name: "Alex Speaker" });
			// Nothing is this phone's pick until it taps one. The negative case for
			// `isTicked`, without which it could return true unconditionally.
			expect(isTicked(button)).toBe(false);
			expect(screen.queryByText(WAITING_PANEL)).toBeNull();
		});

		it("shows only the open category when another has closed and a third was never opened", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: CLOSED,
					best_evaluator: open(["c-2", "Sam Evaluator"]),
					// best_table_topics stays untouched.
				}),
			);
			renderBallot();

			expect(await screen.findByText("Best Evaluator")).toBeTruthy();
			expect(
				screen.getByRole("button", { name: "Sam Evaluator" }),
			).toBeTruthy();
			expect(screen.queryByText("Best Speaker")).toBeNull();
			expect(screen.queryByText("Best Table Topics")).toBeNull();
		});
	});

	describe("the empty state is never a blank screen (#722)", () => {
		it("shows the live-and-waiting panel when nothing has ever been opened", async () => {
			getBallot.mockResolvedValue(fixture({}));
			renderBallot();

			expect(await screen.findByText(WAITING_PANEL)).toBeTruthy();
			expect(
				screen.getByText(/updates by itself as soon as the Vote Counter/i),
			).toBeTruthy();
		});

		// The case the old `hasOpened` branch existed to avoid, now handled by the
		// copy instead: with every vote finished the voter must still see the same
		// panel, and it must not claim nothing has happened yet.
		it("shows the SAME panel once every category has closed", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: CLOSED,
					best_evaluator: CLOSED,
					best_table_topics: CLOSED,
				}),
			);
			renderBallot();

			expect(await screen.findByText(WAITING_PANEL)).toBeTruthy();
			expect(
				screen.getByText(/updates by itself as soon as the Vote Counter/i),
			).toBeTruthy();
			// The wrong tense the old copy used ("isn't open YET") is gone.
			expect(screen.queryByText(/isn't open yet/i)).toBeNull();
		});
	});

	describe("the page keeps itself current (#722 AC 3)", () => {
		it("drops an open card on the poll that reports it closed", async () => {
			getBallot
				.mockResolvedValueOnce(
					fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
				)
				.mockResolvedValue(fixture({ best_speaker: CLOSED }));
			const { qc } = renderBallot();

			expect(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			).toBeTruthy();

			await poll(qc);

			await waitFor(() => {
				expect(
					screen.queryByRole("button", { name: "Alex Speaker" }),
				).toBeNull();
			});
			expect(screen.getByText(WAITING_PANEL)).toBeTruthy();
		});

		// The "with no voter action" half, and the promise the empty panel's copy
		// makes ("updates by itself"). Every other test here forces the refetch, so
		// deleting `refetchInterval` leaves all of them green — this is the only
		// thing that sees the polling itself. Pinned tightly enough to catch a
		// changed interval in either direction, not just a deleted one.
		it("polls by itself, roughly every five seconds, with nobody touching it", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			vi.useFakeTimers();
			renderBallot();

			// Let the mount fetch settle; the interval is armed off the back of it.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10);
			});
			expect(getBallot).toHaveBeenCalledTimes(1);

			// Short of the interval — nothing yet. Fails if the interval is shortened.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(4_000);
			});
			expect(getBallot).toHaveBeenCalledTimes(1);

			// Past it — exactly one more. Fails at 1 if `refetchInterval` is deleted
			// or lengthened.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1_500);
			});
			expect(getBallot).toHaveBeenCalledTimes(2);
		});
	});

	// AC 4: the instruction is on screen before anything is tapped.
	it("tells a first-time voter what to do before any tap", async () => {
		getBallot.mockResolvedValue(
			fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
		);
		renderBallot();

		await screen.findByRole("button", { name: "Alex Speaker" });
		const instruction = screen.getByText(/one vote per award/i);
		expect(instruction.textContent).toMatch(/tap a name/i);
		expect(instruction.textContent).toMatch(
			/change it while the vote is open/i,
		);
	});

	describe("what goes on the wire", () => {
		it("posts the meeting, category, voter and candidate row id", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			);

			expect(submitVote).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					category: "best_speaker",
					voter: { kind: "member", id: "m-1" },
					candidate: { kind: "member", id: "c-1" },
				},
			});
		});

		// The voter identity is the only thing standing between one person and two
		// ballots, and it is passed in as a prop rather than read from a session —
		// this is the public, unauthenticated route. A guest must post as a guest.
		it("posts a guest voter as a guest, with the guest's own id", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot(GUEST);

			await userEvent.click(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			);

			expect(submitVote).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						voter: { kind: "guest", id: "g-9" },
					}),
				}),
			);
		});

		// The invariant the component argues hardest for: a write-in posts the
		// NAME. Sending the folded key back would lowercase someone's name on the
		// awards slide the moment a second person voted for them, because the
		// server takes the first spelling cast as the display form.
		it("posts a freshly typed write-in as a NAME, never a folded key", async () => {
			getBallot.mockResolvedValue(fixture({ best_table_topics: open() }));
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: /someone else/i }),
			);
			await userEvent.type(
				screen.getByLabelText(/name of someone not listed/i),
				"Bob Smith",
			);
			await userEvent.click(screen.getByRole("button", { name: "Vote" }));

			expect(submitVote).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					category: "best_table_topics",
					voter: { kind: "member", id: "m-1" },
					candidate: { kind: "writeIn", name: "Bob Smith" },
				},
			});
		});

		// The same invariant on the OTHER arm, which is where it is easier to lose:
		// a write-in echoed back as a tappable button carries a folded `id`, and
		// tapping it must still post the displayed NAME.
		it("posts the NAME when an echoed-back write-in is tapped, not its folded id", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_table_topics: openWithWriteIn(["bob smith", "Bob Smith"]),
				}),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: "Bob Smith" }),
			);

			expect(submitVote).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					category: "best_table_topics",
					voter: { kind: "member", id: "m-1" },
					candidate: { kind: "writeIn", name: "Bob Smith" },
				},
			});
		});
	});

	describe("confirming a cast (#722)", () => {
		it("names the person it counted, only once the server has accepted", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			const button = await screen.findByRole("button", {
				name: "Alex Speaker",
			});
			await userEvent.click(button);

			expect(
				await screen.findByText(/Vote counted for Alex Speaker/i),
			).toBeTruthy();
			expect(isTicked(button)).toBe(true);
			// It is a confirmation, not a Submit: nothing on the card offers to send
			// a vote that tapping has already sent.
			expect(screen.queryByRole("button", { name: /^submit/i })).toBeNull();
			expect(submitVote).toHaveBeenCalledTimes(1);
		});

		// The half a green "it confirms after success" test cannot see: a
		// confirmation set at TAP time also passes that test, and is a lie for as
		// long as the request is in flight — which on conference wifi with twenty
		// phones is exactly when it matters, and is precisely the window in which
		// the vote may still fail.
		it("does not claim the vote is counted while it is still in flight", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			let accept: (value: unknown) => void = () => {};
			submitVote.mockReturnValue(
				new Promise((resolve) => {
					accept = resolve;
				}),
			);
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			);

			expect(await screen.findByText(/sending your vote/i)).toBeTruthy();
			expect(screen.queryByText(/Vote counted for/i)).toBeNull();

			await act(async () => {
				accept({ ok: true });
			});

			expect(
				await screen.findByText(/Vote counted for Alex Speaker/i),
			).toBeTruthy();
			expect(screen.queryByText(/sending your vote/i)).toBeNull();
		});

		it("keeps the selection and asks for a retry when the cast fails, and never reads as counted", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			submitVote.mockRejectedValue(new Error("offline"));
			renderBallot();

			const button = await screen.findByRole("button", {
				name: "Alex Speaker",
			});
			await userEvent.click(button);

			expect(await screen.findByText(/tap your choice again/i)).toBeTruthy();
			expect(screen.queryByText(/Vote counted for/i)).toBeNull();
			// The selection is KEPT — the tick stays on the name that failed, so the
			// voter knows which one to tap again.
			expect(isTicked(button)).toBe(true);
		});

		it("moves the confirmation and the tick to the new name when the pick changes", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: open(["c-1", "Alex Speaker"], ["c-2", "Robin Speaker"]),
				}),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			const alex = await screen.findByRole("button", { name: "Alex Speaker" });
			const robin = screen.getByRole("button", { name: "Robin Speaker" });

			await userEvent.click(alex);
			expect(
				await screen.findByText(/Vote counted for Alex Speaker/i),
			).toBeTruthy();
			expect(isTicked(alex)).toBe(true);
			expect(isTicked(robin)).toBe(false);

			await userEvent.click(robin);

			expect(
				await screen.findByText(/Vote counted for Robin Speaker/i),
			).toBeTruthy();
			expect(screen.queryByText(/Vote counted for Alex Speaker/i)).toBeNull();
			expect(
				isTicked(screen.getByRole("button", { name: "Alex Speaker" })),
			).toBe(false);
			expect(
				isTicked(screen.getByRole("button", { name: "Robin Speaker" })),
			).toBe(true);
			expect(submitVote).toHaveBeenCalledTimes(2);
		});

		// A cast in one open category must not confirm — or disable — the other.
		// One `useMutation` is shared by every card, so everything derived from it
		// has to be keyed by CATEGORY.
		it("confirms only the category that was voted in", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: open(["c-1", "Alex Speaker"]),
					best_evaluator: open(["c-2", "Sam Evaluator"]),
				}),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			);

			expect(
				await screen.findByText(/Vote counted for Alex Speaker/i),
			).toBeTruthy();
			expect(screen.queryByText(/Vote counted for Sam Evaluator/i)).toBeNull();
			expect(screen.getAllByText(/Vote counted for/i)).toHaveLength(1);
			expect(
				isTicked(screen.getByRole("button", { name: "Sam Evaluator" })),
			).toBe(false);
		});

		// The disabled flag used to come off the shared mutation's `isPending`, so
		// a vote in flight in one category greyed out the OTHER category's write-in
		// field — in a room where two votes are open at once, on the surface a
		// Table Topics voter needs most.
		it("does not disable another open category's write-in while a vote is in flight", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: open(["c-1", "Alex Speaker"]),
					best_table_topics: open(),
				}),
			);
			let accept: (value: unknown) => void = () => {};
			submitVote.mockReturnValue(
				new Promise((resolve) => {
					accept = resolve;
				}),
			);
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			);
			await screen.findByText(/sending your vote/i);

			// Table Topics has its own write-in field, and this phone has not voted
			// there — opening it and typing must still work.
			const tt = card("Best Table Topics");
			await userEvent.click(tt.getByRole("button", { name: /someone else/i }));
			await userEvent.type(
				tt.getByLabelText(/name of someone not listed/i),
				"Bob Smith",
			);
			const submit = tt.getByRole<HTMLButtonElement>("button", {
				name: "Vote",
			});
			expect(submit.disabled).toBe(false);

			await act(async () => {
				accept({ ok: true });
			});
		});

		// The write-in arm (#582): the confirmation names the spelling that was
		// typed, and when the poll returns that write-in as a candidate its button
		// is ticked — `loadWriteInCandidates` ids it by the FOLDED `writeInKey`, so
		// storing the raw spelling as the selection key left it unticked.
		it("confirms a write-in and ticks it when it comes back on the next poll", async () => {
			const typed = "Bobby Tables";
			getBallot
				.mockResolvedValueOnce(fixture({ best_table_topics: open() }))
				.mockResolvedValue(
					fixture({
						best_table_topics: openWithWriteIn(["bobby tables", typed]),
					}),
				);
			submitVote.mockResolvedValue({ ok: true });
			const { qc } = renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: /someone else/i }),
			);
			await userEvent.type(
				screen.getByLabelText(/name of someone not listed/i),
				typed,
			);
			await userEvent.click(screen.getByRole("button", { name: "Vote" }));

			expect(
				await screen.findByText(/Vote counted for Bobby Tables/i),
			).toBeTruthy();

			await poll(qc);

			const back = await screen.findByRole("button", { name: typed });
			expect(isTicked(back)).toBe(true);
		});

		// The display-name edge the fold alone does not close. The server shows the
		// FIRST spelling cast, so a voter who types "bob smith" after someone else
		// cast "Bob Smith" gets a button reading "Bob Smith" — and the confirmation
		// beside it must say the same thing, not the spelling they typed.
		it("re-names the confirmation to the listed spelling once the poll supplies one", async () => {
			getBallot
				.mockResolvedValueOnce(fixture({ best_table_topics: open() }))
				.mockResolvedValue(
					fixture({
						best_table_topics: openWithWriteIn(["bob smith", "Bob Smith"]),
					}),
				);
			submitVote.mockResolvedValue({ ok: true });
			const { qc } = renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: /someone else/i }),
			);
			await userEvent.type(
				screen.getByLabelText(/name of someone not listed/i),
				"bob smith",
			);
			await userEvent.click(screen.getByRole("button", { name: "Vote" }));

			// Nothing else to name yet: the typed spelling stands in.
			expect(
				await screen.findByText(/Vote counted for bob smith/),
			).toBeTruthy();

			await poll(qc);

			// Now the card lists the canonical spelling, and both halves say it.
			const listed = await screen.findByRole("button", { name: "Bob Smith" });
			expect(isTicked(listed)).toBe(true);
			expect(
				await screen.findByText(/Vote counted for Bob Smith/),
			).toBeTruthy();
			expect(screen.queryByText(/Vote counted for bob smith/)).toBeNull();
		});
	});

	// #723. A candidate can be on the ballot and unable to win — they ran
	// outside the qualifying window, or never used the Word of the Day. The
	// server is the gate (`castVote` rejects the vote); what these tests pin is
	// that the phone does not invite a vote it knows will be refused, and that
	// it says WHY.
	describe("a disqualified candidate (#723)", () => {
		const RULING = "Did not use the Word of the Day";

		it("renders struck through with the reason, and is not tappable", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: openWithDisqualified(
						["m-1", "Ana", null],
						["m-2", "Bo", RULING],
					),
				}),
			);
			renderBallot();

			const out = await screen.findByRole("button", { name: "Bo" });
			// `disabled`, not a click guard: it is what actually stops the tap AND
			// what takes the control out of the tab order. A component that merely
			// dropped the handler would still invite a tap and do nothing.
			expect((out as HTMLButtonElement).disabled).toBe(true);
			expect(within(out).getByText("Bo").className).toContain("line-through");

			// The reason sits OUTSIDE the disabled button, and this is what pins
			// that rather than merely checking the text exists somewhere.
			// `buttonVariants` carries `disabled:opacity-50`, and `opacity` applies
			// to the whole subtree — so a reason rendered INSIDE the control is
			// halved to roughly 3.5:1 with no child class able to recover it, which
			// is how this shipped before review: the one thing the feature exists to
			// tell the room, rendered behind the styling meant to mute the control.
			// Asserting the DOM relationship is the difference between "the reason
			// is present" and "the reason is legible".
			const reason = screen.getByText(new RegExp(RULING));
			expect(out.contains(reason)).toBe(false);
			expect(reason.className).toContain("text-sm");

			// The eligible neighbour is untouched — the fixture carries both
			// because the failure this guards against is a blanket disable.
			const ok = await screen.findByRole("button", { name: "Ana" });
			expect((ok as HTMLButtonElement).disabled).toBe(false);
		});

		it("does not cast a vote when the ruled-out name is clicked", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: openWithDisqualified(["m-2", "Bo", RULING]),
				}),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			const out = await screen.findByRole("button", { name: "Bo" });
			await userEvent.click(out);
			// The whole point of AC 2: the vote must not leave the phone. Asserting
			// the MUTATION (not the rendered tick) is what survives a refactor that
			// keeps the disabled styling and re-attaches a handler.
			expect(submitVote).not.toHaveBeenCalled();
		});

		it("retracts its own confirmation when this phone's pick is ruled out mid-vote", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["m-2", "Bo"]) }),
			);
			submitVote.mockResolvedValue({ ok: true });
			const { qc } = renderBallot();

			await userEvent.click(await screen.findByRole("button", { name: "Bo" }));
			expect(await screen.findByText(/Vote counted for Bo/)).toBeTruthy();

			// The Vote Counter rules Bo out; the next 5s poll brings it down.
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: openWithDisqualified(["m-2", "Bo", RULING]),
				}),
			);
			await poll(qc);

			// A standing "Vote counted" here is exactly the failure #723 exists to
			// end — someone spending their one vote on a candidate who cannot win
			// and never being told. The row stays in `meeting_votes`; what changes
			// is that the card stops claiming it counts for anyone.
			// The retraction names the ruling, not just the fact of one — a voter
			// told "you can't vote for Bo" and not why has to ask someone.
			const retraction = await screen.findByText(/Bo can't win this award/);
			expect(retraction.textContent).toContain(RULING);
			// Two places say it now, which is correct: the struck-through button and
			// this line. `getAllByText` rather than `getByText`, which throws on the
			// second match and would read as a failure of the feature.
			expect(screen.getAllByText(new RegExp(RULING)).length).toBeGreaterThan(0);
			// Asserted AFTER the `find` above, which is what waits for the poll's
			// re-render. A bare `queryByText` here runs against whatever is mounted
			// at that instant and reports the PRE-poll card, so it fails on correct
			// code — the false-fail shape `CODING_STANDARDS.md` records for guards
			// that compute their own anchor, in its component-test form.
			expect(screen.queryByText(/Vote counted for Bo/)).toBeNull();
		});

		it("restores the candidate when the ruling is undone", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: openWithDisqualified(["m-2", "Bo", RULING]),
				}),
			);
			submitVote.mockResolvedValue({ ok: true });
			const { qc } = renderBallot();

			expect(
				(
					(await screen.findByRole("button", {
						name: "Bo",
					})) as HTMLButtonElement
				).disabled,
			).toBe(true);

			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["m-2", "Bo"]) }),
			);
			await poll(qc);

			// `waitFor` on the ASSERTION, not `findByRole` on the element: both the
			// ruled-out button and the restored one answer to the name "Bo", so a
			// `findBy*` resolves the instant either exists and hands back the stale
			// disabled one before the poll's re-render has flushed. Retrying the
			// property is what actually waits for the state to change.
			await waitFor(() => {
				expect(
					(screen.getByRole("button", { name: "Bo" }) as HTMLButtonElement)
						.disabled,
				).toBe(false);
			});
			const back = screen.getByRole("button", { name: "Bo" });
			await userEvent.click(back);
			expect(submitVote).toHaveBeenCalledTimes(1);
		});
	});
});
