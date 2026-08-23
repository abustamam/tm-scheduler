/**
 * Unit tests for the rule that decides whether a member keeps a role they
 * claimed when their meeting's shape changes.
 *
 * Reachable as a plain unit test only because the rule lives in `lib/` rather
 * than beside its three callers, all of which import `#/db` at load — the
 * corollary CLAUDE.md records under "a constant defined in a module that
 * imports `#/db` is unassertable".
 */
import { describe, expect, it } from "vitest";
import { distinctRoleDefs, matchRoleDefs } from "./role-def-match";

const chair = { id: "old-chair", key: "contest_chair", name: "Contest Chair" };
const timer = { id: "old-timer", key: null, name: "Timer" };

describe("matchRoleDefs", () => {
	it("matches a keyed definition to the same key, ignoring the id", () => {
		const matched = matchRoleDefs(
			[chair],
			[{ id: "new-chair", key: "contest_chair", name: "Renamed By The Club" }],
		);
		expect(matched.get("old-chair")?.id).toBe("new-chair");
	});

	it("does NOT fall back to name for a keyed definition", () => {
		// The strict either/or. A keyed role the target no longer declares is
		// unmatched — guessing by name would keep a slot on a role the officer
		// deliberately removed and re-added under a different key.
		const matched = matchRoleDefs(
			[chair],
			[{ id: "new-chair", key: "other_key", name: "Contest Chair" }],
		);
		expect(matched.has("old-chair")).toBe(false);
	});

	it("matches an UNKEYED definition by case-insensitive name", () => {
		const matched = matchRoleDefs(
			[timer],
			[{ id: "new-timer", key: null, name: "TIMER" }],
		);
		expect(matched.get("old-timer")?.id).toBe("new-timer");
	});

	it("refuses an AMBIGUOUS name rather than picking one", () => {
		// Two target roles may legally share a name with different keys
		// (`addAgendaRole` allows it). An unordered `select()` decides which one
		// a naive map keeps, so this must match nothing at all.
		const matched = matchRoleDefs(
			[timer],
			[
				{ id: "a", key: "timer_a", name: "Timer" },
				{ id: "b", key: "timer_b", name: "Timer" },
			],
		);
		expect(matched.has("old-timer")).toBe(false);
	});

	it("returns only the entries that matched", () => {
		const matched = matchRoleDefs(
			[chair, timer],
			[{ id: "new-chair", key: "contest_chair", name: "Contest Chair" }],
		);
		expect([...matched.keys()]).toEqual(["old-chair"]);
	});

	it("keeps a target that carries no id, for the preview's benefit", () => {
		// `planTemplateConversion` matches against `meeting_template_roles`,
		// which have not been materialized and therefore have no
		// `role_definitions.id` yet. The generic must admit that shape, or the
		// preview cannot run the same rule the apply runs.
		const matched = matchRoleDefs(
			[chair],
			[{ key: "contest_chair", name: "Contest Chair", defaultCount: 1 }],
		);
		expect(matched.get("old-chair")?.defaultCount).toBe(1);
	});
});

describe("distinctRoleDefs", () => {
	it("collapses many slots of one role to a single definition", () => {
		const defs = distinctRoleDefs([
			{ roleDefinitionId: "d1", roleKey: "speaker", roleName: "Speaker" },
			{ roleDefinitionId: "d1", roleKey: "speaker", roleName: "Speaker" },
			{ roleDefinitionId: "d2", roleKey: null, roleName: "Timer" },
		]);
		expect(defs).toEqual([
			{ id: "d1", key: "speaker", name: "Speaker" },
			{ id: "d2", key: null, name: "Timer" },
		]);
	});
});
