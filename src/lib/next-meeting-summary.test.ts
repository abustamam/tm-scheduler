import { describe, expect, it } from "vitest";
import {
	type SummarySlot,
	signupUrlFor,
	summarizeRoles,
} from "./next-meeting-summary";

const s = (over: Partial<SummarySlot>): SummarySlot => ({
	id: "s",
	roleDefinitionId: "rd-timer",
	roleName: "Timer",
	roleKey: "timer",
	category: "functionary",
	isSpeakerRole: false,
	slotIndex: 0,
	assigneeName: null,
	speechTitle: null,
	projectLevel: null,
	minMinutes: null,
	maxMinutes: null,
	evaluatesSlotId: null,
	evaluates: null,
	...over,
});

describe("summarizeRoles (#932)", () => {
	it("groups a role's places together, in arrival (agenda) order", () => {
		const { roles } = summarizeRoles([
			s({
				roleDefinitionId: "rd-sp",
				roleName: "Speaker",
				roleKey: "speaker",
				assigneeName: "Ada",
			}),
			s({ roleDefinitionId: "rd-sp", roleName: "Speaker", roleKey: "speaker" }),
			s({
				roleDefinitionId: "rd-sp",
				roleName: "Speaker",
				roleKey: "speaker",
				assigneeName: "Bo",
			}),
			s({ assigneeName: "Cy" }),
		]);
		expect(roles).toEqual([
			{ label: "Speaker", names: ["Ada", "Bo"], openCount: 1 },
			{ label: "Timer", names: ["Cy"], openCount: 0 },
		]);
	});

	it("pulls the Toastmaster out by key, under the club's own name", () => {
		const { toastmaster, roles } = summarizeRoles([
			s({
				roleDefinitionId: "rd-tm",
				roleName: "Host",
				roleKey: "toastmaster_of_the_day",
			}),
			s({}),
		]);
		expect(toastmaster).toEqual({ label: "Host", names: [], openCount: 1 });
		expect(roles.map((r) => r.label)).toEqual(["Timer"]);
	});

	it("falls back to the name for a keyless Toastmaster", () => {
		const { toastmaster } = summarizeRoles([
			s({
				roleDefinitionId: "x",
				roleName: "Toastmaster of the Day",
				roleKey: null,
				assigneeName: "Di",
			}),
		]);
		expect(toastmaster?.names).toEqual(["Di"]);
	});

	it("keeps two roles a club named alike as two rows", () => {
		const { roles } = summarizeRoles([
			s({ roleDefinitionId: "a", roleName: "Helper" }),
			s({ roleDefinitionId: "b", roleName: "Helper" }),
		]);
		expect(roles).toHaveLength(2);
	});

	it("marks a guest the way every agenda surface does", () => {
		const { roles } = summarizeRoles([
			s({ assigneeName: "Eve", assigneeIsGuest: true }),
		]);
		expect(roles[0]?.names).toEqual(["Eve · Guest"]);
	});

	it("a contest with no Toastmaster leads with nobody", () => {
		expect(summarizeRoles([s({})]).toastmaster).toBeNull();
		expect(summarizeRoles([])).toEqual({ toastmaster: null, roles: [] });
	});
});

describe("signupUrlFor (#932)", () => {
	it("builds the next meeting's absolute public page URL", () => {
		expect(
			signupUrlFor("mcf", { urlKey: "2026-07-09-1830" }, "https://gavelup.app"),
		).toBe("https://gavelup.app/club/mcf/meeting/2026-07-09-1830");
	});

	it("is null until the origin is known — never a relative URL", () => {
		expect(signupUrlFor("mcf", { urlKey: "2026-07-09" }, null)).toBeNull();
		expect(signupUrlFor("mcf", { urlKey: "2026-07-09" }, "")).toBeNull();
	});

	it("is null with no next meeting", () => {
		expect(signupUrlFor("mcf", null, "https://gavelup.app")).toBeNull();
	});
});
