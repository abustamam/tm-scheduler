// The rail's role map is COMPUTED in the route, and this repo has shipped that
// exact bug before: #319 wired `isMember={shell}` on `club.$clubId.index.tsx`
// and every component test stayed green, because a component tested through its
// props cannot see a WRONG prop. The props ARE the fixture.
//
// Rendering this route to observe the expression is not reachable: it needs a
// QueryClientProvider, the identity gate, the commitments query and the whole
// SeasonGrid. So the gate is a source grep, the same shape
// `club-index-wiring.guard.test.ts` uses for the same reason.
//
// What it pins — one statement, and only one:
//  - the WHOLE STATEMENT `const panelRoleByMemberId = buildPanelRoleMap(slots);`
//    — not just that `buildPanelRoleMap(` appears, which this file shipped
//    once already and which a filtered argument at the call site also
//    satisfies (see the test's own comment for why that matters).
//
// What used to live here and does not anymore: the short-code keying, the
// `confirmed` polarity, and the base-vs-numbered role name were all source
// greps on the derivation's own expressions. Mutation review found two bugs
// that neither this file's five greps nor a clean typecheck could see: keying
// by the slot's own id would break the rail completely (no badge renders
// anywhere), and numbering codes off only the assigned slots would silently
// renumber the badges as the week's slots fill. A route-inline derivation is
// grep-guarded, and a grep can only catch what someone thought to write. The
// derivation moved to `buildPanelRoleMap` (`#/lib/attendance-panel`), a pure
// function vitest CAN call directly, and every one of those invariants —
// including the two the greps missed — is now a real assertion in
// `attendance-panel.test.ts`. This file no longer needs to know what is
// inside the map, only that the route builds one, unfiltered — where it then
// GOES is pinned next to the panel's other props, in the sibling named below.
//
// COMMENT-BLIND (`readSource`): every assertion is of the "this pattern must BE
// present" form, and this very file quotes the patterns it looks for — a raw
// read would pass on a commented-out wiring. See `src/test/guard-source.ts`.
//
// Split with `attendance-panel-wiring.guard.test.ts`: that file pins EVERY
// route→panel prop expression — phase gating, plan/roster wiring, the nudge
// draft, the lock, both write callbacks, layout, and `roleByMemberId` — each
// one scoped to a window sliced from the `<MeetingAttendancePanel` tag, since
// <MeetingAgenda> takes same-named props further up the same file. This file
// pins the CONSTRUCTION statement and nothing else, and asserts nothing about
// the call site. Both files carried a byte-identical
// `roleByMemberId={panelRoleByMemberId}` assertion until this split, while
// each header told the reader the OTHER one owned it; the hand-off now lives
// in one place, next to the props it sits among. What is INSIDE the map is
// `attendance-panel.test.ts`'s job.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, "./club.$clubId.meeting.$meetingId.tsx");

describe("attendance rail role wiring", () => {
	const src = readSource(ROUTE);

	it("builds the rail's map with the extracted, unit-tested function", () => {
		// The whole STATEMENT, not just the function name — `toContain("buildPanelRoleMap(")`
		// matches `buildPanelRoleMap(slots.filter((s) => s.assigneeId))` just as well as
		// the correct call, and that filtered argument is Critical 2's failure mode
		// living at the call site instead of inside the function: `buildShortCodes`
		// numbers a role off however many slots the ARGUMENT has, so filtering to
		// assigned slots renumbers every badge as the week's slots fill ("SP" today,
		// "SP1" once a second Speaker slot is claimed) with the unit tests unable to
		// see it — they test the function, and the function is correct. Pinning the
		// full statement closes the argument, the variable binding, and any wrapping
		// in one string.
		expect(src).toContain(
			"const panelRoleByMemberId = buildPanelRoleMap(slots);",
		);
	});
});
