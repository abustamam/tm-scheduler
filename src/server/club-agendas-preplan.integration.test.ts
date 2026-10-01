/**
 * The PRE-PLAN half of setting a club default (#910): a meeting whose
 * conversion would release a sign-up or remove a role is filed WITHOUT a
 * conversion ever being attempted.
 *
 * The locked re-check inside `applyTemplateConversion` would file the same
 * meeting the same way, so with the real conversion the pre-plan is
 * invisible: deleting it changes no result. Here the conversion is replaced
 * with one that fails loudly, so a meeting the pre-plan missed lands in
 * `failed` instead of where it belongs. The locked half is
 * `club-agendas-race.integration.test.ts`, the mirror of this file.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { materialiseRunOfShow } from "#/lib/agenda-materialise";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("./meeting-templates-logic", async (importOriginal) => ({
	...(await importOriginal<typeof import("./meeting-templates-logic")>()),
	applyTemplateConversion: async () => {
		throw new Error("the pre-plan let this meeting through to a conversion");
	},
}));

const { setClubDefaultTemplate } = await import("./club-agendas-logic");

describe.skipIf(!hasTestDb)("set default, pre-plan", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
		await testDb
			.delete(roleDefinitions)
			.where(eq(roleDefinitions.id, club.roleDefinitionId));
		await testDb
			.insert(roleDefinitions)
			.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.clubId })));
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	/** A standard meeting with one slot for `key`, claimed or not. */
	async function meetingWith(key: string, claimed: boolean) {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning({ id: meetings.id });
		const [def] = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, key),
				),
			);
		await testDb.insert(roleSlots).values({
			meetingId: m?.id as string,
			roleDefinitionId: def?.id as string,
			...(claimed
				? {
						assignedMemberId: club.memberId,
						status: "claimed" as const,
						claimedAt: new Date(),
					}
				: {}),
		});
		return m?.id as string;
	}

	async function templateWithout(key: string) {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: null,
				key: `lean-${randomUUID().slice(0, 8)}`,
				name: "Lean",
			})
			.returning({ id: meetingTemplates.id });
		const templateId = tpl?.id as string;
		await testDb.insert(meetingTemplateBeats).values(
			materialiseRunOfShow(false, null)
				.filter((s) => s.roleKey !== key)
				.map((s, i) => ({ ...s, sortOrder: i, templateId })),
		);
		await testDb.insert(meetingTemplateRoles).values(
			ROLE_TEMPLATE.filter((r) => r.key !== key).map((r, i) => ({
				templateId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: i,
			})),
		);
		return templateId;
	}

	it("files an open role the default lacks under keptRoles without converting", async () => {
		const meetingId = await meetingWith("timer", false);
		const result = await setClubDefaultTemplate({
			clubId: club.clubId,
			templateId: await templateWithout("timer"),
			actorMemberId: null,
		});
		expect(result.failed).toEqual([]);
		expect(result.keptRoles).toEqual([
			expect.objectContaining({ meetingId, roles: ["Timer"] }),
		]);
	});

	it("files a claimed role the default lacks under keptSignups without converting", async () => {
		const meetingId = await meetingWith("timer", true);
		const result = await setClubDefaultTemplate({
			clubId: club.clubId,
			templateId: await templateWithout("timer"),
			actorMemberId: null,
		});
		expect(result.failed).toEqual([]);
		expect(result.keptSignups).toEqual([
			expect.objectContaining({ meetingId, roles: ["Timer"] }),
		]);
	});
});
