/**
 * #1471: the Toastmaster and General Evaluator "during" guides follow the club's
 * `geIntroducesFunctionaries` setting, without overwriting a guide the club
 * wrote. Covers both the settings save and the one-time data migration.
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, roleDefinitions } from "#/db/schema";
import { duringNotesFor, ROLE_TEMPLATE, roleSeed } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyClubAgendaSettingsUpdate } = await import("./clubs-logic");

const TM = roleSeed("Toastmaster of the Day");
const GE = roleSeed("General Evaluator");

function save(clubId: string, ge: boolean) {
	return applyClubAgendaSettingsUpdate({
		clubId,
		geIntroducesFunctionaries: ge,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
	});
}

async function seedRoles(
	clubId: string,
	during: { tm: string | null; ge: string | null },
) {
	for (const [seed, text] of [
		[TM, during.tm],
		[GE, during.ge],
	] as const) {
		await testDb.insert(roleDefinitions).values({
			clubId,
			name: seed.name,
			key: seed.key,
			category: seed.category,
			beforeNotes: "BEFORE",
			description: "DESC",
			duringNotes: text,
		});
	}
}

async function guides(clubId: string) {
	const rows = await testDb
		.select()
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
	const by = (k: string) => rows.find((r) => r.key === k);
	return { tm: by(TM.key), ge: by(GE.key) };
}

describe.skipIf(!hasTestDb)("GE-variant role guides (#1471)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("turning ON swaps both seeded guides, and OFF restores them exactly", async () => {
		await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		await save(seed.clubId, true);
		let g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBe(duringNotesFor(TM, true));
		expect(g.ge?.duringNotes).toBe(duringNotesFor(GE, true));
		expect(g.tm?.duringNotes).not.toContain("Introduce the functionaries");
		expect(g.ge?.duringNotes).toContain("call for the functionaries' reports");
		await save(seed.clubId, false);
		g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBe(TM.duringNotes);
		expect(g.ge?.duringNotes).toBe(GE.duringNotes);
		expect(g.tm?.beforeNotes).toBe("BEFORE");
		expect(g.tm?.description).toBe("DESC");
	});

	it.each([
		["Toastmaster", "tm"],
		["General Evaluator", "ge"],
	] as const)("a club-edited %s guide survives both changes byte for byte", async (_n, which) => {
		const edited = `  My own words.\n\nKeep me. `;
		await seedRoles(seed.clubId, {
			tm: which === "tm" ? edited : TM.duringNotes,
			ge: which === "ge" ? edited : GE.duringNotes,
		});
		await save(seed.clubId, true);
		expect((await guides(seed.clubId))[which]?.duringNotes).toBe(edited);
		await save(seed.clubId, false);
		expect((await guides(seed.clubId))[which]?.duringNotes).toBe(edited);
	});

	it("a cleared (NULL) guide stays NULL", async () => {
		await seedRoles(seed.clubId, { tm: null, ge: null });
		await save(seed.clubId, true);
		const g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBeNull();
		expect(g.ge?.duringNotes).toBeNull();
	});

	it("saving the same value changes no guide", async () => {
		await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		await save(seed.clubId, false);
		const g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBe(TM.duringNotes);
		// An ON club whose guide is still the STANDARD text is not rewritten by an ON save.
		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: true })
			.where(eq(clubs.id, seed.clubId));
		await save(seed.clubId, true);
		expect((await guides(seed.clubId)).tm?.duringNotes).toBe(TM.duringNotes);
	});

	it("matches by key, not by the name a club gave the role", async () => {
		await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		await testDb
			.update(roleDefinitions)
			.set({ name: "Host" })
			.where(eq(roleDefinitions.key, TM.key));
		await save(seed.clubId, true);
		expect((await guides(seed.clubId)).tm?.duringNotes).toBe(
			duringNotesFor(TM, true),
		);
	});

	it("no other role has a GE variant", () => {
		expect(
			ROLE_TEMPLATE.filter((r) => r.geDuringNotes !== undefined).map(
				(r) => r.key,
			),
		).toEqual([TM.key, GE.key]);
	});
});

describe.skipIf(!hasTestDb)("GE-variant guides data migration (#1471)", () => {
	let on: SeededClub;
	let off: SeededClub;
	beforeEach(async () => {
		on = await seedClub();
		off = await seedClub();
	});
	afterEach(async () => {
		await cleanup(on.clubId, [on.adminUserId, on.memberUserId]);
		await cleanup(off.clubId, [off.adminUserId, off.memberUserId]);
	});

	it("moves only standard-seed rows in clubs with the setting ON", async () => {
		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: true })
			.where(eq(clubs.id, on.clubId));
		await seedRoles(on.clubId, { tm: TM.duringNotes, ge: "Club edited." });
		await seedRoles(off.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		const file = readFileSync(
			"drizzle/0128_ge_variant_role_guides.sql",
			"utf8",
		);
		for (const stmt of file.split(";\n").filter((s) => /UPDATE/.test(s))) {
			await testDb.execute(sql.raw(stmt));
		}
		const a = await guides(on.clubId);
		expect(a.tm?.duringNotes).toBe(duringNotesFor(TM, true));
		expect(a.ge?.duringNotes).toBe("Club edited.");
		const b = await guides(off.clubId);
		expect(b.tm?.duringNotes).toBe(TM.duringNotes);
		expect(b.ge?.duringNotes).toBe(GE.duringNotes);
	});

	it("is the same text as ROLE_TEMPLATE", () => {
		const file = readFileSync(
			"drizzle/0128_ge_variant_role_guides.sql",
			"utf8",
		);
		for (const r of [TM, GE]) {
			expect(file).toContain(r.geDuringNotes?.replace(/'/g, "''"));
			expect(file).toContain(r.duringNotes.trim().replace(/'/g, "''"));
		}
	});
});
