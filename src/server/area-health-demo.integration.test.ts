/**
 * The demo district and area health (#1278): the demo club is live only inside
 * the demo district, and only the demo club is. `#/db` is redirected to the demo
 * club's open transaction (`withDemoClub`), because the single `is_demo` club
 * and district belong to the #1199 suite and every row here is rolled back.
 *
 * Run with (in a worktree, nothing exported):
 *   bunx vitest run src/server/area-health-demo.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { areaClubs, areas, clubs, districts, divisions } from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import { hasTestDb } from "#/test/db";
import { type DemoClubCtx, withDemoClub } from "#/test/demo-club-tx";

vi.mock("#/db", async () => (await import("#/test/demo-club-tx")).dbMock());

const { loadAreaHealth } = await import("./area-health-logic");
const { DEMO_AREA_CLUB_NAMES, DEMO_DISTRICT_NUMBER, buildDemoArea } =
	await import("./demo-reset-logic");

const NOW = new Date();

/** An area in the demo district: the committed one when another suite built it,
 *  else one made inside this transaction. The division letter is unique to the
 *  run so nothing collides with a division already there. */
async function demoArea(tx: DemoClubCtx["tx"]) {
	let [district] = await tx
		.select({ id: districts.id })
		.from(districts)
		.where(eq(districts.isDemo, true))
		.limit(1);
	if (!district) {
		[district] = await tx
			.insert(districts)
			.values({ number: DEMO_DISTRICT_NUMBER, isDemo: true })
			.returning({ id: districts.id });
	}
	if (!district) throw new Error("demo district insert returned no row");
	const [division] = await tx
		.insert(divisions)
		.values({
			districtId: district.id,
			programYear: currentProgramYear(NOW),
			letter: `Z${randomUUID().slice(0, 6)}`,
		})
		.returning({ id: divisions.id });
	if (!division) throw new Error("demo division insert returned no row");
	const [area] = await tx
		.insert(areas)
		.values({ divisionId: division.id, number: "1" })
		.returning({ id: areas.id });
	if (!area) throw new Error("demo area insert returned no row");
	return area.id;
}

describe.skipIf(!hasTestDb)("area health in the demo district (#1278)", () => {
	// protects=on the area `buildDemoArea` builds (the demo club and three name-only
	//   rows) the demo club reads on_gavelup with its own name and figures, and
	//   the three name-only rows read not_on_gavelup with none;
	// fails_when=the demo club stays "not on GavelUp" in its own district, comes
	//   back without figures, or a name-only row is read as live;
	// no_claim=which figures are non-zero: the club has no meetings or roll, so
	//   this proves status and that figures are read, not their arithmetic (the
	//   #1117 suite's).
	it("reads the demo club as on GavelUp with figures and the other rows as not", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const { areaId } = await buildDemoArea(tx, {
				clubId: demoClubId,
				demoUserId: null,
				actorUserId: "unused",
				now: NOW,
			});

			const result = await loadAreaHealth(areaId, NOW);

			expect(result.clubs).toHaveLength(4);
			const live = result.clubs.filter((c) => c.status === "on_gavelup");
			expect(live).toHaveLength(1);
			expect(live[0]?.name).toBe(
				(
					await tx
						.select({ name: clubs.name })
						.from(clubs)
						.where(eq(clubs.id, demoClubId))
				)[0]?.name,
			);
			// The name-only rows are not the club's own.
			const others = result.clubs.filter((c) => c.status === "not_on_gavelup");
			expect(others.map((c) => c.name).sort()).toEqual(
				[...DEMO_AREA_CLUB_NAMES].sort(),
			);
			expect(others.every((c) => c.officers.tracked === false)).toBe(true);
			expect(live[0]?.officers.tracked).toBe(true);
		});
	});

	// protects=a REAL club whose row sits in the demo district reads not_on_gavelup
	//   under the area's stored name, with no figures and no club id, because the
	//   demo login is shared;
	// fails_when=the real club's name, number or figures reach the payload;
	// no_claim=a row placed by the console (refused elsewhere: #1279); this one is
	//   inserted directly, as a row placed by hand would be.
	it("does not read a real club placed in the demo district as live", async () => {
		await withDemoClub(async ({ tx }) => {
			const areaId = await demoArea(tx);
			const [real] = await tx
				.insert(clubs)
				.values({
					name: "Real Secret Name",
					slug: `area-health-demo-1278-${randomUUID()}`,
				})
				.returning({ id: clubs.id });
			if (!real) throw new Error("club");
			await tx
				.insert(areaClubs)
				.values({ areaId, clubId: real.id, name: "Stored Copy" });

			const result = await loadAreaHealth(areaId, NOW);

			expect(result.clubs).toHaveLength(1);
			expect(result.clubs[0]).toMatchObject({
				name: "Stored Copy",
				status: "not_on_gavelup",
				meetings: { tracked: false },
			});
			expect(JSON.stringify(result)).not.toContain("Real Secret Name");
			expect(JSON.stringify(result)).not.toContain(real.id);
		});
	});

	// protects=the demo club placed in a REAL district reads not_on_gavelup under
	//   the area's stored name, with no figures and no club id;
	// fails_when=the demo club is live outside the demo district (the live rule
	//   reduced to "is the demo club"), so its made-up figures show in a real area;
	// no_claim=a row placed by the console (refused by #1279); this one is inserted
	//   directly, as a row placed by hand would be.
	it("does not read the demo club in a real district as live", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const [district] = await tx
				.insert(districts)
				.values({ number: `RD${randomUUID().slice(0, 6)}` })
				.returning({ id: districts.id });
			const [division] = await tx
				.insert(divisions)
				.values({
					districtId: district?.id as string,
					programYear: currentProgramYear(NOW),
					letter: "A",
				})
				.returning({ id: divisions.id });
			const [area] = await tx
				.insert(areas)
				.values({ divisionId: division?.id as string, number: "1" })
				.returning({ id: areas.id });
			const areaId = area?.id as string;
			await tx
				.insert(areaClubs)
				.values({ areaId, clubId: demoClubId, name: "Stored Copy" });

			const result = await loadAreaHealth(areaId, NOW);

			expect(result.clubs).toHaveLength(1);
			expect(result.clubs[0]).toMatchObject({
				name: "Stored Copy",
				status: "not_on_gavelup",
				meetings: { tracked: false },
				officers: { tracked: false },
			});
			expect(JSON.stringify(result)).not.toContain(demoClubId);
		});
	});
});
