/**
 * The digital-voting switch is enforced, not just hidden (#770).
 *
 * Two source guards, beside the behaviour tests in
 * `voting.integration.test.ts` and `meeting-digital-voting.integration.test.ts`
 * that prove each gate holds today. These pin the SHAPE a future change could
 * break without failing those: a new voting write added without the gate, and
 * the meeting switch's server fn widened to the self-asserted Toastmaster.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/** Each `export async function` in `source`, sliced to the next top-level
 *  `export`. Comment-blind via `readSource`. */
function exportedFunctions(source: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^export async function (\w+)\(/gm;
	const starts = [...source.matchAll(re)];
	for (const m of starts) {
		const start = m.index ?? 0;
		const next = source.indexOf("\nexport ", start + 1);
		out.set(m[1] ?? "", source.slice(start, next === -1 ? undefined : next));
	}
	return out;
}

describe("every voting write that lets someone vote is gated on the switch", () => {
	const fns = exportedFunctions(readSource("src/server/voting-logic.ts"));

	/** DERIVED, not listed: a function that inserts a ballot, a vote session
	 *  or a ballot guest is a way to take part in a digital vote. The
	 *  disqualification writes only UPDATE or touch other tables, and must keep
	 *  working once voting is off.
	 *
	 *  `closeVoteTx` (the body of `closeVote`) is carved out BY NAME (#1472): when the category has no row
	 *  yet it inserts one that is already closed (`opened_at = closed_at = now`),
	 *  so nobody can vote through it, and a vote left open must stay closable
	 *  with digital voting off. The "closed-row shape" test below pins that, and that the
	 *  insert is refused outright for a club or meeting that does not accept votes. */
	const VOTING_INSERT =
		/\.insert\((meetingVotes|meetingVoteSessions|meetingBallotGuests)\)/;
	const participating = [...fns].filter(
		([name, body]) => name !== "closeVoteTx" && VOTING_INSERT.test(body),
	);

	it("finds the writers (not vacuous)", () => {
		expect(participating.map(([name]) => name).sort()).toEqual(
			expect.arrayContaining(["castVote", "joinBallotAsGuest", "openVote"]),
		);
	});

	for (const [name, body] of participating) {
		it(`${name} asks the digital-voting switch`, () => {
			expect(body).toMatch(/assertDigitalVotingOnTx\(|isDigitalVotingOnFor\(/);
		});
	}

	it("closeVote does NOT ask it — a vote left open must stay closable", () => {
		const body = fns.get("closeVote");
		expect(body).toBeDefined();
		expect(body).not.toMatch(
			/assertDigitalVotingOnTx\(|isDigitalVotingOnFor\(/,
		);
	});
});

describe("closeVoteTx's insert writes an already-closed row", () => {
	const body = exportedFunctions(readSource("src/server/voting-logic.ts")).get(
		"closeVoteTx",
	);

	// protects=a Close on a category with no row inserts a row that is ALREADY
	//   closed (closedAt the same `utcNow` as openedAt), so the carve-out in this
	//   file's "ways to vote" derivation is safe: nobody can vote through it;
	// fails_when=closedAt becomes null (an open row), or a window end such as
	//   the automatic window's closesAt (a row that stays open for votes);
	// no_claim=the runtime value (voting.integration.test.ts reads the row)
	it("sets openedAt and closedAt to the same instant", () => {
		expect(body).toBeDefined();
		const insert =
			/\.insert\(meetingVoteSessions\)\s*\.values\(\{([^}]*)\}\)/.exec(
				body ?? "",
			);
		expect(insert).not.toBeNull();
		expect(insert?.[1]).toMatch(/openedAt:\s*utcNow,/);
		expect(insert?.[1]).toMatch(/closedAt:\s*utcNow,/);
	});

	// protects=a Close on a club with digital voting off, or a meeting that does
	//   not accept votes, inserts no row (it would flip usesDigitalVoting and drop
	//   the paper tally from the packet); fails_when=the acceptsAutoVotes check
	//   is removed or moved after the insert; no_claim=the runtime (integration)
	it("returns before the insert unless the meeting accepts votes", () => {
		const check = (body ?? "").indexOf("acceptsAutoVotes");
		const insert = (body ?? "").indexOf(".insert(meetingVoteSessions)");
		expect(check).toBeGreaterThan(-1);
		expect(insert).toBeGreaterThan(check);
	});
});

describe("setMeetingDigitalVoting is signed-in club admins only", () => {
	const source = readSource("src/server/meetings.ts");
	const start = source.indexOf("export const setMeetingDigitalVoting =");
	const next = source.indexOf("\nexport ", start + 1);
	// `undefined`, never the raw -1: `slice(start, -1)` reads the -1 as an
	// offset from the END and silently drops the last character, which is the
	// shape of the false-pass `CODING_STANDARDS.md` records for guards that
	// compute offsets. Latent while another export follows this one.
	const body = source.slice(start, next === -1 ? undefined : next);

	it("finds the server fn", () => {
		expect(start).toBeGreaterThan(-1);
		expect(body).toContain("applyMeetingDigitalVoting(");
	});

	it("requires a session and the admin club role", () => {
		expect(body).toContain("await requireUser()");
		expect(body).toMatch(/requireClubRole\([^)]*\[\s*"admin",?\s*\]/);
	});

	it("takes no self-asserted identity", () => {
		expect(body).not.toContain("requireMeetingAgendaEditor(");
		expect(body).not.toContain("selfMemberId");
	});
});
