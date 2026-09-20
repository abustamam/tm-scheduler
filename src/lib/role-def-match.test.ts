/**
 * Unit tests for role identity: how a role's `key` is derived, and the rule
 * that decides whether a member keeps a role they claimed when their meeting's
 * shape changes.
 *
 * Reachable as a plain unit test only because the rule lives in `lib/` rather
 * than beside its three callers, all of which import `#/db` at load — the
 * corollary CLAUDE.md records under "a constant defined in a module that
 * imports `#/db` is unassertable".
 */
import { describe, expect, it } from "vitest";
import {
	deriveRoleKey,
	distinctRoleDefs,
	matchRoleDefs,
} from "./role-def-match";

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

describe("deriveRoleKey", () => {
	it("slugifies a name to snake_case", () => {
		expect(deriveRoleKey("Zoom Master", new Set())).toBe("zoom_master");
	});

	it("collapses runs of non-alphanumerics and trims the ends", () => {
		// Every non `[a-z0-9]` becomes `_`, so punctuation and accents alike are
		// separators rather than characters. The migration's SQL reproduces this
		// rule character for character, which is why it is stated here rather
		// than left to a snapshot.
		expect(deriveRoleKey("  Zoom — Master!! ", new Set())).toBe("zoom_master");
		expect(deriveRoleKey("Sergeant-at-Arms", new Set())).toBe(
			"sergeant_at_arms",
		);
	});

	it("falls back to `role` when nothing survives", () => {
		expect(deriveRoleKey("!!!", new Set())).toBe("role");
		expect(deriveRoleKey("", new Set())).toBe("role");
	});

	it("suffixes until free, skipping a taken suffix too", () => {
		// `taken` is the CLUB's keys (#801) — `role_definitions_club_key_unique`
		// is what binds, not a template's own index. A caller that passed one
		// template's keys would derive a key already held elsewhere in the club
		// and the insert would fail at the database.
		expect(deriveRoleKey("Timer", new Set(["timer"]))).toBe("timer_2");
		expect(deriveRoleKey("Timer", new Set(["timer", "timer_2"]))).toBe(
			"timer_3",
		);
	});

	it("is case-insensitive about the name but not about the taken set", () => {
		expect(deriveRoleKey("TIMER", new Set())).toBe("timer");
		// Keys are always lower-case, so an upper-case entry in `taken` is not a
		// collision — stated so the rule is not mistaken for a fold.
		expect(deriveRoleKey("Timer", new Set(["TIMER"]))).toBe("timer");
	});
});
