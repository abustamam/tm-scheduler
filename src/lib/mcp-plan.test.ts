import { describe, expect, it } from "vitest";
import { canonicalize, planHash } from "./mcp-plan";

const base = {
	tool: "record_guest_book",
	clubId: "11111111-1111-4111-8111-111111111111",
	userId: "user_abc",
	plan: {
		meetingId: "22222222-2222-4222-8222-222222222222",
		entries: [
			{ index: 0, outcome: "matched", guestId: "g1", name: "Jane Doe" },
			{ index: 1, outcome: "new", guestId: null, name: "Sam Ray" },
		],
	},
};

describe("canonicalize", () => {
	it("sorts object keys", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
		expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("sorts nested keys too", () => {
		expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
			'{"outer":{"a":2,"z":1}}',
		);
	});

	it("preserves array order — entries are identified by input index", () => {
		expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
		expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
	});

	it("distinguishes null from absent", () => {
		expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
	});

	it("distinguishes a number from its string form", () => {
		expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: "1" }));
	});

	it("renders a Date as an ISO string rather than {}", () => {
		// A plan is not supposed to carry timestamps (they are what makes a hash
		// unstable), but `JSON.stringify` on a bare Date inside a manual walk is a
		// classic silent `{}` — which would make two DIFFERENT dates hash the same.
		// Fail loudly-ish by at least distinguishing them.
		const a = canonicalize({ d: new Date("2026-09-17T00:00:00.000Z") });
		const b = canonicalize({ d: new Date("2026-09-18T00:00:00.000Z") });
		expect(a).not.toBe(b);
	});

	it("is stable across repeated calls", () => {
		expect(canonicalize(base)).toBe(canonicalize(base));
	});
});

describe("planHash", () => {
	it("is a 64-char lowercase hex sha256", () => {
		expect(planHash(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("gives the same hash for the same state", () => {
		expect(planHash(base)).toBe(planHash(structuredClone(base)));
	});

	it("is unchanged by key order anywhere in the plan", () => {
		const reordered = {
			userId: base.userId,
			plan: {
				entries: base.plan.entries.map((e) => ({
					name: e.name,
					guestId: e.guestId,
					outcome: e.outcome,
					index: e.index,
				})),
				meetingId: base.plan.meetingId,
			},
			clubId: base.clubId,
			tool: base.tool,
		};
		expect(planHash(reordered)).toBe(planHash(base));
	});

	it("changes when any plan value changes", () => {
		const changed = structuredClone(base);
		changed.plan.entries[1].outcome = "already_present";
		expect(planHash(changed)).not.toBe(planHash(base));
	});

	it("changes when an entry is added", () => {
		const changed = structuredClone(base);
		changed.plan.entries.push({
			index: 2,
			outcome: "new",
			guestId: null,
			name: "Ada L",
		});
		expect(planHash(changed)).not.toBe(planHash(base));
	});

	it("changes when the entries are reordered", () => {
		const changed = structuredClone(base);
		changed.plan.entries.reverse();
		expect(planHash(changed)).not.toBe(planHash(base));
	});

	// The hash is scoped to who is applying it and where. A plan hash handed to
	// a different tool, club or user must not validate — it is not a credential,
	// but it should not be portable either.
	it("changes with the tool, the club or the user", () => {
		expect(planHash({ ...base, tool: "assign_roles" })).not.toBe(
			planHash(base),
		);
		expect(planHash({ ...base, clubId: "other-club" })).not.toBe(
			planHash(base),
		);
		expect(planHash({ ...base, userId: "user_xyz" })).not.toBe(planHash(base));
	});
});
