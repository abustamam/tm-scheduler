import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Structural authz guard for the planned-attendance writers (D6, 2026-08-11).
 *
 * `setPlannedAttendance` / `clearPlannedAttendance` are `createServerFn`
 * handlers, and a handler body cannot be invoked outside a request context in
 * vitest — `attendance-plan-logic.integration.test.ts` exercises the db seam
 * directly and therefore bypasses `requireClubRole`, `assertMeetingNotLocked`,
 * `assertClubNotArchived` and the self-only rule entirely. Nothing else in the
 * suite can see this wiring, so it is asserted against the real source, the
 * same way `outreach-authz.guard.test.ts` guards the writers this pair
 * replaces.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`):
 *
 *  · "the gate must BE present" → comment-blind. This module documents its own
 *    gating in prose, so a raw read would keep passing after the real call was
 *    deleted — a false PASS, the bypass `public-disclaimer.guard.test.ts`
 *    actually shipped.
 *  · "the payload's club must be ABSENT" → verbatim. Stripping only deletes
 *    text, and the stripper is a lexer: a `//` inside a string blanks the rest
 *    of the line and could erase a real offending call.
 */
const FILE = resolve(__dirname, "attendance-plan.ts");
/** Comment-blind — for "must BE present" only. */
const SRC = readSource(FILE);
/** Verbatim — for "must be ABSENT" only. */
const RAW = readFileSync(FILE, "utf8");

/** One `export const <name> = createServerFn…` declaration, so a per-handler
 *  assertion cannot be satisfied by its neighbour's correct code. */
function handlerBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in attendance-plan.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport const", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

const HANDLERS = ["setPlannedAttendance", "clearPlannedAttendance"];

describe("attendance-plan authz (D6)", () => {
	it("gates the officer path on requireClubRole(admin)", () => {
		// Whitespace-tolerant: the formatter wraps this call across lines.
		expect(SRC).toMatch(
			/requireClubRole\(\s*user\.id,\s*args\.clubId,\s*\[\s*["']admin["'],?\s*\]/,
		);
	});

	it("never gates a write on the member role", () => {
		expect(SRC).not.toMatch(/requireClubRole\([^)]*\[\s*["']member["'],?\s*\]/);
	});

	for (const fn of HANDLERS) {
		it(`${fn} derives the club from the meeting, never from the payload`, () => {
			// #396: gating on a client-supplied clubId lets an admin of club A act
			// on club B's meeting and file the row under A.
			const body = handlerBody(SRC, fn);
			expect(body).toContain("await loadMeeting(data.meetingId)");
			expect(body).toContain("clubId: meeting.clubId");
		});

		it(`${fn} asserts the meeting is not locked`, () => {
			expect(handlerBody(SRC, fn)).toContain(
				"assertMeetingNotLocked(meeting.status)",
			);
		});

		it(`${fn} resolves the actor through the shared self-only gate`, () => {
			expect(handlerBody(SRC, fn)).toContain("await resolveActor(");
		});
	}

	it("rejects a member setting someone else's row", () => {
		expect(SRC).toContain("throw new Error(SELF_ONLY_MESSAGE)");
	});

	it("gates the session-less path on the club's archived_at", () => {
		// The anonymous roster-pick identity is the dominant path here, so
		// `requireMembership`'s archive check (#186) never runs for it (#555).
		expect(SRC).toContain("await assertClubNotArchived(args.clubId)");
	});

	it("never reads the club from the request payload", () => {
		expect(
			RAW,
			"the club must come from the meeting row (#396) — a payload clubId is not evidence of anything",
		).not.toContain("data.clubId");
	});
});
