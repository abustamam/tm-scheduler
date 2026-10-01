/**
 * The club-default apply's races (#910 review, R1–R3): what is decided
 * without a lock must be re-decided under one.
 *
 * - R1: a #909 replace swapping the default's roles while a conversion runs.
 *   The conversion share-locks the SOURCE template before its refusal plan
 *   reads the roles, so the check and the copy see one role set.
 * - R2: the meeting edited, or the default changed, between the loop's look
 *   and the conversion (`expectStandard`).
 * - R3: a meeting created while a default is being set reads the pointer FOR
 *   SHARE, so it either sees the new default or is seen by the setter's scan.
 *
 * Each interleave parks the code under test behind a real open transaction
 * (`openBlockingTx` + `waitForLockWait`), the same construction as the
 * deleted-default test in `club-agendas.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
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
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setClubDefaultTemplate } = await import("./club-agendas-logic");
const {
	ApplyPreconditionError,
	applyTemplateConversion,
	loadComparableCopy,
	WouldRemoveError,
} = await import("./meeting-templates-logic");
const { COMPARED_BEAT_FIELDS } = await import("#/lib/agenda-materialise");
const { loadAgendaDraft, standardAgendaForClub } = await import(
	"./meeting-agenda-edit-logic"
);
const { insertMeetingWithSlots } = await import("./meeting-create-logic");
const { applyCreateMeeting } = await import("./meetings-logic");

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("club default apply under its locks", () => {
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

	async function newMeeting(daysAhead: number) {
		const bank = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
		const id = await testDb.transaction((tx) =>
			insertMeetingWithSlots(
				tx,
				{
					clubId: club.clubId,
					scheduledAt: new Date(Date.now() + daysAhead * DAY),
					lengthMinutes: 90,
					location: null,
				},
				bank,
			),
		);
		if (!id) throw new Error("meeting not created");
		return id;
	}

	/** A club template with the standard beats and every stock role but `drop`. */
	async function template(drop: string[] = []) {
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
			materialiseRunOfShow(false, null)
				.filter((s) => !drop.includes(s.roleKey ?? ""))
				.map((s, i) => ({ ...s, sortOrder: i, templateId })),
		);
		await testDb.insert(meetingTemplateRoles).values(
			ROLE_TEMPLATE.filter((r) => !drop.includes(r.key)).map((r, i) => ({
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

	async function templateIdOf(meetingId: string) {
		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		return m?.templateId ?? null;
	}

	async function setDefaultPointer(templateId: string | null) {
		await testDb
			.update(clubs)
			.set({ defaultTemplateId: templateId })
			.where(eq(clubs.id, club.clubId));
	}

	async function expected() {
		const standard = await standardAgendaForClub(testDb, club.clubId);
		if (!standard) throw new Error("no club");
		return { beats: standard.seeds, roles: standard.roles };
	}

	async function firstBeatOf(templateId: string) {
		const [first] = await testDb
			.select({ id: meetingTemplateBeats.id })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder))
			.limit(1);
		return first?.id as string;
	}

	// -----------------------------------------------------------------------
	// R1
	// -----------------------------------------------------------------------

	it("R1: a replace swapping the default's roles mid-conversion is seen by the refusal check, and no role is removed", async () => {
		const a = await newMeeting(7);
		const full = await template();
		// A #909 replace: the target row FOR UPDATE, then its roles swapped to a
		// set without the Timer, not yet committed.
		const replace = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, full))
				.for("update");
			await tx
				.delete(meetingTemplateRoles)
				.where(
					and(
						eq(meetingTemplateRoles.templateId, full),
						eq(meetingTemplateRoles.key, "timer"),
					),
				);
		});
		const converting = applyTemplateConversion({
			meetingId: a,
			clubId: club.clubId,
			templateId: full,
			actorMemberId: null,
			refuseIfReleasing: true,
			refuseIfRemoving: true,
		});
		converting.catch(() => {});
		// Parked on the SOURCE share lock taken before the refusal plan — the
		// one with the visibility predicate, not the copy's later re-lock.
		await waitForLockWait(
			'select "id" from "meeting_templates" where ("meeting_templates"."id"',
			replace.pid,
		);
		await replace.commit();
		await expect(converting).rejects.toBeInstanceOf(WouldRemoveError);
		expect(await templateIdOf(a)).toBeNull();
		const timer = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(and(eq(roleSlots.meetingId, a), eq(roleDefinitions.key, "timer")));
		expect(timer).toHaveLength(1);
	});

	it("R1 (end to end): whichever lock the conversion parks on, a role swap committed mid-conversion removes no role", async () => {
		const a = await newMeeting(7);
		const full = await template();
		// A #909 replace: the target row FOR UPDATE, then its roles swapped to a
		// set without the Timer, not yet committed.
		const replace = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, full))
				.for("update");
			await tx
				.delete(meetingTemplateRoles)
				.where(
					and(
						eq(meetingTemplateRoles.templateId, full),
						eq(meetingTemplateRoles.key, "timer"),
					),
				);
		});
		const converting = applyTemplateConversion({
			meetingId: a,
			clubId: club.clubId,
			templateId: full,
			actorMemberId: null,
			refuseIfReleasing: true,
			refuseIfRemoving: true,
		});
		converting.catch(() => {});
		// Parked on ANY share lock behind the replace: the early source lock
		// today, or the copy's own if that ever went — in which case the final-
		// plan check is what must still refuse.
		await waitForLockWait("for share", replace.pid);
		await replace.commit();
		await expect(converting).rejects.toBeInstanceOf(WouldRemoveError);
		expect(await templateIdOf(a)).toBeNull();
		const timer = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(and(eq(roleSlots.meetingId, a), eq(roleDefinitions.key, "timer")));
		expect(timer).toHaveLength(1);
	});

	// -----------------------------------------------------------------------
	// R2
	// -----------------------------------------------------------------------

	it("R2: an edit committed between the loop's look and the conversion is kept, and the meeting is listed as edited", async () => {
		const b = await newMeeting(7);
		await loadAgendaDraft(b);
		const copy = (await templateIdOf(b)) as string;
		const beat = await firstBeatOf(copy);
		const full = await template();
		// An agenda-editor write in flight: it holds the MEETING row FOR UPDATE
		// (as `ensureAgendaDraft` does) and has changed a row of the copy.
		const editor = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.id, b))
				.for("update");
			await tx
				.update(meetingTemplateBeats)
				.set({ label: "Officer's edit" })
				.where(eq(meetingTemplateBeats.id, beat));
		});
		const setting = setClubDefaultTemplate({
			clubId: club.clubId,
			templateId: full,
			actorMemberId: null,
		});
		await waitForLockWait("for no key update", editor.pid);
		await editor.commit();
		const result = await setting;
		expect(result.applied).toEqual([]);
		expect(result.keptEdited).toEqual([
			expect.objectContaining({ meetingId: b }),
		]);
		expect(await templateIdOf(b)).toBe(copy);
		const [still] = await testDb
			.select({ label: meetingTemplateBeats.label })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.id, beat));
		expect(still?.label).toBe("Officer's edit");
	});

	it("R2a: a meeting whose pointer changed since the look is refused as edited, even onto an unedited copy", async () => {
		const a = await newMeeting(7);
		const full = await template();
		await setDefaultPointer(full);
		const standard = await expected();
		await loadAgendaDraft(a); // opened since the loop saw template_id NULL
		const opened = await templateIdOf(a);
		await expect(
			applyTemplateConversion({
				meetingId: a,
				clubId: club.clubId,
				templateId: full,
				actorMemberId: null,
				expectStandard: { templateId: null, standard },
			}),
		).rejects.toMatchObject({ reason: "edited" });
		expect(await templateIdOf(a)).toBe(opened);
	});

	it("R2b: a copy edited since the look is refused as edited, with the edit intact", async () => {
		const b = await newMeeting(7);
		const full = await template();
		await setDefaultPointer(full);
		const standard = await expected();
		await loadAgendaDraft(b);
		const copy = (await templateIdOf(b)) as string;
		const beat = await firstBeatOf(copy);
		await testDb
			.update(meetingTemplateBeats)
			.set({ label: "Officer's edit" })
			.where(eq(meetingTemplateBeats.id, beat));
		const attempt = applyTemplateConversion({
			meetingId: b,
			clubId: club.clubId,
			templateId: full,
			actorMemberId: null,
			expectStandard: { templateId: copy, standard },
		});
		await expect(attempt).rejects.toBeInstanceOf(ApplyPreconditionError);
		await expect(attempt).rejects.toMatchObject({ reason: "edited" });
		expect(await templateIdOf(b)).toBe(copy);
	});

	it("R2c: a default changed since the loop started is refused as superseded", async () => {
		const a = await newMeeting(7);
		const first = await template();
		const second = await template();
		await setDefaultPointer(second);
		await expect(
			applyTemplateConversion({
				meetingId: a,
				clubId: club.clubId,
				templateId: first,
				actorMemberId: null,
				expectStandard: { templateId: null, standard: await expected() },
			}),
		).rejects.toMatchObject({ reason: "superseded" });
		expect(await templateIdOf(a)).toBeNull();
	});

	it("R4: an archive committed since the loop started is refused as archived", async () => {
		const a = await newMeeting(7);
		const full = await template();
		await setDefaultPointer(full);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			applyTemplateConversion({
				meetingId: a,
				clubId: club.clubId,
				templateId: full,
				actorMemberId: null,
				expectStandard: { templateId: null, standard: await expected() },
			}),
		).rejects.toMatchObject({ reason: "archived" });
		expect(await templateIdOf(a)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// R3
	// -----------------------------------------------------------------------

	it("R3: a meeting created while the pointer is being written waits for it and starts on the new default", async () => {
		const full = await template();
		// A set-default's pointer write, not yet committed.
		const setter = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: clubs.id })
				.from(clubs)
				.where(eq(clubs.id, club.clubId))
				.for("no key update");
			await tx
				.update(clubs)
				.set({ defaultTemplateId: full })
				.where(eq(clubs.id, club.clubId));
		});
		const creating = applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: new Date(Date.now() + 10 * DAY).toISOString().slice(0, 16),
		});
		await waitForLockWait('from "clubs"', setter.pid);
		await setter.commit();
		const { meetingId } = await creating;
		const copy = await templateIdOf(meetingId);
		expect(copy).not.toBeNull();
		const [row] = await testDb
			.select({ meetingId: meetingTemplates.meetingId })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, copy as string));
		expect(row?.meetingId).toBe(meetingId);
	});

	// -----------------------------------------------------------------------
	// S2
	// -----------------------------------------------------------------------

	it("loads exactly the beat columns the comparator compares", async () => {
		const b = await newMeeting(7);
		await loadAgendaDraft(b);
		const copy = await loadComparableCopy(
			testDb,
			b,
			(await templateIdOf(b)) as string,
		);
		expect(Object.keys(copy?.beats[0] ?? {}).sort()).toEqual(
			[...COMPARED_BEAT_FIELDS].sort(),
		);
	});
});
