// Route→component wiring pin for the own-card "marked absent" wording (#1344).
//
// `<MeetingAgenda>` says "You're marked absent." on the viewer's own card only
// for ids in `markedAbsentMemberIds`, and the route is the only place that list
// is made: `unavailableMemberIds` minus the members the PUBLIC `answeredRungs`
// shows as `not_coming`. A component test injects the prop itself, so it proves
// the component right about an answer the route may never give it.
//
// What this guards: the list stays derived from those two public values, never
// from the roll or a new payload field (the loader payload reaches signed-out
// readers; the roll is members-only), and reaches the ONE `<MeetingAgenda>` call
// site. Two same-typed values are in scope there and would each type-check:
// `unavailableMemberIds` (every unavailable member, so the copy would say "you
// said" for a roll-marked holder and the fix would be a no-op) and
// `contactedMemberIds`.
//
// COMMENT-BLIND (`readSource`): every assertion is "must BE present", and the
// route explains this derivation in prose right beside it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("meeting marked-absent wiring (#1344)", () => {
	const src = readSource(ROUTE);

	// The agenda's own attribute list, sliced out so the prop assertion is
	// POSITIONAL: `unavailableMemberIds={unavailableMemberIds}` also appears on
	// two sibling components, and a whole-file match would be satisfied by them.
	const tagAt = src.indexOf("<MeetingAgenda");
	const tagEnd = src.indexOf("/>", tagAt);
	const agendaProps = src.slice(tagAt, tagEnd);

	it("finds the agenda's call site at all", () => {
		expect(
			tagAt,
			"expected a <MeetingAgenda … /> call site in the route",
		).toBeGreaterThan(-1);
		expect(tagEnd, "expected the element to be self-closing").toBeGreaterThan(
			tagAt,
		);
		// Non-vacuity: the slice is this one element, not the rest of the file.
		expect(agendaProps.length).toBeLessThan(4000);
		expect(src.indexOf("<MeetingAgenda", tagAt + 1)).toBe(-1);
	});

	it("hands the derived list to the agenda", () => {
		expect(agendaProps).toContain(
			"markedAbsentMemberIds={markedAbsentMemberIds}",
		);
	});

	it("derives it from unavailableMemberIds minus the public not_coming answers", () => {
		expect(src).toMatch(
			/const markedAbsentMemberIds = unavailableMemberIds\.filter\(\s*\(id\) =>\s*!answeredRungs\.some\(\s*\(r\) => r\.memberId === id && r\.status === "not_coming",?\s*\),?\s*\);/,
		);
	});
});
