/**
 * The sign-up race in setting a club default (#910, "Edge rules").
 *
 * `applyDefaultToUpcoming` pre-plans each meeting WITHOUT a lock, then converts
 * it. A member who claims a role in between must not be released by a bulk
 * action that promised never to release anyone, so the conversion re-checks
 * under its own meeting lock (`refuseIfReleasing`) and the loop files a refusal
 * under `keptSignups`. Likewise a slot the default would DELETE, open or not
 * (`refuseIfRemoving` → `keptRoles`).
 *
 * The window is a few milliseconds and cannot be hit on purpose, so the
 * PRE-PLAN is replaced with one that always reports "nothing released or
 * removed" — the state a change landing just after it leaves. What remains real is exactly the
 * part under test: the locked re-check, the typed refusal and the filing.
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
	planTemplateConversion: async () => ({
		openSlotsRemoved: 0,
		claimedSlotsReleased: 0,
		slotsWithSpeeches: 0,
		slotsAdded: 0,
		releasedHolders: [],
		releasedRoleNames: [],
		removedRoleNames: [],
	}),
}));

const { setClubDefaultTemplate } = await import("./club-agendas-logic");

describe.skipIf(!hasTestDb)("set default, sign-up and removal race", () => {
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

	/** A club template: the standard beats and stock roles, minus one key. */
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

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("files a meeting whose locked plan would remove an OPEN role under keptRoles, and removes nothing", async () => {
		// A standard meeting with an open Timer slot, and a default with no Timer.
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning({ id: meetings.id });
		const meetingId = m?.id as string;
		const [timer] = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, "timer"),
				),
			);
		const [slot] = await testDb
			.insert(roleSlots)
			.values({ meetingId, roleDefinitionId: timer?.id as string })
			.returning({ id: roleSlots.id });
		const templateId = await templateWithout("timer");

		const result = await setClubDefaultTemplate({
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});

		expect(result.applied).toEqual([]);
		expect(result.failed).toEqual([]);
		expect(result.keptRoles).toEqual([
			expect.objectContaining({ meetingId, roles: ["Timer"] }),
		]);
		const still = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.id, slot?.id as string));
		expect(still).toHaveLength(1);
	});

	it("files a meeting whose locked plan releases someone under keptSignups, and releases nobody", async () => {
		// A standard meeting whose Ah-Counter is claimed.
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning({ id: meetings.id });
		const meetingId = m?.id as string;
		const [ah] = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, "ah_counter"),
				),
			);
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: ah?.id as string,
				assignedMemberId: club.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.returning({ id: roleSlots.id });

		// A club template with no Ah-Counter.
		const templateId = await templateWithout("ah_counter");

		const result = await setClubDefaultTemplate({
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});

		expect(result.applied).toEqual([]);
		expect(result.failed).toEqual([]);
		expect(result.keptSignups).toEqual([
			expect.objectContaining({ meetingId, roles: ["Ah-Counter"] }),
		]);
		const [held] = await testDb
			.select({
				member: roleSlots.assignedMemberId,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slot?.id as string));
		expect(held).toEqual({ member: club.memberId, status: "claimed" });
		const [after] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		expect(after?.templateId).toBeNull();
	});
});
