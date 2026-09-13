// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISQUALIFICATION_PRESETS } from "#/lib/disqualification";

// `vi.mock` factories are hoisted above imports, so the mock fns come from
// `vi.hoisted` — the same pattern `ballot.test.tsx` uses, so each test can point
// `getVoteTally` at its own fixture rather than one shared canned response.
const {
	getVoteTally,
	openVoteFn,
	closeVoteFn,
	disqualifyCandidateFn,
	undoDisqualificationFn,
} = vi.hoisted(() => ({
	getVoteTally: vi.fn(),
	openVoteFn: vi.fn(),
	closeVoteFn: vi.fn(),
	disqualifyCandidateFn: vi.fn(),
	undoDisqualificationFn: vi.fn(),
}));
vi.mock("#/server/voting", () => ({
	getVoteTally,
	openVoteFn,
	closeVoteFn,
	disqualifyCandidateFn,
	undoDisqualificationFn,
}));

import { VoteCounterPanel } from "./vote-counter-panel";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const SELF = "22222222-2222-4222-8222-222222222222";

type Entry = { kind: "member" | "guest" | "writeIn"; id: string; name: string };

/** One category's tally, in the shape `loadTally` actually returns. */
function category(over: {
	isOpen?: boolean;
	results?: (Entry & { count: number })[];
	disqualified?: (Entry & { count: number; reason: string })[];
	voterNames?: string[];
}) {
	return {
		isOpen: over.isOpen ?? false,
		results: over.results ?? [],
		disqualified: over.disqualified ?? [],
		voterNames: over.voterNames ?? [],
	};
}

/** Every category empty and closed; override the ones a test cares about. */
function tally(over: Partial<Record<string, ReturnType<typeof category>>>) {
	return {
		categories: {
			best_speaker: category({}),
			best_evaluator: category({}),
			best_table_topics: category({}),
			...over,
		},
		tableTopicsSpeakers: [],
	};
}

function renderPanel() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const utils = render(
		<QueryClientProvider client={qc}>
			<VoteCounterPanel
				meetingId={MEETING_ID}
				selfMemberId={SELF}
				onSetWinner={vi.fn()}
				onClearWinner={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, qc };
}

/** Scope queries to one award's card. Three cards render at once and every one
 *  of them carries a "Disqualify" control, so an unscoped query finds all
 *  three. */
function card(label: string) {
	const section = screen
		.getByRole("heading", { name: label })
		.closest("section");
	if (!section) throw new Error(`no card rendered for ${label}`);
	return within(section);
}

/** Drive the next poll by hand, for the tests about what a new PAYLOAD does. */
async function poll(qc: QueryClient) {
	await act(async () => {
		await qc.refetchQueries({ queryKey: ["vote-tally", MEETING_ID] });
	});
}

const member = (id: string, name: string, count = 0) => ({
	kind: "member" as const,
	id,
	name,
	count,
});

describe("VoteCounterPanel disqualification (#723)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The control has to be reachable WHILE the vote runs, which is the whole
	// point: a ruling that only became possible after the close would arrive
	// after the room had already spent its votes.
	it("offers the control on an OPEN category, and shows no counts there", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana", 4), member("m-2", "Bo", 1)],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		expect(await speaker.findByText("Ana")).toBeTruthy();
		expect(
			speaker.getAllByRole("button", { name: /^Disqualify / }),
		).toHaveLength(2);
		// The counts are the half that must NOT be here. Showing them while the
		// vote runs puts a live leaderboard in front of the person announcing the
		// result — the same reason the projector gets a participation badge only.
		//
		// Asserted STRUCTURALLY rather than against the string the closed list
		// happens to use today ("Ana — 4"): that proxy stops being able to fail
		// the moment someone changes the separator, which is the eroding-proxy
		// trap `CODING_STANDARDS.md` records. The invariant is "no per-candidate
		// number reaches an open card", so the check is: strip the one line that
		// legitimately carries a number — the bare ballots-in total, which is
		// exactly what the projector already shows — and no digit may remain.
		const text = (speaker.getByText("Ana").closest("section")?.textContent ??
			"") as string;
		expect(text).toContain("5 votes in");
		expect(text.replace("5 votes in", "")).not.toMatch(/\d/);
	});

	it("sends the preset reason without typing, and only for that candidate", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana"), member("m-2", "Bo")],
				}),
			}),
		);
		disqualifyCandidateFn.mockResolvedValue({ ok: true });
		renderPanel();

		const speaker = card("Best Speaker");
		await userEvent.click(
			await speaker.findByRole("button", { name: "Disqualify Bo" }),
		);
		await userEvent.click(
			speaker.getByRole("button", { name: DISQUALIFICATION_PRESETS[1] }),
		);

		expect(disqualifyCandidateFn).toHaveBeenCalledTimes(1);
		expect(disqualifyCandidateFn.mock.calls[0][0].data).toEqual({
			meetingId: MEETING_ID,
			category: "best_speaker",
			candidate: { kind: "member", id: "m-2" },
			reason: DISQUALIFICATION_PRESETS[1],
			selfMemberId: SELF,
		});
	});

	it("sends a typed reason", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana")],
				}),
			}),
		);
		disqualifyCandidateFn.mockResolvedValue({ ok: true });
		renderPanel();

		const speaker = card("Best Speaker");
		await userEvent.click(
			await speaker.findByRole("button", { name: "Disqualify Ana" }),
		);
		await userEvent.type(
			speaker.getByLabelText(/Reason Ana can't win/),
			"Ran 30 seconds over",
		);
		await userEvent.click(
			// Exact string match: ByRole's `name` is exact for strings, so this
			// finds the FORM's submit and not the "Disqualify Ana" trigger it
			// replaced.
			speaker.getByRole("button", { name: "Disqualify" }),
		);

		expect(disqualifyCandidateFn.mock.calls[0][0].data.reason).toBe(
			"Ran 30 seconds over",
		);
	});

	// A write-in has no row, so it has to travel as its NAME — the same
	// asymmetry `castVote` carries. Getting this wrong would send `{id: "bo
	// smith"}` as a member id and fail server-side with an unrelated message.
	it("sends a write-in candidate by NAME, not by its folded id", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_table_topics: category({
					isOpen: true,
					results: [
						{ kind: "writeIn", id: "bo smith", name: "Bo Smith", count: 2 },
					],
				}),
			}),
		);
		disqualifyCandidateFn.mockResolvedValue({ ok: true });
		renderPanel();

		const tt = card("Best Table Topics");
		await userEvent.click(
			await tt.findByRole("button", { name: "Disqualify Bo Smith" }),
		);
		await userEvent.click(
			tt.getByRole("button", { name: DISQUALIFICATION_PRESETS[0] }),
		);

		expect(disqualifyCandidateFn.mock.calls[0][0].data.candidate).toEqual({
			kind: "writeIn",
			name: "Bo Smith",
		});
	});

	// AC 1's second half. The undo list renders in EVERY window state, because a
	// Vote Counter who mistyped must not have to re-open the vote to fix it.
	it.each([
		["open", true],
		["closed", false],
	])("offers undo on a %s category, with the excluded count", async (_l, isOpen) => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen,
					results: [member("m-1", "Ana", 2)],
					disqualified: [
						{ ...member("m-2", "Bo", 3), reason: "Outside the window" },
					],
				}),
			}),
		);
		undoDisqualificationFn.mockResolvedValue({ ok: true });
		renderPanel();

		const speaker = card("Best Speaker");
		// The count is shown, not hidden: "3 votes, excluded" is the sentence the
		// Vote Counter has to be able to give the room.
		expect(await speaker.findByText(/3\s*excluded/)).toBeTruthy();
		expect(speaker.getByText("Outside the window")).toBeTruthy();

		await userEvent.click(
			speaker.getByRole("button", { name: "Undo disqualification of Bo" }),
		);
		expect(undoDisqualificationFn.mock.calls[0][0].data).toEqual({
			meetingId: MEETING_ID,
			category: "best_speaker",
			candidate: { kind: "member", id: "m-2" },
			selfMemberId: SELF,
		});
	});

	// AC 4 at the console: a disqualified candidate is not in the list the
	// winner is picked from, at any count. Bo leads 3-2 and still must not be
	// offered — a "Set winner" button beside a ruled-out name is the mis-tap
	// this whole feature exists to prevent.
	it("keeps a disqualified candidate out of the winner list even when leading", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: false,
					results: [member("m-1", "Ana", 2)],
					disqualified: [
						{ ...member("m-2", "Bo", 3), reason: "Outside the window" },
					],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		expect(await speaker.findByText("Ana — 2")).toBeTruthy();
		// Exactly one "Set winner" — the eligible candidate's. Counting them is
		// what makes this able to fail: asserting only that Ana has one would pass
		// with Bo carrying a second.
		expect(speaker.getAllByRole("button", { name: "Set winner" })).toHaveLength(
			1,
		);
	});

	it("restores the candidate to the winner list once the ruling is undone", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: false,
					results: [member("m-1", "Ana", 2)],
					disqualified: [
						{ ...member("m-2", "Bo", 3), reason: "Outside the window" },
					],
				}),
			}),
		);
		const { qc } = renderPanel();
		expect(
			(
				await card("Best Speaker").findAllByRole("button", {
					name: "Set winner",
				})
			).length,
		).toBe(1);

		// The undo lands; the next poll brings the restored tally down.
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: false,
					results: [member("m-2", "Bo", 3), member("m-1", "Ana", 2)],
				}),
			}),
		);
		await poll(qc);

		const speaker = card("Best Speaker");
		expect(await speaker.findByText("Bo — 3")).toBeTruthy();
		expect(speaker.getAllByRole("button", { name: "Set winner" })).toHaveLength(
			2,
		);
		expect(speaker.queryByRole("button", { name: /^Undo/ })).toBeNull();
	});

	it("surfaces a rejected disqualification instead of closing the form", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana")],
				}),
			}),
		);
		disqualifyCandidateFn.mockRejectedValue(
			new Error("Only the Ballot Counter or a club admin can do that."),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		await userEvent.click(
			await speaker.findByRole("button", { name: "Disqualify Ana" }),
		);
		await userEvent.click(
			speaker.getByRole("button", { name: DISQUALIFICATION_PRESETS[0] }),
		);

		// The form STAYS open carrying the reason it failed for. A rejection that
		// closed the form would read as success — the candidate would simply not
		// be struck through, and on a 5s poll that is indistinguishable from a
		// slow round trip.
		expect(await speaker.findByText(/Only the Ballot Counter/)).toBeTruthy();
		expect(speaker.getByLabelText(/Reason Ana can't win/)).toBeTruthy();
	});
});
