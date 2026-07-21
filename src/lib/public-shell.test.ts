import { describe, expect, it } from "vitest";
import { publicShellDecision } from "./public-shell";

const ctx = (
	over: Partial<Parameters<typeof publicShellDecision>[0]> = {},
) => ({
	user: { id: "u1" },
	clubs: [{ clubId: "cA" }],
	currentMemberId: "mA",
	activeClubId: "cA",
	...over,
});

describe("publicShellDecision", () => {
	it("anonymous → no shell, no identity", () => {
		const d = publicShellDecision(
			{ user: null, clubs: [], currentMemberId: null, activeClubId: null },
			"cA",
		);
		expect(d).toEqual({
			shell: false,
			effectiveMemberId: null,
			switchActiveTo: null,
		});
	});

	it("signed-in member of the viewed active club → shell + session identity, no switch", () => {
		expect(publicShellDecision(ctx(), "cA")).toEqual({
			shell: true,
			effectiveMemberId: "mA",
			switchActiveTo: null,
		});
	});

	it("signed-in member of a NON-active viewed club → switch active, no identity yet", () => {
		const d = publicShellDecision(
			ctx({
				clubs: [{ clubId: "cA" }, { clubId: "cB" }],
				activeClubId: "cA",
				currentMemberId: "mA",
			}),
			"cB",
		);
		expect(d).toEqual({
			shell: false,
			effectiveMemberId: null,
			switchActiveTo: "cB",
		});
	});

	it("signed-in NON-member of the viewed club → anonymous experience", () => {
		expect(publicShellDecision(ctx(), "cZ")).toEqual({
			shell: false,
			effectiveMemberId: null,
			switchActiveTo: null,
		});
	});
});
