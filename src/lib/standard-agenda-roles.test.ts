import { describe, expect, it } from "vitest";
import { type BankRole, declareStandardRoles } from "./standard-agenda-roles";

/** A club role the club runs, overridable. */
function role(key: string | null, over: Partial<BankRole> = {}): BankRole {
	return {
		key,
		name: key ?? "Legacy",
		category: "functionary",
		defaultCount: 2,
		isSpeakerRole: false,
		slotsUnordered: false,
		standing: true,
		enabled: true,
		...over,
	};
}

describe("declareStandardRoles (#910)", () => {
	it("declares a beat-named role the club runs at the club's own count and name", () => {
		expect(
			declareStandardRoles(["speaker"], [role("speaker", { name: "Orator" })]),
		).toEqual([
			{
				key: "speaker",
				name: "Orator",
				category: "functionary",
				defaultCount: 2,
				isSpeakerRole: false,
				slotsUnordered: false,
				sortOrder: 0,
			},
		]);
	});

	it("gives a beat-named role the club does NOT run no places, but keeps the declaration", () => {
		for (const bank of [
			[role("speaker", { enabled: false })],
			[role("speaker", { standing: false })],
			[],
		]) {
			const [out] = declareStandardRoles(["speaker"], bank);
			expect(out?.key).toBe("speaker");
			expect(out?.defaultCount).toBe(0);
		}
		// Absent: the key stands in for the name, so the row still prints.
		expect(declareStandardRoles(["speaker"], [])[0]?.name).toBe("speaker");
	});

	it("declares every other keyed role the club runs — the functionaries no beat names — after the named ones", () => {
		const out = declareStandardRoles(
			["speaker"],
			[
				role("timer", { defaultCount: 1 }),
				role("speaker"),
				role("ah_counter", { enabled: false }),
				role("joke_master", { standing: false }),
				role(null),
				role("grammarian", { defaultCount: 1 }),
			],
		);
		expect(out.map((r) => [r.key, r.defaultCount, r.sortOrder])).toEqual([
			["speaker", 2, 0],
			["timer", 1, 1],
			["grammarian", 1, 2],
		]);
	});
});
