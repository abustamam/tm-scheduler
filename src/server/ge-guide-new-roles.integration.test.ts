/**
 * #1512: a Toastmaster or General Evaluator role row minted by the
 * meeting-templates path takes the guide variant for the club's current
 * `geIntroducesFunctionaries` setting. (The history-import arm lives in
 * `history-import-ge-guide.integration.test.ts`; the fixture arm below.)
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import { duringNotesFor, ROLE_TEMPLATE } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
const { insertFixtureClub } = await import("#/db/fixtures/helpers");
const { materializeTemplateRoles } = await import("./meeting-templates-logic");

const seedFor = (key: string) => {
	const s = ROLE_TEMPLATE.find((r) => r.key === key);
	if (!s) throw new Error(`no seed ${key}`);
	return s;
};

describe.skipIf(!hasTestDb)("GE guide on minted roles (#1512)", () => {
	let club: SeededClub;
	const templates: string[] = [];

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		if (templates.length > 0) {
			await testDb
				.delete(meetingTemplates)
				.where(inArray(meetingTemplates.id, templates.splice(0)));
		}
	});

	async function mint(geIntroduces: boolean) {
		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: geIntroduces })
			.where(eq(clubs.id, club.clubId));
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: null,
				key: `ge-guide-${crypto.randomUUID().slice(0, 8)}`,
				name: "GE guide",
				defaultLengthMinutes: 60,
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("template");
		templates.push(tpl.id);
		const keys = ["toastmaster_of_the_day", "general_evaluator", "timer"];
		await testDb.insert(meetingTemplateRoles).values(
			keys.map((key, i) => ({
				templateId: tpl.id,
				key,
				name: key,
				category: "leadership" as const,
				defaultCount: 1,
				sortOrder: (i + 1) * 10,
			})),
		);
		await testDb
			.delete(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					inArray(roleDefinitions.key, keys),
				),
			);
		await materializeTemplateRoles(testDb, club.clubId, tpl.id);
		const rows = await testDb
			.select({
				key: roleDefinitions.key,
				duringNotes: roleDefinitions.duringNotes,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
		return new Map(rows.map((r) => [r.key, r.duringNotes]));
	}

	for (const on of [true, false]) {
		it(`setting ${on ? "ON" : "OFF"}: minted TM and GE rows take the matching variant, Timer is unchanged`, async () => {
			const rows = await mint(on);
			for (const key of ["toastmaster_of_the_day", "general_evaluator"]) {
				expect(rows.get(key)).toBe(duringNotesFor(seedFor(key), on));
			}
			expect(rows.get("timer")).toBe(seedFor("timer").duringNotes);
		});
	}

	it("the two variants differ for TM and GE, so the pair above can tell them apart", () => {
		for (const key of ["toastmaster_of_the_day", "general_evaluator"]) {
			expect(duringNotesFor(seedFor(key), true)).not.toBe(
				duringNotesFor(seedFor(key), false),
			);
		}
	});

	for (const on of [true, false]) {
		it(`fixture club with setting ${on ? "ON" : "OFF"} seeds roles with the matching variant`, async () => {
			const slug = `ge-fixture-${crypto.randomUUID().slice(0, 8)}`;
			const fx = await insertFixtureClub(testDb, {
				name: "GE fixture",
				slug,
				now: new Date("2026-10-12T12:00:00Z"),
				geIntroducesFunctionaries: on,
				roster: [
					{
						name: "Fixture Person",
						email: `${slug}@test.example`,
						userId: null,
					},
				],
				meetings: [],
			});
			try {
				const rows = await testDb
					.select({
						key: roleDefinitions.key,
						duringNotes: roleDefinitions.duringNotes,
					})
					.from(roleDefinitions)
					.where(eq(roleDefinitions.clubId, fx.clubId));
				expect(rows).toHaveLength(ROLE_TEMPLATE.length);
				for (const r of rows) {
					expect(r.duringNotes).toBe(
						duringNotesFor(seedFor(r.key as string), on),
					);
				}
			} finally {
				await cleanup(fx.clubId, []);
			}
		});
	}
});
