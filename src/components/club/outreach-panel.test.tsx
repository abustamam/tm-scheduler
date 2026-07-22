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
		});
		expect(r.assignedCount).toBe(1);
		expect(r.contacted.map((m) => m.id)).toEqual(["b"]);
		expect(r.notContacted.map((m) => m.id)).toEqual(["c", "d"]);
	});

	it("an assigned member is never listed even if also contacted", () => {
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["a"]),
		});
		expect(r.contacted).toEqual([]);
		expect(r.notContacted.map((m) => m.id)).toEqual(["b", "c", "d"]);
	});
});
