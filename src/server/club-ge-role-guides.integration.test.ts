/**
 * #1471: the Toastmaster and General Evaluator "during" guides follow the club's
 * `geIntroducesFunctionaries` setting, without overwriting a guide the club
 * wrote. Covers both the settings save and the one-time data migration.
 */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetingTemplates, roleDefinitions } from "#/db/schema";
import { GE_LOCKED_MESSAGE } from "#/lib/club-agendas-copy";
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
		for (const row of [g.tm, g.ge]) {
			expect(row?.beforeNotes).toBe("BEFORE");
			expect(row?.description).toBe("DESC");
		}
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
		const g = await guides(seed.clubId);
		for (const row of [g.tm, g.ge]) {
			expect(row?.beforeNotes).toBe("BEFORE");
			expect(row?.description).toBe("DESC");
		}
	});

	it("a cleared (NULL) guide stays NULL", async () => {
		await seedRoles(seed.clubId, { tm: null, ge: null });
		await save(seed.clubId, true);
		const g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBeNull();
		expect(g.ge?.duringNotes).toBeNull();
	});

	it("saving the same value changes no guide", async () => {
		// OFF club holding the standard text, saved OFF: a swap would move it to the GE text.
		await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		await save(seed.clubId, false);
		let g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBe(TM.duringNotes);
		expect(g.ge?.duringNotes).toBe(GE.duringNotes);
		// ON club holding the GE text, saved ON: a swap would move it back to the standard text.
		await testDb
			.update(roleDefinitions)
			.set({ duringNotes: duringNotesFor(TM, true) })
			.where(
				and(
					eq(roleDefinitions.clubId, seed.clubId),
					eq(roleDefinitions.key, TM.key),
				),
			);
		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: true })
			.where(eq(clubs.id, seed.clubId));
		await save(seed.clubId, true);
		g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBe(duringNotesFor(TM, true));
	});

	it("refuses a change while the club has its own default agenda, and changes no guide", async () => {
		await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({ clubId: seed.clubId, key: "own-agenda", name: "Own agenda" })
			.returning({ id: meetingTemplates.id });
		await testDb
			.update(clubs)
			.set({ defaultTemplateId: tpl?.id })
			.where(eq(clubs.id, seed.clubId));
		await expect(save(seed.clubId, true)).rejects.toThrow(GE_LOCKED_MESSAGE);
		const g = await guides(seed.clubId);
		expect(g.tm?.duringNotes).toBe(TM.duringNotes);
		expect(g.ge?.duringNotes).toBe(GE.duringNotes);
		const [club] = await testDb
			.select({ ge: clubs.geIntroducesFunctionaries })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		expect(club?.ge).toBe(false);
		// Not changing the value still saves.
		await expect(save(seed.clubId, false)).resolves.toEqual({ ok: true });
	});

	it("touches only the club that was toggled", async () => {
		const other = await seedClub();
		try {
			await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
			await seedRoles(other.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
			await save(seed.clubId, true);
			const o = await guides(other.clubId);
			expect(o.tm?.duringNotes).toBe(TM.duringNotes);
			expect(o.ge?.duringNotes).toBe(GE.duringNotes);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("matches by key, not by the name a club gave the role", async () => {
		await seedRoles(seed.clubId, { tm: TM.duringNotes, ge: GE.duringNotes });
		await testDb
			.update(roleDefinitions)
			.set({ name: "Host" })
			.where(
				and(
					eq(roleDefinitions.clubId, seed.clubId),
					eq(roleDefinitions.key, TM.key),
				),
			);
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
		for (const row of [a.tm, a.ge, b.tm, b.ge]) {
			expect(row?.beforeNotes).toBe("BEFORE");
			expect(row?.description).toBe("DESC");
		}
	});

	it("leaves an edited Toastmaster guide in an ON club untouched", async () => {
		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: true })
			.where(eq(clubs.id, on.clubId));
		await seedRoles(on.clubId, { tm: "Club edited TM.", ge: GE.duringNotes });
		const file = readFileSync(
			"drizzle/0128_ge_variant_role_guides.sql",
			"utf8",
		);
		for (const stmt of file.split(";\n").filter((s) => /UPDATE/.test(s))) {
			await testDb.execute(sql.raw(stmt));
		}
		const a = await guides(on.clubId);
		expect(a.tm?.duringNotes).toBe("Club edited TM.");
		expect(a.ge?.duringNotes).toBe(duringNotesFor(GE, true));
	});
});
