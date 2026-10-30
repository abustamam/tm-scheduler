import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The five own-release entry points route a late drop through the cover sheet
 * (#1439, AC 4).
 *
 * ## Why a source guard
 *
 * The routes import `#/server/*` → `#/db` and cannot mount in vitest, and the
 * risk is a one-token regression that typechecks clean: a `releaseSlot(...)`
 * moved above the `opensCoverSheet(...)` check, or a handler that stops calling
 * it, drops a member's role with no cover ask, exactly as before the sheet
 * existed. Each entry point's OWN function is read from SOURCE (comment-blind,
 * `readSource`), never from a hand-typed copy of it: the guard fails when the
 * real handler stops consulting the gate before it writes.
 */
const SRC = (rel: string) =>
	readSource(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", rel));

/** The body of `function <name>(`, up to the next function declaration at any
 *  indent, so a neighbour's correct code cannot satisfy this one. */
function fnBody(source: string, name: string): string {
	const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
	if (start === -1) {
		throw new Error(
			`${name} not found: it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const rest = source.slice(start + 10);
	const next = rest.search(/\n\t*(?:async )?function \w+\(/);
	return next === -1 ? rest : rest.slice(0, next);
}

/** The gate is consulted, and BEFORE the immediate write. */
function expectGateBefore(body: string, gate: string, write: string) {
	const g = body.indexOf(gate);
	const w = body.indexOf(write);
	expect(g, `${gate} missing`).toBeGreaterThan(-1);
	expect(w, `${write} missing`).toBeGreaterThan(-1);
	expect(g, `${gate} must come before ${write}`).toBeLessThan(w);
}

const ENTRY_POINTS = [
	{
		name: "meeting page (via MeetingAgenda.doRelease)",
		file: "src/components/agenda/meeting-agenda.tsx",
		fn: "doRelease",
		gate: "onOwnLateRelease(slot)",
		write: "actions.release(",
	},
	{
		name: "/me",
		file: "src/routes/_authed/me.tsx",
		fn: "doRelease",
		gate: "opensCoverSheet(",
		write: "releaseSlot(",
	},
	{
		name: "club home",
		file: "src/routes/club.$clubId.index.tsx",
		fn: "doRelease",
		gate: "opensCoverSheet(",
		write: "releaseSlot(",
	},
	{
		name: "season grid cell",
		file: "src/components/club/season-grid.tsx",
		fn: "release",
		gate: "opensCoverSheet(",
		write: "releaseSlot(",
	},
	{
		name: "member role picker",
		file: "src/components/club/member-role-picker.tsx",
		fn: "act",
		gate: "onOwnLateRelease(o.slotId)",
		write: "releaseSlot(",
	},
] as const;

describe("own release inside 48h goes through the cover sheet (#1439)", () => {
	for (const e of ENTRY_POINTS) {
		it(`${e.name}: ${e.fn}() consults the gate before it releases`, () => {
			// protects=AC 4: this entry point cannot release a late own role
			//   without asking the sheet first
			// fails_when=the gate call is removed or moved below the write
			expectGateBefore(fnBody(SRC(e.file), e.fn), e.gate, e.write);
		});
	}

	it("the hosts of the sheet render it, and the agenda and picker are handed the opener", () => {
		// protects=the callbacks lead somewhere: a handler that opens a sheet no
		//   one renders would leave the role held with nothing on screen
		// fails_when=a host drops <CoverSheet, or a route stops passing the
		//   opener prop to the agenda / picker
		for (const file of [
			"src/routes/club.$clubId.meeting.$meetingId.tsx",
			"src/routes/_authed/me.tsx",
			"src/routes/club.$clubId.index.tsx",
			"src/components/club/season-grid.tsx",
		]) {
			expect(SRC(file), file).toContain("<CoverSheet");
		}
		expect(SRC("src/routes/club.$clubId.meeting.$meetingId.tsx")).toContain(
			"onOwnLateRelease={",
		);
		const grid = SRC("src/components/club/season-grid.tsx");
		expect(grid).toContain("<MemberRolePicker");
		expect(grid).toContain("onOwnLateRelease={");
	});

	it("the claim's Undo in the grid is not a drop", () => {
		// protects=Undo of a claim releases at once: it takes back your own tap
		//   seconds ago, so asking for cover would be absurd
		// fails_when=the afterClaim bypass is removed
		const body = fnBody(SRC("src/components/club/season-grid.tsx"), "release");
		expect(body).toMatch(/if \(!afterClaim\)/);
	});
});
