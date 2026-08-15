import { describe, expect, it } from "vitest";
import { deriveOutreach } from "./outreach-panel";

describe("deriveOutreach", () => {
	const roster = [
		{ id: "a", name: "Alice" },
		{ id: "b", name: "Bob" },
		{ id: "c", name: "Carol" },
		{ id: "d", name: "Dan" },
	];

	it("buckets members: assigned excluded, contacted vs not", () => {
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["b"]),
			unavailableIds: new Set(),
		});
		expect(r.assignedCount).toBe(1);
		expect(r.unavailableCount).toBe(0);
		expect(r.contacted.map((m) => m.id)).toEqual(["b"]);
		expect(r.notContacted.map((m) => m.id)).toEqual(["c", "d"]);
	});

	it("an assigned member is never listed even if also contacted", () => {
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["a"]),
			unavailableIds: new Set(),
		});
		expect(r.contacted).toEqual([]);
		expect(r.notContacted.map((m) => m.id)).toEqual(["b", "c", "d"]);
	});

	it("never asks you to chase someone who marked themselves unavailable (#376)", () => {
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["b"]),
			unavailableIds: new Set(["c"]),
		});
		expect(r.notContacted.map((m) => m.id)).toEqual(["d"]);
		expect(r.contacted.map((m) => m.id)).toEqual(["b"]);
		expect(r.unavailableCount).toBe(1);
		// The roster arithmetic still adds up: 1 assigned · 1 contacted · 1 to ask
		// · 1 unavailable === 4 active members.
		expect(
			r.assignedCount +
				r.contacted.length +
				r.notContacted.length +
				r.unavailableCount,
		).toBe(roster.length);
	});

	it("drops an unavailable member from the contacted list too (#376)", () => {
		// They were asked before they marked themselves out; the contact record is
		// moot now, and the panel is a to-do list, not a history.
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(),
			contactedIds: new Set(["b"]),
			unavailableIds: new Set(["b"]),
		});
		expect(r.contacted).toEqual([]);
		expect(r.unavailableCount).toBe(1);
		expect(r.notContacted.map((m) => m.id)).toEqual(["a", "c", "d"]);
	});

	it("counts an assigned member as assigned even when also unavailable (#376)", () => {
		// They're filling a role — that outranks the availability flag, and it
		// keeps the counts from double-counting one person.
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(),
			unavailableIds: new Set(["a"]),
		});
		expect(r.assignedCount).toBe(1);
		expect(r.unavailableCount).toBe(0);
		expect(r.notContacted.map((m) => m.id)).toEqual(["b", "c", "d"]);
	});

	it("never asks you to chase someone who said they're coming", () => {
		// The three former booleans became one status, and `coming` matches
		// NEITHER `unavailableIds` (`not_coming` only) nor `contactedIds`
		// (`reached_out` only) — so before this bucket existed, the member with the
		// most useful answer in the system fell through to "still to ask".
		//
		// Reachable without the new write surface: self-claiming a role records
		// `coming`, and releasing the slot leaves the plan row alone, so a
		// claim-then-release member lands here holding no role.
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["b"]),
			unavailableIds: new Set(["c"]),
			comingIds: new Set(["d"]),
		});
		expect(r.notContacted).toEqual([]);
		expect(r.comingCount).toBe(1);
		expect(r.contacted.map((m) => m.id)).toEqual(["b"]);
		// Same arithmetic check as the #376 case: every active member is accounted
		// for exactly once, so a member cannot be silently dropped rather than
		// re-bucketed.
		expect(
			r.assignedCount +
				r.contacted.length +
				r.notContacted.length +
				r.unavailableCount +
				r.comingCount,
		).toBe(roster.length);
	});

	it("counts an assigned member as assigned even when also coming", () => {
		// Bucket precedence, same reason as the unavailable case: holding a role
		// outranks the answer, so nobody is counted twice.
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(),
			unavailableIds: new Set(),
			comingIds: new Set(["a"]),
		});
		expect(r.assignedCount).toBe(1);
		expect(r.comingCount).toBe(0);
		expect(r.notContacted.map((m) => m.id)).toEqual(["b", "c", "d"]);
	});

	it("omitting comingIds leaves every existing bucket unchanged", () => {
		// The prop is optional so no existing caller or fixture had to change. That
		// only stays safe if absence behaves exactly like an empty set — otherwise
		// a caller that has not been updated silently re-buckets its roster.
		const withOut = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["b"]),
			unavailableIds: new Set(["c"]),
		});
		const withEmpty = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["b"]),
			unavailableIds: new Set(["c"]),
			comingIds: new Set(),
		});
		expect(withOut).toEqual(withEmpty);
		expect(withOut.comingCount).toBe(0);
		expect(withOut.notContacted.map((m) => m.id)).toEqual(["d"]);
	});
});
