import { describe, expect, it } from "vitest";
import { clublessMayOpen } from "./clubless-routes";

const NOBODY = { hasAreas: false, isSuperadmin: false };
const DIRECTOR = { hasAreas: true, isSuperadmin: false };
const SUPERADMIN = { hasAreas: false, isSuperadmin: true };

describe("clublessMayOpen (#1119)", () => {
	it("opens /area/<id> to a director and to nobody else", () => {
		expect(clublessMayOpen("/area/abc", DIRECTOR)).toBe(true);
		expect(clublessMayOpen("/area/abc", NOBODY)).toBe(false);
		// A superadmin with no term is not a director (ADR-0016 section 4).
		expect(clublessMayOpen("/area/abc", SUPERADMIN)).toBe(false);
	});

	it("opens /superadmin and what is under it to a superadmin and to nobody else", () => {
		for (const path of [
			"/superadmin",
			"/superadmin/areas",
			"/superadmin/x/y",
		]) {
			expect(clublessMayOpen(path, SUPERADMIN), path).toBe(true);
			expect(clublessMayOpen(path, NOBODY), path).toBe(false);
			expect(clublessMayOpen(path, DIRECTOR), path).toBe(false);
		}
	});

	it("opens nothing else, and not a path that only starts like one", () => {
		const both = { hasAreas: true, isSuperadmin: true };
		for (const path of [
			"/",
			"/dashboard",
			"/area",
			"/areas/abc",
			"/superadmins",
			"/superadmin-x",
			"/x/area/abc",
		]) {
			expect(clublessMayOpen(path, both), path).toBe(false);
		}
	});
});
