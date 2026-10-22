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
			.values({ number: "DEMO", isDemo: true })
			.returning({ id: districts.id });
	}
	if (!district) throw new Error("district");
	const [division] = await tx
		.insert(divisions)
		.values({
			districtId: district.id,
			programYear: currentProgramYear(NOW),
			letter: `Z${randomUUID().slice(0, 6)}`,
		})
		.returning({ id: divisions.id });
	if (!division) throw new Error("division");
	const [area] = await tx
		.insert(areas)
		.values({ divisionId: division.id, number: "1" })
		.returning({ id: areas.id });
	if (!area) throw new Error("area");
	return area.id;
}

describe.skipIf(!hasTestDb)("area health in the demo district (#1278)", () => {
	// protects=the demo club placed in the demo district reads on_gavelup with its
	//   own name and club id, beside name-only rows that read not_on_gavelup;
	// fails_when=the demo club stays "not on GavelUp" in its own district, or a
	//   name-only row there is read as live;
	// no_claim=which figures are non-zero: the club has no meetings or roll, so
	//   this proves status and tracking only, not the figure arithmetic (the
	//   #1117 suite's).
	it("reads the demo club as on GavelUp and the other rows as not", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const areaId = await demoArea(tx);
			await tx.insert(areaClubs).values([
				{ areaId, clubId: demoClubId, name: "Demo Copy" },
				{ areaId, clubId: null, name: "Bayfront Speakers" },
				{ areaId, clubId: null, name: "Lighthouse Orators" },
			]);

			const result = await loadAreaHealth(areaId, NOW);

			const byName = new Map(result.clubs.map((c) => [c.name, c]));
			expect(byName.get("Bayfront Speakers")?.status).toBe("not_on_gavelup");
			expect(byName.get("Lighthouse Orators")?.status).toBe("not_on_gavelup");
			const live = result.clubs.filter((c) => c.status === "on_gavelup");
			expect(live).toHaveLength(1);
			expect(live[0]?.name).not.toBe("Demo Copy");
			expect(live[0]?.meetings.tracked).toBe(false);
			expect(live[0]?.name).toBe(
				(
					await tx
						.select({ name: clubs.name })
						.from(clubs)
						.where(eq(clubs.id, demoClubId))
				)[0]?.name,
			);
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
});
