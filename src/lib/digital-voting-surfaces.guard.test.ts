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
import { readdirSync, statSync } from "node:fs";
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

/** A ballot path built from interpolated keys. Comment-blind (`readSource`),
 *  so the doc comments that describe the URL's shape do not count. */
const BALLOT_URL_LITERAL = /meeting\/\$\{[^}]+\}\/vote/;
const THE_SEAM = join("src", "lib", "digital-voting.ts");

describe("ballot URLs come only from ballotUrlFor (#770)", () => {
	const files = sourceFiles("src");

	it("sweeps a real tree, and the seam itself still builds one (not vacuous)", () => {
		expect(files.length).toBeGreaterThan(100);
		expect(readSource(THE_SEAM)).toMatch(BALLOT_URL_LITERAL);
	});

	it("no other source file spells a ballot URL", () => {
		const offenders = files.filter(
			(f) => f !== THE_SEAM && BALLOT_URL_LITERAL.test(readSource(f)),
		);
		expect(offenders).toEqual([]);
	});

	it("each route that shows a ballot QR asks the seam", () => {
		for (const route of [
			"src/routes/club.$clubId_.meeting.$meetingId.print.tsx",
			"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
			"src/routes/club.$clubId.meeting.$meetingId.tsx",
		]) {
			expect(readSource(route), route).toContain("ballotUrlFor(");
		}
	});
});
