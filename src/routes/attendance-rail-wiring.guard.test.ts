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
// What it pins, and why each one:
//  - `buildShortCodes` is the SEASON GRID's function. Hand-rolling codes here is
//    the failure this is really guarding: the rail would look right and disagree
//    with the sign-up sheet.
//  - the `confirmed` polarity. `s.status === "claimed"` typechecks, renders, and
//    silently marks unconfirmed members as attending.
//  - that the PANEL receives the rich map. `roleByMemberId` (the plain
//    string map) still exists for <MeetingAgenda>, so passing the wrong one is
//    one character away and typechecks only until the shapes diverge.
//  - the `shortCodes` lookup key includes `:${s.slotIndex}`. Keying on
//    `roleDefinitionId` alone typechecks and renders "?" on every badge.
//  - `roleName: s.roleName`, not `slotLabel(s, roleCounts)`. The numbered
//    label ("Speaker 1") belongs to the agenda, not the outreach draft.
//
// COMMENT-BLIND (`readSource`): every assertion is of the "this pattern must BE
// present" form, and this very file quotes the patterns it looks for — a raw
// read would pass on a commented-out wiring. See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, "./club.$clubId.meeting.$meetingId.tsx");

describe("attendance rail role wiring", () => {
	const src = readSource(ROUTE);

	it("builds the rail's codes with the sign-up sheet's own function", () => {
		expect(src).toContain("buildShortCodes(");
		expect(src).toContain("panelRoleByMemberId");
	});

	it("reads `confirmed` from the slot status, with the right polarity", () => {
		expect(src).toContain('confirmed: s.status === "confirmed"');
	});

	it("hands the PANEL the rich map, not the agenda's string map", () => {
		expect(src).toContain("roleByMemberId={panelRoleByMemberId}");
	});

	it("keys the code lookup by slot, not just by role definition", () => {
		// Dropping `:${slotIndex}` makes every badge on the rail render "?" — it
		// typechecks, and the route does not mount in jsdom, so nothing else in the
		// repo can see it. This is the single load-bearing expression here.
		expect(src).toContain(
			"shortCodes.get(`${s.roleDefinitionId}:${s.slotIndex}`)",
		);
	});

	it("drafts with the BASE role name, not the numbered label", () => {
		// `roleName: slotLabel(s, roleCounts)` typechecks and sends "just confirming
		// you're our Speaker 1", which reads as a mail merge. The panel's own tests
		// cannot catch it — they are fed this value as a prop.
		expect(src).toContain("roleName: s.roleName,");
	});
});
