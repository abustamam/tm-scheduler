import { describe, expect, it } from "vitest";
import { resolveActiveClubId } from "./active-club";

describe("resolveActiveClubId", () => {
	const clubs = ["club-a", "club-b", "club-c"];

	it("honors the cookie when the user still belongs to that club", () => {
		expect(resolveActiveClubId(clubs, "club-b")).toBe("club-b");
	});

	it("falls back to the first club when the cookie is unset", () => {
		expect(resolveActiveClubId(clubs, undefined)).toBe("club-a");
		expect(resolveActiveClubId(clubs, null)).toBe("club-a");
	});

	it("ignores a stale/forged cookie for a club they no longer belong to", () => {
		expect(resolveActiveClubId(clubs, "club-z")).toBe("club-a");
	});

	it("returns null when the user belongs to no clubs", () => {
		expect(resolveActiveClubId([], "club-a")).toBeNull();
		expect(resolveActiveClubId([], undefined)).toBeNull();
	});
});
