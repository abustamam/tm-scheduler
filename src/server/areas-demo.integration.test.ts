/**
 * The demo club and areas (#1200): it cannot be placed in one, and an area
 * health read never counts it as a live club. `#/db` is redirected to the demo
 * club's open transaction (`withDemoClub`), because the single `is_demo` row
 * belongs to the #1199 suite and every row here is rolled back.
 *
 * Run with (in a worktree, nothing exported):
 *   bunx vitest run src/server/areas-demo.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { areaClubs, clubs } from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import { hasTestDb } from "#/test/db";
import { type DemoClubCtx, withDemoClub } from "#/test/demo-club-tx";

vi.mock("#/db", async () => (await import("#/test/demo-club-tx")).dbMock());

const {
	addAreaClub,
	createArea,
	createDistrict,
	createDivision,
	getConsoleArea,
	linkAreaClub,
	DEMO_CLUB_MESSAGE,
} = await import("./areas-logic");
const { loadAreaHealth } = await import("./area-health-logic");

const YEAR = currentProgramYear();

async function makeArea() {
	const { id: districtId } = await createDistrict({
		number: `D${randomUUID().slice(0, 6)}`,
	});
	const { id: divisionId } = await createDivision({
		districtId,
		programYear: YEAR,
		letter: "B",
	});
	const { id: areaId } = await createArea({ divisionId, number: "2" });
	return areaId;
}

async function realClub(tx: DemoClubCtx["tx"], name = "Real Club") {
	const [row] = await tx
		.insert(clubs)
		.values({ name, slug: `areas-demo-1200-${randomUUID()}` })
		.returning({ id: clubs.id });
	if (!row) throw new Error("club");
	return row.id;
}

const placedRows = (tx: DemoClubCtx["tx"], areaId: string) =>
	tx.select().from(areaClubs).where(eq(areaClubs.areaId, areaId));

describe.skipIf(!hasTestDb)("the demo club and areas (#1200)", () => {
	// protects=placing the demo club in an area is refused with the demo sentence
	//   and writes no area_clubs row, by id AND by the club number a name-only row
	//   is later linked through, while a real club is placed by the same call;
	// fails_when=the demo club gets a row (an orphan on every rebuild, since
	//   area_clubs.club_id is ON DELETE SET NULL), or the refusal is another
	//   sentence, or a real club is refused too;
	// no_claim=the delete side: that a rebuild leaves no orphan is #1193's.
	it("refuses to place the demo club, by id and by link, and still places a real club", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const areaId = await makeArea();

			await expect(addAreaClub({ areaId, clubId: demoClubId })).rejects.toThrow(
				DEMO_CLUB_MESSAGE,
			);
			expect(await placedRows(tx, areaId)).toHaveLength(0);

			// The by-number path: a name-only row typed with the demo club's number
			// links through `lockClubByNumber`, which takes the same lock.
			const number = String(
				Math.floor(10_000_000 + Math.random() * 89_999_999),
			);
			await tx
				.update(clubs)
				.set({ clubNumber: number })
				.where(eq(clubs.id, demoClubId));
			const [nameOnly] = await tx
				.insert(areaClubs)
				.values({ areaId, name: "Typed By Hand", clubNumber: number })
				.returning({ id: areaClubs.id });
			if (!nameOnly) throw new Error("row");
			await expect(linkAreaClub({ areaClubId: nameOnly.id })).rejects.toThrow(
				DEMO_CLUB_MESSAGE,
			);
			const [stillNameOnly] = await tx
				.select({ clubId: areaClubs.clubId })
				.from(areaClubs)
				.where(eq(areaClubs.id, nameOnly.id));
			expect(stillNameOnly?.clubId).toBeNull();

			const real = await realClub(tx);
			const { id } = await addAreaClub({ areaId, clubId: real });
			const [placed] = await tx
				.select({ clubId: areaClubs.clubId })
				.from(areaClubs)
				.where(eq(areaClubs.id, id));
			expect(placed?.clubId).toBe(real);
		});
	});

	// protects=an area health read lists a demo club row as NOT on GavelUp, under
	//   the area's stored name and with no club data, beside a real club that is;
	// fails_when=the demo club is "on_gavelup" (its made-up numbers would read as a
	//   real club's health), or the real club stops being live;
	// no_claim=a row placed by the console: placement is refused above, so the
	//   demo row here is inserted directly, as an old or hand-made row would be.
	it("reads a demo club's area row as not on GavelUp, and a real club's as live", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const areaId = await makeArea();
			const real = await realClub(tx, "Live Real Club");
			await tx.insert(areaClubs).values([
				{
					areaId,
					clubId: demoClubId,
					name: "Stored Demo Name",
					clubNumber: "1",
				},
				{ areaId, clubId: real, name: "Live Real Club", clubNumber: "2" },
			]);

			const health = await loadAreaHealth(
				areaId,
				new Date("2026-11-15T12:00:00Z"),
			);

			const byName = new Map(health.clubs.map((c) => [c.name, c]));
			expect(byName.get("Stored Demo Name")?.status).toBe("not_on_gavelup");
			expect(byName.get("Live Real Club")?.status).toBe("on_gavelup");
			expect(health.clubs).toHaveLength(2);
		});
	});

	// protects=the console's area detail never offers the demo club to place, nor
	//   offers it as the link for a name-only row;
	// fails_when=the demo club is in `availableClubs` or a `linkOffer` (the admin
	//   would pick it and meet the refusal);
	// no_claim=the refusal itself, covered by the first test.
	it("does not offer the demo club on the console's area page", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const areaId = await makeArea();
			const real = await realClub(tx);
			const number = String(
				Math.floor(10_000_000 + Math.random() * 89_999_999),
			);
			await tx
				.update(clubs)
				.set({ clubNumber: number })
				.where(eq(clubs.id, demoClubId));
			await tx
				.insert(areaClubs)
				.values({ areaId, name: "Typed By Hand", clubNumber: number });

			const detail = await getConsoleArea(areaId);

			const offered = detail.availableClubs.map((c) => c.id);
			expect(offered).toContain(real);
			expect(offered).not.toContain(demoClubId);
			expect(detail.clubs.map((c) => c.linkOffer)).toEqual([null]);
		});
	});
});
