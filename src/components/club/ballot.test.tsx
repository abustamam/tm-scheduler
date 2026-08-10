// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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

/** Every category defaults to untouched; override just the ones a test cares
 *  about. Matches the real shape `loadBallot` returns (#510 review finding 2:
 *  `hasOpened` is what lets a closed category read differently from one that
 *  was never opened, since both have `isOpen: false`). */
function fixture(overrides: Partial<BallotData["categories"]>): BallotData {
	const untouched = { isOpen: false, hasOpened: false, candidates: [] };
	return {
		meetingId: MEETING_ID,
		categories: {
			best_speaker: untouched,
			best_evaluator: untouched,
			best_table_topics: untouched,
			...overrides,
		},
	};
}

function renderBallot() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Ballot meetingId={MEETING_ID} voter={VOTER} />
		</QueryClientProvider>,
	);
}

describe("Ballot", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows the not-open-yet message when no category has ever been opened", async () => {
		getBallot.mockResolvedValue(fixture({}));
		renderBallot();

		expect(await screen.findByText("Voting isn't open yet")).toBeTruthy();
		expect(screen.queryByText("Voting closed")).toBeNull();
	});

	// The bug (#510 review finding 2): filtering to `isOpen` alone made a
	// closed category disappear, so once the LAST open category closed the
	// whole ballot fell back to "Voting isn't open yet" — the wrong tense for
	// a room that just finished voting.
	it("shows a 'Voting closed' card for a category that was open and has since closed", async () => {
		getBallot.mockResolvedValue(
			fixture({
				best_speaker: { isOpen: false, hasOpened: true, candidates: [] },
			}),
		);
		renderBallot();

		expect(await screen.findByText("Best Speaker")).toBeTruthy();
		expect(screen.getByText("Voting closed")).toBeTruthy();
		// The wrong-tense message must not also be showing.
		expect(screen.queryByText("Voting isn't open yet")).toBeNull();
	});

	it("shows an interactive card, not a closed one, for a category that is currently open", async () => {
		getBallot.mockResolvedValue(
			fixture({
				best_speaker: {
					isOpen: true,
					hasOpened: true,
					candidates: [{ kind: "member", id: "c-1", name: "Alex Speaker" }],
				},
			}),
		);
		renderBallot();

		expect(await screen.findByText("Best Speaker")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Alex Speaker" })).toBeTruthy();
		expect(screen.queryByText("Voting closed")).toBeNull();
	});

	it("renders an open card and a closed card side by side, and omits the untouched category", async () => {
		getBallot.mockResolvedValue(
			fixture({
				best_speaker: { isOpen: false, hasOpened: true, candidates: [] },
				best_evaluator: {
					isOpen: true,
					hasOpened: true,
					candidates: [{ kind: "member", id: "c-2", name: "Sam Evaluator" }],
				},
				// best_table_topics stays untouched — never opened.
			}),
		);
		renderBallot();

		expect(await screen.findByText("Best Speaker")).toBeTruthy();
		expect(screen.getByText("Voting closed")).toBeTruthy();
		expect(screen.getByText("Best Evaluator")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sam Evaluator" })).toBeTruthy();
		// Untouched — no card, no label, at all.
		expect(screen.queryByText("Best Table Topics")).toBeNull();
	});

	// The scenario the finding names directly: the LAST open vote closes.
	// Every category has now been touched and none is open, so this must
	// render three closed cards, never the generic "isn't open yet" empty
	// state a naive `visible.length === 0` (or the original `isOpen`-only
	// filter) would fall back to.
	it("shows a closed card for every category once all voting has finished", async () => {
		const closed: BallotData["categories"][keyof BallotData["categories"]] = {
			isOpen: false,
			hasOpened: true,
			candidates: [],
		};
		getBallot.mockResolvedValue(
			fixture({
				best_speaker: closed,
				best_evaluator: closed,
				best_table_topics: closed,
			}),
		);
		renderBallot();

		expect(await screen.findAllByText("Voting closed")).toHaveLength(3);
		expect(screen.queryByText("Voting isn't open yet")).toBeNull();
	});
});
