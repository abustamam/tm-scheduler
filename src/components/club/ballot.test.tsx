// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

type Category = BallotData["categories"][keyof BallotData["categories"]];

/** Never opened. */
const UNTOUCHED: Category = { isOpen: false, hasOpened: false, candidates: [] };
/** Opened, then closed by the Vote Counter. `loadBallot` withholds the
 *  candidates of a closed category, so an empty list is the real shape. */
const CLOSED: Category = { isOpen: false, hasOpened: true, candidates: [] };
const open = (...names: [string, string][]): Category => ({
	isOpen: true,
	hasOpened: true,
	candidates: names.map(([id, name]) => ({ kind: "member", id, name })),
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
	};
}

/** The panel shown whenever no category is open — before the first vote and
 *  between votes alike. Pinned as a constant because two tests assert the SAME
 *  panel covers both cases, which is the point (#722 AC 2). */
const WAITING_PANEL = "No vote is open right now";

function renderBallot() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const utils = render(
		<QueryClientProvider client={qc}>
			<Ballot meetingId={MEETING_ID} voter={VOTER} />
		</QueryClientProvider>,
	);
	return { ...utils, qc };
}

/** A candidate button shows it is this phone's pick with a tick (and the filled
 *  Button variant) — both come off the same `isChosen` branch, and the tick is
 *  the half a voter actually sees. `aria-hidden` keeps it out of the accessible
 *  name, so it has to be read off the DOM rather than matched by role. */
function isTicked(button: HTMLElement) {
	return button.querySelector("svg") !== null;
}

/** Drive the next poll by hand. The component polls on a 5s `refetchInterval`;
 *  a forced refetch exercises the same path — new payload arrives with no voter
 *  action — without hanging a fake-timer clock off React Query's interval. */
async function poll(qc: QueryClient) {
	await act(async () => {
		await qc.refetchQueries({ queryKey: ["ballot", MEETING_ID] });
	});
}

describe("Ballot", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
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
			expect(screen.getByRole("button", { name: "Alex Speaker" })).toBeTruthy();
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

	// AC 3: the Vote Counter closes a vote, and the card is gone by the next poll
	// with the voter doing nothing.
	it("drops an open card on the poll that reports it closed, with no voter action", async () => {
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
			expect(screen.queryByRole("button", { name: "Alex Speaker" })).toBeNull();
		});
		expect(screen.getByText(WAITING_PANEL)).toBeTruthy();
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

	describe("confirming a cast (#722)", () => {
		it("names the person it counted, only once the server has accepted", async () => {
			getBallot.mockResolvedValue(
				fixture({ best_speaker: open(["c-1", "Alex Speaker"]) }),
			);
			submitVote.mockResolvedValue({ ok: true });
			renderBallot();

			await userEvent.click(
				await screen.findByRole("button", { name: "Alex Speaker" }),
			);

			expect(
				await screen.findByText(/Vote counted for Alex Speaker/i),
			).toBeTruthy();
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

		it("moves the confirmation to the new name when the pick changes", async () => {
			getBallot.mockResolvedValue(
				fixture({
					best_speaker: open(["c-1", "Alex Speaker"], ["c-2", "Robin Speaker"]),
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

			await userEvent.click(
				screen.getByRole("button", { name: "Robin Speaker" }),
			);

			expect(
				await screen.findByText(/Vote counted for Robin Speaker/i),
			).toBeTruthy();
			expect(screen.queryByText(/Vote counted for Alex Speaker/i)).toBeNull();
			expect(submitVote).toHaveBeenCalledTimes(2);
		});

		// A cast in one open category must not confirm the other. `useMutation` is
		// one object shared by every card, so the states are keyed by CATEGORY.
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
						best_table_topics: {
							isOpen: true,
							hasOpened: true,
							// The id a real `loadWriteInCandidates` returns: `writeInKey`,
							// so lower-cased and whitespace-collapsed, NOT the spelling
							// that was typed.
							candidates: [
								{ kind: "writeIn", id: "bobby tables", name: typed },
							],
						},
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
	});
});
