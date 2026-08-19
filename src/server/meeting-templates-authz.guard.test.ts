/**
 * Source guard for the agenda-template server fns.
 *
 * Exists because `public-readers-archive-gate.guard.test.ts` had to WAIVE these
 * two fns: its sweep looks for a `require*` call inside the fn body and cannot
 * see through `requireMeetingTemplateEditor`. A waiver is a claim, and an
 * unchecked claim is exactly how #560's 24 gated readers ended up serving an
 * archived club — so the claim is pinned here instead.
 *
 * Read COMMENT-BLIND (`readSource`): every assertion below is "this pattern must
 * BE present", which a comment merely naming the pattern would falsely satisfy.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/meeting-templates.ts");

/** The fn bodies, split on the export boundary. */
function chunks(): string[] {
	return SOURCE.split("export const").slice(1);
}

describe("meeting template server fns", () => {
	it("routes every fn through a gate that resolves a session", () => {
		const all = chunks();
		expect(all.length).toBeGreaterThan(0);
		for (const chunk of all) {
			const gated =
				chunk.includes("requireMeetingTemplateEditor") ||
				(chunk.includes("requireUser") && chunk.includes("requireClubRole"));
			expect(gated, `ungated server fn: ${chunk.slice(0, 60)}`).toBe(true);
		}
	});

	it("asserts the club is not archived on every fn", () => {
		for (const chunk of chunks()) {
			const gated =
				chunk.includes("requireMeetingTemplateEditor") ||
				chunk.includes("assertClubNotArchived");
			expect(gated, `no archive gate: ${chunk.slice(0, 60)}`).toBe(true);
		}
	});

	it("keeps the shared helper's three gates intact", () => {
		// The waiver in public-readers-archive-gate names this helper by hand.
		// If any of these three is dropped, that waiver silently becomes false.
		const helper = SOURCE.slice(
			SOURCE.indexOf("async function requireMeetingTemplateEditor"),
		).split("\n}")[0];
		expect(helper).toContain("requireUser");
		expect(helper).toContain("assertClubNotArchived");
		expect(helper).toContain(
			'requireClubRole(user.id, meeting.clubId, ["admin"])',
		);
	});

	it("exports only server fns and types", () => {
		// The server-module rule: a plain top-level db-touching export here would
		// drag `#/db` -> `pg` -> `Buffer` into the client bundle.
		const exportLines = SOURCE.split("\n").filter((l) =>
			l.startsWith("export "),
		);
		for (const line of exportLines) {
			const ok =
				line.startsWith("export const") ||
				line.startsWith("export type") ||
				line.startsWith("export interface");
			expect(ok, `unexpected export: ${line}`).toBe(true);
		}
		for (const line of exportLines.filter((l) =>
			l.startsWith("export const"),
		)) {
			expect(line).toContain("createServerFn");
		}
	});

	it("validates input with a function, matching this repo's call shape", () => {
		// `.validator(schema)` is not how any other server fn here is written
		// (`role-definitions.ts:26` passes a function).
		expect(SOURCE).toContain(".validator((input: unknown) =>");
		expect(SOURCE).not.toMatch(/\.validator\([a-zA-Z]+\)/);
	});
});
