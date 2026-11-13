/**
 * Fixtures for the club default-agenda suites (#1630): a club with the nine
 * stock roles and no meetings, standard meetings, a template that carries the
 * stock roles minus some, and the "four buckets" a default sorts meetings into.
 *
 * Importers mock `#/db` onto `testDb` before this loads, as every integration
 * suite does.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
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
import { loadAgendaDraft } from "#/server/meeting-agenda-edit-logic";
import { insertMeetingWithSlots } from "#/server/meeting-create-logic";
import { type SeededClub, seedClub, testDb } from "./db";

export const DAY = 24 * 60 * 60 * 1000;

/** `seedClub()` with the stock roles and no meetings. */
export async function standardClub(): Promise<SeededClub> {
	const seeded = await seedClub();
	await testDb.delete(meetings).where(eq(meetings.clubId, seeded.clubId));
	await testDb
		.delete(roleDefinitions)
		.where(eq(roleDefinitions.id, seeded.roleDefinitionId));
	await testDb
		.insert(roleDefinitions)
		.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: seeded.clubId })));
	return seeded;
}

async function bank(clubId: string) {
	return testDb
		.select()
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId))
		.orderBy(asc(roleDefinitions.sortOrder));
}

/** A standard meeting created as the batch path creates one. */
export async function newMeeting(
	clubId: string,
	daysAhead: number,
	at?: Date,
): Promise<string> {
	const id = await testDb.transaction(async (tx) =>
		insertMeetingWithSlots(
			tx,
			{
				clubId,
				scheduledAt: at ?? new Date(Date.now() + daysAhead * DAY),
				lengthMinutes: 90,
				location: null,
			},
			await bank(clubId),
		),
	);
	if (!id) throw new Error("meeting not created");
	return id;
}

/**
 * A club template with the standard beats and every stock role except those in
 * `drop` (what a club that dropped a role would have saved).
 */
export async function leanTemplate(
	clubId: string,
	opts: { enabled?: boolean; drop?: string[]; name?: string } = {},
): Promise<string> {
	const drop = opts.drop ?? [];
	const [tpl] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId,
			meetingId: null,
			key: `lean-${randomUUID().slice(0, 8)}`,
			name: opts.name ?? "Lean meeting",
			enabled: opts.enabled ?? true,
		})
		.returning({ id: meetingTemplates.id });
	if (!tpl) throw new Error("no template");
	await testDb.insert(meetingTemplateBeats).values(
		materialiseRunOfShow(false, null)
			.filter((s) => !drop.includes(s.roleKey ?? ""))
			.map((s, i) => ({ ...s, sortOrder: i, templateId: tpl.id })),
	);
	await testDb.insert(meetingTemplateRoles).values(
		ROLE_TEMPLATE.filter((r) => !drop.includes(r.key)).map((r, i) => ({
			templateId: tpl.id,
			key: r.key,
			name: r.name,
			category: r.category,
			defaultCount: r.defaultCount,
			isSpeakerRole: r.isSpeakerRole,
			sortOrder: i,
		})),
	);
	return tpl.id;
}

/** Give ONE meeting a slot for a non-stock club role, claimed by `memberId` or open. */
export async function addSlot(
	clubId: string,
	meetingId: string,
	key: string,
	name: string,
	claimedBy: string | null,
): Promise<string> {
	await testDb
		.insert(roleDefinitions)
		.values({ clubId, key, name, category: "functionary", standing: false })
		.onConflictDoNothing();
	const [def] = await testDb
		.select({ id: roleDefinitions.id })
		.from(roleDefinitions)
		.where(
			and(eq(roleDefinitions.clubId, clubId), eq(roleDefinitions.key, key)),
		);
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId,
			roleDefinitionId: def?.id as string,
			...(claimedBy
				? {
						assignedMemberId: claimedBy,
						status: "claimed" as const,
						claimedAt: new Date(),
					}
				: {}),
		})
		.returning({ id: roleSlots.id });
	return slot?.id as string;
}

/** Open the meeting's editor (stores its private copy) and rename its first beat. */
export async function editFirstBeat(meetingId: string): Promise<void> {
	await loadAgendaDraft(meetingId);
	const [m] = await testDb
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, meetingId));
	const [first] = await testDb
		.select({ id: meetingTemplateBeats.id })
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, m?.templateId as string))
		.orderBy(asc(meetingTemplateBeats.sortOrder))
		.limit(1);
	await testDb
		.update(meetingTemplateBeats)
		.set({ label: "Our own opening" })
		.where(eq(meetingTemplateBeats.id, first?.id as string));
}

/**
 * Four upcoming scheduled meetings that a default carrying every stock role
 * sorts one into each bucket: untouched standard (applies), edited
 * (keptEdited), standard with a claimed role the default lacks (keptSignups),
 * standard with an open role the default lacks (keptRoles).
 */
export async function fourBucketMeetings(club: SeededClub) {
	const standard = await newMeeting(club.clubId, 7);
	const edited = await newMeeting(club.clubId, 14);
	const signups = await newMeeting(club.clubId, 21);
	const roles = await newMeeting(club.clubId, 28);
	await editFirstBeat(edited);
	await addSlot(
		club.clubId,
		signups,
		"joke_master",
		"Joke Master",
		club.memberId,
	);
	await addSlot(club.clubId, roles, "quiz_master", "Quiz Master", null);
	return { standard, edited, signups, roles };
}

/** Every stored row of every club-owned meeting_templates row, for before/after equality. */
export async function clubAgendaSnapshot(clubId: string) {
	const templates = await testDb
		.select()
		.from(meetingTemplates)
		.where(eq(meetingTemplates.clubId, clubId))
		.orderBy(asc(meetingTemplates.id));
	const beats = await testDb
		.select()
		.from(meetingTemplateBeats)
		.innerJoin(
			meetingTemplates,
			eq(meetingTemplates.id, meetingTemplateBeats.templateId),
		)
		.where(eq(meetingTemplates.clubId, clubId))
		.orderBy(asc(meetingTemplateBeats.id));
	const roles = await testDb
		.select()
		.from(meetingTemplateRoles)
		.innerJoin(
			meetingTemplates,
			eq(meetingTemplates.id, meetingTemplateRoles.templateId),
		)
		.where(eq(meetingTemplates.clubId, clubId))
		.orderBy(asc(meetingTemplateRoles.id));
	const meetingRows = await testDb
		.select()
		.from(meetings)
		.where(eq(meetings.clubId, clubId))
		.orderBy(asc(meetings.id));
	const slots = await testDb
		.select({ s: roleSlots })
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(meetings.clubId, clubId))
		.orderBy(asc(roleSlots.id));
	const clubRows = await testDb
		.select()
		.from(clubs)
		.where(eq(clubs.id, clubId));
	return { templates, beats, roles, meetingRows, slots, clubRows };
}
