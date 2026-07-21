import { describe, expect, it } from "vitest";
import { buildRecruitTargets } from "./nudge-recruit-picker";

const roster = [
	{ id: "a", name: "Ada", phone: "1", email: null },
	{ id: "b", name: "Bo", phone: null, email: null },
	{ id: "c", name: "Cy", phone: null, email: "cy@x.io" },
];

describe("buildRecruitTargets", () => {
	it("includes every member — never filters (annotate, not filter)", () => {
		const t = buildRecruitTargets(roster, new Set(), {});
		expect(t.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("flags members marked not available, leaves others unflagged", () => {
		const t = buildRecruitTargets(roster, new Set(["b"]), {});
		expect(t.find((x) => x.id === "b")?.notAvailable).toBe(true);
		expect(t.find((x) => x.id === "a")?.notAvailable).toBe(false);
	});

	it("flags the role a member already holds this meeting", () => {
		const t = buildRecruitTargets(roster, new Set(), { c: "Timer" });
		expect(t.find((x) => x.id === "c")?.alreadyRole).toBe("Timer");
		expect(t.find((x) => x.id === "a")?.alreadyRole).toBeNull();
	});

	it("carries contact through so the picker can show channels or no-contact", () => {
		const t = buildRecruitTargets(roster, new Set(), {});
		expect(t.find((x) => x.id === "b")).toMatchObject({
			phone: null,
			email: null,
		});
		expect(t.find((x) => x.id === "c")?.email).toBe("cy@x.io");
	});
});
