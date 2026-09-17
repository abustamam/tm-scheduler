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
	 *  or a ballot guest is a way to take part in a digital vote. `closeVote`
	 *  and the disqualification writes only UPDATE or touch other tables, and
	 *  must keep working once voting is off. */
	const VOTING_INSERT =
		/\.insert\((meetingVotes|meetingVoteSessions|meetingBallotGuests)\)/;
	const participating = [...fns].filter(([, body]) => VOTING_INSERT.test(body));

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
