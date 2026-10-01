/**
 * The set-default loop stops when the world changes under it (#910 review,
 * R2c and R4): a second officer setting another default, or the club being
 * archived, between one meeting's conversion and the next.
 *
 * The change has to land INSIDE the loop, between two meetings, which no
 * caller can schedule from outside. So the loop's per-meeting pre-plan is
 * wrapped: it runs the real one, and before the SECOND meeting's it commits
 * the change. Everything after that — the locked re-check, the typed refusal,
 * how the loop files it — is the real code.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
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

/** Runs before the Nth pre-plan (1-based), once. */
let beforePlan: { n: number; run: () => Promise<void> } | null = null;
let plans = 0;
vi.mock("./meeting-templates-logic", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("./meeting-templates-logic")>();
	return {
		...real,
		planTemplateConversion: async (
			...args: Parameters<typeof real.planTemplateConversion>
		) => {
			plans += 1;
			if (beforePlan && plans === beforePlan.n) await beforePlan.run();
			return real.planTemplateConversion(...args);
		},
	};
});

const { setClubDefaultTemplate } = await import("./club-agendas-logic");
const { insertMeetingWithSlots } = await import("./meeting-create-logic");

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("set default stops mid-loop", () => {
	let club: SeededClub;

	beforeEach(async () => {
		plans = 0;
		beforePlan = null;
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

	async function threeMeetings() {
		const bank = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
		const ids: string[] = [];
		for (const days of [7, 14, 21]) {
			const id = await testDb.transaction((tx) =>
				insertMeetingWithSlots(
					tx,
					{
						clubId: club.clubId,
						scheduledAt: new Date(Date.now() + days * DAY),
						lengthMinutes: 90,
						location: null,
					},
					bank,
				),
			);
			ids.push(id as string);
		}
		return ids;
	}

	async function template() {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: null,
				key: `tpl-${randomUUID().slice(0, 8)}`,
				name: "Template",
			})
			.returning({ id: meetingTemplates.id });
		const templateId = tpl?.id as string;
		await testDb.insert(meetingTemplateBeats).values(
			materialiseRunOfShow(false, null).map((s, i) => ({
				...s,
				sortOrder: i,
				templateId,
			})),
		);
		await testDb.insert(meetingTemplateRoles).values(
			ROLE_TEMPLATE.map((r, i) => ({
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

	async function pointers() {
		return testDb
			.select({ id: meetings.id, templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.clubId, club.clubId))
			.orderBy(asc(meetings.scheduledAt));
	}

	it("stops applying a default another officer replaced mid-loop", async () => {
		const [m1, m2, m3] = await threeMeetings();
		const first = await template();
		const second = await template();
		beforePlan = {
			n: 2,
			run: async () => {
				await testDb
					.update(clubs)
					.set({ defaultTemplateId: second })
					.where(eq(clubs.id, club.clubId));
			},
		};
		const result = await setClubDefaultTemplate({
			clubId: club.clubId,
			templateId: first,
			actorMemberId: null,
		});
		expect(result.applied.map((m) => m.meetingId)).toEqual([m1]);
		// The rest are the newer call's to apply, so listed nowhere here.
		expect(result.failed).toEqual([]);
		expect(result.keptEdited).toEqual([]);
		const after = await pointers();
		expect(after.find((m) => m.id === m1)?.templateId).not.toBeNull();
		expect(after.find((m) => m.id === m2)?.templateId).toBeNull();
		expect(after.find((m) => m.id === m3)?.templateId).toBeNull();
	});

	it("stops when the club is archived mid-loop, reporting the rest as failed", async () => {
		const [m1, m2, m3] = await threeMeetings();
		const full = await template();
		beforePlan = {
			n: 2,
			run: async () => {
				await testDb
					.update(clubs)
					.set({ archivedAt: new Date() })
					.where(eq(clubs.id, club.clubId));
			},
		};
		const result = await setClubDefaultTemplate({
			clubId: club.clubId,
			templateId: full,
			actorMemberId: null,
		});
		expect(result.applied.map((m) => m.meetingId)).toEqual([m1]);
		expect(result.failed.map((m) => m.meetingId)).toEqual([m2, m3]);
		const after = await pointers();
		expect(after.find((m) => m.id === m2)?.templateId).toBeNull();
		expect(after.find((m) => m.id === m3)?.templateId).toBeNull();
	});
});
