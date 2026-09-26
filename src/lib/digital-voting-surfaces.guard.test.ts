/**
 * No surface builds a ballot URL of its own (#770).
 *
 * A QR the digital-voting switch cannot reach is the bug this feature exists
 * to prevent, and it is one template literal away: every route that showed a
 * ballot QR used to spell `/club/${…}/meeting/${…}/vote` inline. They now ask
 * `ballotUrlFor`, which answers null when the meeting runs no digital vote.
 * This sweeps the WHOLE source tree for the literal rather than listing the
 * three routes known today, so a fourth surface fails here on the day it is
 * written instead of printing a QR on a paper-ballot club's agenda.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** A ballot path built from interpolated keys. */
const BALLOT_URL_LITERAL = /meeting\/\$\{[^}]+\}\/vote/;

/**
 * RAW, not `readSource`. This is an "the offender list must be empty" sweep,
 * and `src/test/guard-source.ts` says those must not strip comments: there a
 * comment can only cause a false FAILURE, never a false pass, so stripping
 * would LOOSEN the guard. Two files in the tree comment the URL's shape in
 * prose; neither interpolates it, so neither matches. The must-be-PRESENT
 * halves below keep reading comment-blind, where a comment WOULD be a bypass.
 */
const raw = (file: string) => readFileSync(file, "utf8");
const THE_SEAM = join("src", "lib", "digital-voting.ts");

describe("ballot URLs come only from ballotUrlFor (#770)", () => {
	const files = sourceFiles("src");

	it("sweeps a real tree, and the seam itself still builds one (not vacuous)", () => {
		expect(files.length).toBeGreaterThan(100);
		expect(readSource(THE_SEAM)).toMatch(BALLOT_URL_LITERAL);
	});

	it("no other source file spells a ballot URL", () => {
		const offenders = files.filter(
			(f) => f !== THE_SEAM && BALLOT_URL_LITERAL.test(raw(f)),
		);
		expect(offenders).toEqual([]);
	});

	/** Comment-blind: these are must-be-PRESENT checks, where a comment naming
	 *  the call would be a bypass. The print route is not on this list since
	 *  #913 — see the describe below. */
	it("each route that shows a ballot QR asks the seam, with the RESOLVED answer", () => {
		for (const route of [
			"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
			"src/routes/club.$clubId.meeting.$meetingId.tsx",
		]) {
			// The FIRST argument, not merely the call: `ballotUrlFor` answers null
			// only for the argument it is given, so a route passing `true`, or the
			// club's half (`clubDigitalVotingEnabled`) instead of the resolved
			// `digitalVoting`, would print a QR on a meeting that switched it off
			// and satisfy a bare "calls the seam" assertion.
			expect(readSource(route), route).toMatch(
				/ballotUrlFor\(\s*(data\.)?digitalVoting,/,
			);
		}
	});
});

/**
 * The printed agenda's QR is the meeting page, not the ballot (#913).
 *
 * The print route used to be the third entry in the list above. Its code now
 * opens the meeting page "in the room" (`meetingHubUrlFor`), printed whether or
 * not the club votes on phones — the page's strip shows Vote only while a
 * category is open, and no category opens with digital voting off, so the
 * voting switch still reaches the one tap that matters. That makes the print
 * route the one surface where a ballot URL would now be WRONG rather than
 * merely ungated, so this pins both halves: it asks the hub seam, and it does
 * not ask the ballot one. The "no other file spells a ballot URL" sweep above
 * still covers it, so an inline `/vote` literal fails there.
 */
describe("the printed agenda encodes the meeting page, not the ballot (#913)", () => {
	const PRINT_ROUTE = "src/routes/club.$clubId_.meeting.$meetingId.print.tsx";

	it("builds its QR with meetingHubUrlFor and hands it to the layouts as qrUrl", () => {
		const source = readSource(PRINT_ROUTE);
		expect(source).toMatch(/meetingHubUrlFor\(/);
		expect(source).toMatch(/qrUrl=\{qrUrl/);
	});

	// RAW, like the offender sweep above: a must-be-ABSENT check, where
	// stripping comments could only loosen it.
	it("no longer builds a ballot URL at all", () => {
		expect(raw(PRINT_ROUTE)).not.toMatch(/ballotUrlFor\(/);
	});
});

/**
 * The Ballot Counter console's own gating (#770).
 *
 * The meeting route is 2,000 lines and needs a router, a query client and a
 * mocked `#/db` to mount, so this pins the SHAPE in source instead: the vote
 * panel sits inside the switch's conditional and the Table Topics capture sits
 * OUTSIDE it, above. That second half is the one a reader gets wrong — the
 * minutes and the guest pipeline read those speakers, so a paper-ballot club
 * must keep recording them. Order-based, which is weaker than mounting the
 * component: it proves the capture is not inside the conditional that begins
 * after it, not that some future second conditional could not wrap it.
 */
describe("the console keeps Table Topics capture when voting is off", () => {
	const source = readSource("src/routes/club.$clubId.meeting.$meetingId.tsx");
	const gate = source.indexOf("{digitalVoting ? (");
	const capture = source.indexOf("<TableTopicsCapture");
	const panel = source.indexOf("<VoteCounterPanel");

	it("finds all three (not vacuous)", () => {
		expect(gate, "no `{digitalVoting ? (` gate").toBeGreaterThan(-1);
		expect(capture, "no <TableTopicsCapture").toBeGreaterThan(-1);
		expect(panel, "no <VoteCounterPanel").toBeGreaterThan(-1);
	});

	it("gates the vote panel on the switch", () => {
		expect(panel).toBeGreaterThan(gate);
	});

	it("leaves the Table Topics capture outside the gate", () => {
		expect(capture).toBeLessThan(gate);
	});
});
