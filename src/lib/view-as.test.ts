import { describe, expect, it } from "vitest";
import { applyViewAs, parseViewAs } from "./view-as";

describe("parseViewAs", () => {
	it('reads "member"', () => {
		expect(parseViewAs("member")).toBe("member");
	});
	it("treats an empty string as no preview", () => {
		expect(parseViewAs("")).toBeNull();
	});
	it("does not accept any other role", () => {
		expect(parseViewAs("admin")).toBeNull();
	});
	it("treats an absent cookie as no preview", () => {
		expect(parseViewAs(undefined)).toBeNull();
		expect(parseViewAs(null)).toBeNull();
	});
});

const club = (clubId: string, clubRole: "admin" | "member") => ({
	clubId,
	name: `Club ${clubId}`,
	clubNumber: null,
	clubRole,
});

function ctx(
	over: Partial<{
		clubs: ReturnType<typeof club>[];
		activeClubId: string | null;
		officerPositions: readonly ("president" | "vp_education")[];
	}> = {},
) {
	return {
		clubs: [club("a", "admin"), club("b", "admin")],
		activeClubId: "a",
		officerPositions: [] as readonly ("president" | "vp_education")[],
		...over,
	};
}

describe("applyViewAs", () => {
	it("is a no-op with viewAs null when there is no preview", () => {
		const c = ctx();
		expect(applyViewAs(c, null)).toEqual({ ...c, viewAs: null });
	});

	it("ignores the cookie for a plain member and shows no preview", () => {
		const c = ctx({ clubs: [club("a", "member")] });
		const out = applyViewAs(c, "member");
		expect(out.viewAs).toBeNull();
		expect(out.clubs).toEqual(c.clubs);
	});

	it("downgrades a stored admin and clears nothing else", () => {
		const out = applyViewAs(ctx({ officerPositions: ["president"] }), "member");
		expect(out.viewAs).toBe("member");
		expect(out.clubs[0]?.clubRole).toBe("member");
		expect(out.officerPositions).toEqual([]);
	});

	it("downgrades an officer who holds no stored admin role", () => {
		const out = applyViewAs(
			ctx({
				clubs: [club("a", "member")],
				officerPositions: ["vp_education"],
			}),
			"member",
		);
		expect(out.viewAs).toBe("member");
		expect(out.clubs[0]?.clubRole).toBe("member");
		expect(out.officerPositions).toEqual([]);
	});

	it("downgrades only the ACTIVE club", () => {
		const out = applyViewAs(ctx({ activeClubId: "b" }), "member");
		expect(out.clubs.map((c) => c.clubRole)).toEqual(["admin", "member"]);
	});

	it("downgrades a superadmin's injected session club like a stored admin", () => {
		// `getAuthContext` injects the impersonated club as `clubRole: "admin"`.
		const out = applyViewAs(
			ctx({ clubs: [club("s", "admin")], activeClubId: "s" }),
			"member",
		);
		expect(out.viewAs).toBe("member");
		expect(out.clubs[0]?.clubRole).toBe("member");
	});
});
