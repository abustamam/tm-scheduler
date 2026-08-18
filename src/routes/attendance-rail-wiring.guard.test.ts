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
//  - the route calls `buildPanelRoleMap(` — the wiring itself, invisible to
//    vitest no matter how the map is built.
//  - that the PANEL receives the result. `roleByMemberId` (the plain string
//    map) still exists for <MeetingAgenda>, so passing the wrong one is one
//    character away and typechecks only until the shapes diverge (#319 again).
//
// What used to live here and does not anymore: the short-code keying, the
// `confirmed` polarity, and the base-vs-numbered role name were all source
// greps on the derivation's own expressions. Mutation review found two bugs
// that would break the rail completely (keying by the slot's own id, and
// numbering codes off only the assigned slots) neither this file's five
// greps nor a clean typecheck could see — a route-inline derivation is
// grep-guarded, and a grep can only catch what someone thought to write. The
// derivation moved to `buildPanelRoleMap` (`#/lib/attendance-panel`), a pure
// function vitest CAN call directly, and every one of those invariants —
// including the two the greps missed — is now a real assertion in
// `attendance-panel.test.ts`. This file no longer needs to know what is
// inside the map, only that the route builds one and hands it to the panel.
//
// COMMENT-BLIND (`readSource`): every assertion is of the "this pattern must BE
// present" form, and this very file quotes the patterns it looks for — a raw
// read would pass on a commented-out wiring. See `src/test/guard-source.ts`.
//
// Split with `attendance-panel-wiring.guard.test.ts`: that file pins the
// panel's OTHER props (phase gating, plan/roster wiring, layout, the write
// paths) — everything about the route EXCEPT how the role map itself is
// built. This file is the map's wiring only; its construction is
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
		expect(src).toContain("buildPanelRoleMap(");
	});

	it("hands the PANEL the rich map, not the agenda's string map", () => {
		expect(src).toContain("roleByMemberId={panelRoleByMemberId}");
	});
});
