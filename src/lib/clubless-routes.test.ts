import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
	AREA_ROUTE_ID,
	clublessMayOpen,
	SUPERADMIN_ROUTE_ID,
} from "./clubless-routes";

const NOBODY = { hasAreas: false, isSuperadmin: false };
const DIRECTOR = { hasAreas: true, isSuperadmin: false };
const SUPERADMIN = { hasAreas: false, isSuperadmin: true };
const BOTH = { hasAreas: true, isSuperadmin: true };

describe("clublessMayOpen (#1119)", () => {
	const area = ["__root__", "/_authed", AREA_ROUTE_ID];
	const superadmin = ["__root__", "/_authed", SUPERADMIN_ROUTE_ID];
	const consoleChild = [...superadmin, "/_authed/superadmin/areas/$areaId"];

	it("opens the area page to a director and to nobody else", () => {
		expect(clublessMayOpen(area, DIRECTOR)).toBe(true);
		expect(clublessMayOpen(area, NOBODY)).toBe(false);
		// A superadmin with no term is not a director (ADR-0016 section 4).
		expect(clublessMayOpen(area, SUPERADMIN)).toBe(false);
	});

	it("opens the console and every page under it to a superadmin and to nobody else", () => {
		for (const ids of [superadmin, consoleChild]) {
			expect(clublessMayOpen(ids, SUPERADMIN)).toBe(true);
			expect(clublessMayOpen(ids, NOBODY)).toBe(false);
			// A term opens the area page, not the console.
			expect(clublessMayOpen(ids, DIRECTOR)).toBe(false);
		}
	});

	it("opens nothing else, whoever asks", () => {
		for (const ids of [
			["__root__"],
			["__root__", "/_authed", "/_authed/dashboard"],
			["__root__", "/_authed", "/_authed/admin/dues"],
			// A route that only has a similar id.
			["__root__", "/_authed", "/_authed/areas/$areaId"],
			["__root__", "/_authed", "/_authed/superadmins"],
			[],
		]) {
			expect(clublessMayOpen(ids, BOTH), ids.join(" > ")).toBe(false);
		}
	});
});

// The router decides which routes a URL matches, and does so case-insensitively
// (`/AREA/<id>` is the area page). This mirrors the real route ids in a small
// tree and asks the router itself, so the casing and look-alike cases are the
// router's answer and not an assumption about it. `authed-clubless.test.tsx`
// holds the two ids to the real route files.
describe("clublessMayOpen on what the router matches (#1119)", () => {
	const root = createRootRoute();
	const authed = createRoute({ getParentRoute: () => root, id: "_authed" });
	const areaPage = createRoute({
		getParentRoute: () => authed,
		path: "/area/$areaId",
	});
	const superadmin = createRoute({
		getParentRoute: () => authed,
		path: "/superadmin",
	});
	const superadminIndex = createRoute({
		getParentRoute: () => superadmin,
		path: "/",
	});
	const superadminArea = createRoute({
		getParentRoute: () => superadmin,
		path: "/areas/$areaId",
	});
	const dashboard = createRoute({
		getParentRoute: () => authed,
		path: "/dashboard",
	});
	const router = createRouter({
		routeTree: root.addChildren([
			authed.addChildren([
				areaPage,
				superadmin.addChildren([superadminIndex, superadminArea]),
				dashboard,
			]),
		]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});

	function mayOpen(pathname: string, who: typeof NOBODY): boolean {
		const ids = router.matchRoutes(pathname).map((m) => m.routeId);
		return clublessMayOpen(ids, who);
	}

	it("the ids this file names are the ones the router assigns", () => {
		// Control: without it, a tree that never produced these ids would make every
		// "refused" case below pass for the wrong reason.
		expect(router.matchRoutes("/area/abc").map((m) => m.routeId)).toContain(
			AREA_ROUTE_ID,
		);
		expect(router.matchRoutes("/superadmin").map((m) => m.routeId)).toContain(
			SUPERADMIN_ROUTE_ID,
		);
	});

	it("opens /area/<id> to a director, and /superadmin and below to a superadmin", () => {
		expect(mayOpen("/area/abc", DIRECTOR)).toBe(true);
		expect(mayOpen("/superadmin", SUPERADMIN)).toBe(true);
		expect(mayOpen("/superadmin/areas/abc", SUPERADMIN)).toBe(true);
		expect(mayOpen("/area/abc", NOBODY)).toBe(false);
		expect(mayOpen("/superadmin", NOBODY)).toBe(false);
	});

	it("opens the same pages however the URL is cased, as the router does", () => {
		expect(mayOpen("/AREA/abc", DIRECTOR)).toBe(true);
		expect(mayOpen("/Area/abc", DIRECTOR)).toBe(true);
		expect(mayOpen("/Superadmin", SUPERADMIN)).toBe(true);
		expect(mayOpen("/SUPERADMIN/areas/abc", SUPERADMIN)).toBe(true);
		// The wrong person is refused in any casing.
		expect(mayOpen("/AREA/abc", NOBODY)).toBe(false);
		expect(mayOpen("/Superadmin", DIRECTOR)).toBe(false);
	});

	it("refuses look-alikes and an area page with no id", () => {
		for (const path of [
			"/areaX",
			"/area",
			"/area/",
			"/areas/abc",
			"/superadmin-foo",
			"/superadmins",
			"/x/area/abc",
			"/dashboard",
			"/",
		]) {
			expect(mayOpen(path, BOTH), path).toBe(false);
		}
	});
});
