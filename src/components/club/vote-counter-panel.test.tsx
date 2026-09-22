// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISQUALIFICATION_PRESETS } from "#/lib/disqualification";
import { RULING_NEEDS_SESSION_MESSAGE } from "#/lib/write-proof";

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

/**
 * `sessionMemberId` defaults to SELF — a SIGNED-IN Ballot Counter — so every
 * case written before #752 keeps the console it was written against. The
 * anonymous viewer is the exception and says so at its call site, which is the
 * right way round: the ruling control existing is the normal state, and its
 * absence is what a reader should have to opt into.
 */
function renderPanel(
	over: { sessionMemberId?: string | null; canManageClub?: boolean } = {},
) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const utils = render(
		<QueryClientProvider client={qc}>
			<VoteCounterPanel
				meetingId={MEETING_ID}
				selfMemberId={SELF}
				sessionMemberId={
					over.sessionMemberId === undefined ? SELF : over.sessionMemberId
				}
				// Default FALSE — the non-admin Ballot Counter, which is the console's
				// own reason to exist. An admin default would make every case here an
				// admin case and the session arm would go untested.
				canManageClub={over.canManageClub ?? false}
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
		// The chip FILLS the field — it does not commit. Two outline chips above a
		// primary submit read as "pick a reason, then press Disqualify", so a chip
		// that wrote the ruling on tap invited the console's highest-consequence
		// mis-tap. Asserting the mutation has NOT fired yet is what pins that.
		await userEvent.click(
			speaker.getByRole("button", { name: DISQUALIFICATION_PRESETS[1] }),
		);
		expect(disqualifyCandidateFn).not.toHaveBeenCalled();
		expect(
			(speaker.getByLabelText(/Reason Bo can't win/) as HTMLInputElement).value,
		).toBe(DISQUALIFICATION_PRESETS[1]);

		await userEvent.click(speaker.getByRole("button", { name: "Disqualify" }));

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
		await userEvent.click(tt.getByRole("button", { name: "Disqualify" }));

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
		expect(await speaker.findByText(/3 votes excluded/)).toBeTruthy();
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

	// The open list must not be a leaderboard, and hiding the DIGITS is only half
	// of that. `loadTally` ranks `results` by count descending, so rendering its
	// order straight through kept the ranking: row one was the current leader and
	// the list reshuffled every 5s poll. The fixture here is deliberately NOT in
	// count order — the original test's was (`Ana 4, Bo 1`), which is exactly why
	// it could not see this.
	it("orders an OPEN category by name, not by live vote count", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Zoe", 9), member("m-2", "Abe", 1)],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		await speaker.findByText("Zoe");
		const names = speaker
			.getAllByRole("button", { name: /^Disqualify / })
			.map((b) => b.textContent);
		// Alphabetical. Count order would put Zoe first, and would move rows under
		// the cursor of a destructive control that has no confirm step.
		expect(names[0]).toContain("Abe");
		expect(names[1]).toContain("Zoe");
	});

	// AC 1: "any candidate in any category". A category closed before anyone
	// voted used to list no candidates at all, because the whole block was gated
	// on `total > 0` — so the one state where an early ruling is most likely is
	// the one where it was impossible.
	it("still offers the control on a CLOSED category with no votes", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: false,
					results: [member("m-1", "Ana", 0)],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		expect(
			await speaker.findByRole("button", { name: "Disqualify Ana" }),
		).toBeTruthy();
		// ...and no winner can be picked, because nobody voted.
		expect(speaker.queryByRole("button", { name: "Set winner" })).toBeNull();
	});

	// "N votes in" means how many people voted. `results` is eligible-only since
	// #723, so summing it alone made the number DROP when a ruling landed —
	// under-reporting participation, which is the one thing that line says.
	it("counts every ballot in the total, disqualified candidates included", async () => {
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
		expect(await speaker.findByText("5 votes in")).toBeTruthy();
	});

	// The zero case is the NORMAL one when the Vote Counter rules someone out
	// early — which is the whole reason the control is reachable while the vote
	// is open. "0 excluded" implies something was taken away and reads as a bug.
	it("says nothing was excluded when the ruling landed before any votes", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					disqualified: [
						{ ...member("m-2", "Bo", 0), reason: "Outside the window" },
					],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		expect(await speaker.findByText(/no votes to exclude/)).toBeTruthy();
		expect(speaker.queryByText(/0 votes excluded/)).toBeNull();
	});

	// A failed undo used to say NOTHING: the row stayed, the button re-enabled,
	// and "nothing happened" is indistinguishable from a slow poll. This is the
	// correction path for a ruling already announced to the room.
	it("surfaces a failed undo instead of silently leaving the row", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					disqualified: [
						{ ...member("m-2", "Bo", 1), reason: "Outside the window" },
					],
				}),
			}),
		);
		undoDisqualificationFn.mockRejectedValue(
			new Error("This meeting is completed."),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		await userEvent.click(
			await speaker.findByRole("button", {
				name: "Undo disqualification of Bo",
			}),
		);
		expect(await speaker.findByText(/This meeting is completed/)).toBeTruthy();
	});

	// `disqualify` is ONE mutation shared by every row, so its error outlives the
	// form that produced it. Without a reset, failing on Ana and then opening
	// Bo's form rendered Ana's rejection under Bo's name before anything was
	// typed — which mid-meeting reads as "Bo was refused too". Scoping the render
	// by category was the first attempt and was not enough: both are in one.
	it("does not show one candidate's rejection on another's form", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana"), member("m-2", "Bo")],
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
		await userEvent.click(speaker.getByRole("button", { name: "Disqualify" }));
		await speaker.findByText(/Only the Ballot Counter/);

		await userEvent.click(speaker.getByRole("button", { name: "Cancel" }));
		await userEvent.click(
			speaker.getByRole("button", { name: "Disqualify Bo" }),
		);
		expect(speaker.queryByText(/Only the Ballot Counter/)).toBeNull();
	});

	// Cancel is the only way out of a form that takes over its row, so a broken
	// one strands the Vote Counter mid-meeting with no way back to the list.
	it("Cancel closes the form without writing", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana")],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		await userEvent.click(
			await speaker.findByRole("button", { name: "Disqualify Ana" }),
		);
		await userEvent.click(speaker.getByRole("button", { name: "Cancel" }));
		expect(
			speaker.getByRole("button", { name: "Disqualify Ana" }),
		).toBeTruthy();
		expect(disqualifyCandidateFn).not.toHaveBeenCalled();
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
		await userEvent.click(speaker.getByRole("button", { name: "Disqualify" }));

		// The form STAYS open carrying the reason it failed for. A rejection that
		// closed the form would read as success — the candidate would simply not
		// be struck through, and on a 5s poll that is indistinguishable from a
		// slow round trip.
		expect(await speaker.findByText(/Only the Ballot Counter/)).toBeTruthy();
		expect(speaker.getByLabelText(/Reason Ana can't win/)).toBeTruthy();
	});
});

/**
 * The console affordance half of #752.
 *
 * The gate is the security boundary and refuses independently — that half is
 * `disqualify-session-gate.integration.test.ts`, and nothing here weakens it.
 * What these cases are about is the OTHER failure: an account-less Ballot
 * Counter reaching a control that cannot work and hitting a refusal mid-meeting
 * with the room watching, which converts a deliberate policy into what looks
 * like an outage — the surface #714 was filed about. ADR-0026 states it as a
 * rule: a control a session gates must not be SHOWN to a viewer without one, and
 * the state stays visible when the affordance goes.
 *
 * The prediction is exact rather than a proxy. `sessionMemberId` is the route's
 * `managerActorId` (`session?.id ?? null`) — the same value the server-side seam
 * computes — so client and server agree by construction rather than by a rule
 * somebody has to maintain. It is a SEPARATE prop from `selfMemberId`, which is
 * the localStorage name-pick and is non-null for exactly the caller being
 * refused.
 */
describe("VoteCounterPanel ruling controls need a session (#752)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// AC6.
	it("hides the Disqualify control and names the way out when there is no session", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana"), member("m-2", "Bo")],
				}),
			}),
		);
		renderPanel({ sessionMemberId: null });

		const speaker = card("Best Speaker");
		// The candidates are still THERE — only the affordance goes.
		expect(await speaker.findByText("Ana")).toBeTruthy();
		expect(speaker.getByText("Bo")).toBeTruthy();
		expect(speaker.queryAllByRole("button", { name: /^Disqualify / })).toEqual(
			[],
		);
		// Imported, not retyped: the console and the gate say ONE sentence, and a
		// literal here would let the two be reworded apart.
		expect(speaker.getByText(RULING_NEEDS_SESSION_MESSAGE)).toBeTruthy();
	});

	// AC7 — the inverse, and the half that stops "hide it always" from passing.
	it("renders the Disqualify control when there IS a session", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana"), member("m-2", "Bo")],
				}),
			}),
		);
		renderPanel();

		const speaker = card("Best Speaker");
		expect(
			await speaker.findAllByRole("button", { name: /^Disqualify / }),
		).toHaveLength(2);
		expect(speaker.queryByText(RULING_NEEDS_SESSION_MESSAGE)).toBeNull();
	});

	// UNDO is gated by the same server-fn pair and therefore by the same rule.
	// #752's acceptance criteria name only the Disqualify control, and leaving
	// Undo reachable would reproduce the exact failure those criteria exist to
	// prevent: a control that refuses, on a ruling already announced to the room,
	// with no way for the person holding the phone to tell policy from breakage.
	it("hides Undo too, and keeps the ruling itself visible", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					disqualified: [
						{
							...member("m-1", "Ana", 3),
							reason: "Spoke outside the qualifying window",
						},
					],
				}),
			}),
		);
		renderPanel({ sessionMemberId: null });

		const speaker = card("Best Speaker");
		// The record the room was told about is still on screen, with its reason
		// and its excluded count — this is a read the anonymous Ballot Counter
		// still needs in order to say that sentence out loud.
		expect(await speaker.findByText("Ana")).toBeTruthy();
		expect(
			speaker.getByText("Spoke outside the qualifying window"),
		).toBeTruthy();
		expect(speaker.getByText(/3 votes excluded/)).toBeTruthy();
		expect(
			speaker.queryAllByRole("button", { name: /^Undo disqualification/ }),
		).toEqual([]);
		expect(speaker.getByText(RULING_NEEDS_SESSION_MESSAGE)).toBeTruthy();
	});

	// The ADMIN ARM, and the reason `canManageClub` is a second prop rather than
	// folded into `sessionMemberId`.
	//
	// A `read_write` impersonating superadmin (ADR-0016 / #246) has full admin
	// parity server-side — `resolveAdminGrant` returns granted on the
	// impersonation, BEFORE the self-assert arm is reached — and has no
	// `effectiveMemberId`, so the route's `managerActorId` is null for them.
	// Predicting with that one proxy hid the controls from the one principal the
	// gate allows outright, and told them to sign in while signed in. Caught in
	// review here; #762's review caught the same shape in six places at once.
	// BOTH controls, and the fixture carries a `disqualified` row for that reason
	// alone. An earlier draft had only `results`, so it never reached the Undo
	// button — and gating Undo on `sessionMemberId !== null` while leaving
	// Disqualify on the full expression then SURVIVED the whole suite. That is
	// half the ADR-0016 regression this very test exists to prevent, so the
	// fixture has to be able to render both.
	it("keeps BOTH controls for a club admin with NO session member id (impersonation)", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana")],
					disqualified: [
						{ ...member("m-2", "Bo", 2), reason: "Did not use the word" },
					],
				}),
			}),
		);
		renderPanel({ sessionMemberId: null, canManageClub: true });

		const speaker = card("Best Speaker");
		expect(
			await speaker.findByRole("button", { name: "Disqualify Ana" }),
		).toBeTruthy();
		expect(
			speaker.getByRole("button", { name: "Undo disqualification of Bo" }),
		).toBeTruthy();
		expect(speaker.queryByText(RULING_NEEDS_SESSION_MESSAGE)).toBeNull();
	});

	// `reasonFor` is STATE, so it outlives the prop that opened the form. Found by
	// an adversarial review pass: the panel stays mounted when a session ends (the
	// route re-renders with `managerActorId` null), and the row's Disqualify button
	// would vanish while the form it opened stayed on screen with a live submit
	// path — the affordance ADR-0026 says must go, still reachable by the one
	// caller who already had it open.
	it("closes an OPEN reason form if the session goes away underneath it", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: true,
					results: [member("m-1", "Ana")],
				}),
			}),
		);
		const { rerender, qc } = renderPanel();

		const speaker = card("Best Speaker");
		await userEvent.click(
			await speaker.findByRole("button", { name: "Disqualify Ana" }),
		);
		expect(speaker.getByLabelText(/Reason Ana can't win/)).toBeTruthy();

		// The session ends. Same mounted component, new props.
		rerender(
			<QueryClientProvider client={qc}>
				<VoteCounterPanel
					meetingId={MEETING_ID}
					selfMemberId={SELF}
					sessionMemberId={null}
					canManageClub={false}
					onSetWinner={vi.fn()}
					onClearWinner={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		const after = card("Best Speaker");
		expect(after.queryByLabelText(/Reason Ana can't win/)).toBeNull();
		expect(after.queryAllByRole("button", { name: /^Disqualify / })).toEqual(
			[],
		);
		expect(after.getByText(RULING_NEEDS_SESSION_MESSAGE)).toBeTruthy();
		expect(disqualifyCandidateFn).not.toHaveBeenCalled();

		// And the row is CLEARED, not merely hidden. A session can come BACK —
		// `sessionMemberId` is `authClient.useSession()`'s answer — and hiding
		// alone leaves `reasonFor` set, so the grant returning would re-render a
		// blank form on a row nobody re-opened (the form's own text state went
		// with the unmount). Restoring the session is the only way to see the
		// difference between clearing and hiding.
		rerender(
			<QueryClientProvider client={qc}>
				<VoteCounterPanel
					meetingId={MEETING_ID}
					selfMemberId={SELF}
					sessionMemberId={SELF}
					canManageClub={false}
					onSetWinner={vi.fn()}
					onClearWinner={vi.fn()}
				/>
			</QueryClientProvider>,
		);
		const restored = card("Best Speaker");
		expect(
			await restored.findByRole("button", { name: "Disqualify Ana" }),
		).toBeTruthy();
		expect(restored.queryByLabelText(/Reason Ana can't win/)).toBeNull();
	});

	// The notice is positional, not global: it appears where the missing controls
	// would have been, and a card with nothing to rule on says nothing. Without
	// this the copy renders three times on an empty console, which is how a
	// well-meant explanation becomes noise nobody reads.
	it("says nothing on a card with no candidates and no rulings", async () => {
		getVoteTally.mockResolvedValue(tally({}));
		renderPanel({ sessionMemberId: null });

		expect(await screen.findByText("Best Speaker")).toBeTruthy();
		expect(screen.queryByText(RULING_NEEDS_SESSION_MESSAGE)).toBeNull();
	});

	// The five #510 capabilities stay reachable for this viewer. The console
	// losing its open/close button alongside the ruling one is the regression
	// #752 names, and it is one line away — gating the CARD rather than the
	// control.
	it("leaves Open/Close voting and Set winner alone", async () => {
		getVoteTally.mockResolvedValue(
			tally({
				best_speaker: category({
					isOpen: false,
					results: [member("m-1", "Ana", 4)],
				}),
			}),
		);
		renderPanel({ sessionMemberId: null });

		const speaker = card("Best Speaker");
		// Await the CANDIDATE, not the toggle: the open/close button renders from
		// the first paint with no tally at all, so awaiting it returns before the
		// query resolves and every assertion after it reads an empty card — a
		// green that says nothing.
		expect(await speaker.findByText(/^Ana/)).toBeTruthy();
		expect(speaker.getByRole("button", { name: /Open voting/ })).toBeTruthy();
		expect(speaker.getByRole("button", { name: "Set winner" })).toBeTruthy();
		expect(speaker.getByRole("button", { name: "Clear winner" })).toBeTruthy();
	});
});
