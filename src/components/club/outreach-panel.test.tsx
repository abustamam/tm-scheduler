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
});
