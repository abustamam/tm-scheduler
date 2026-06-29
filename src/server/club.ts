import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speakerDetails,
	user,
} from "#/db/schema";
import { requireMembership, requireUser } from "./guards";

const uuid = z.string().uuid();

/**
 * Resolve the Better-Auth user id backing a roster member, if any. Ordinary
 * roster members are auth-free (`members.userId` is NULL); we bridge to their
 * historical assignments by the admin link or an email match.
 *
 * TODO(cutover): once `role_slots.assigned_user_id` is re-keyed to
 * `assigned_member_id` (see docs/superpowers/specs), history keys directly to
 * the member and this user bridge goes away.
 */
async function emailToUserId(): Promise<Map<string, string>> {
	const rows = await db.select({ id: user.id, email: user.email }).from(user);
	return new Map(rows.map((r) => [r.email, r.id]));
}

/**
 * A club's roster members (from the `members` table — the no-auth roster) with
 * a "speeches given" count bridged from the role-slot history.
 *
 * Pathways progress (path / level / % / project) and member status have NO
 * model — those stay mocked in the view (see docs/persistence-todo.md).
 */
export const listClubMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, clubId);

		const roster = await db
			.select({
				id: members.id,
				name: members.name,
				email: members.email,
				office: members.office,
				userId: members.userId,
				createdAt: members.createdAt,
			})
			.from(members)
			.where(eq(members.clubId, clubId))
			.orderBy(asc(members.name));

		const speechRows = await db
			.select({
				userId: roleSlots.assignedUserId,
				speeches: sql<number>`count(*)::int`,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(meetings.clubId, clubId),
					eq(roleDefinitions.isSpeakerRole, true),
				),
			)
			.groupBy(roleSlots.assignedUserId);

		const speechByUser = new Map(
			speechRows
				.filter((r) => r.userId)
				.map((r) => [r.userId as string, r.speeches]),
		);
		const emailMap = await emailToUserId();

		return roster.map((m) => {
			const linkedUserId =
				m.userId ?? (m.email ? (emailMap.get(m.email) ?? null) : null);
			return {
				id: m.id,
				name: m.name,
				email: m.email,
				office: m.office,
				createdAt: m.createdAt,
				speeches: linkedUserId ? (speechByUser.get(linkedUserId) ?? 0) : 0,
			};
		});
	});

export interface SpeechLogRow {
	slotId: string;
	scheduledAt: Date;
	roleName: string;
	speechTitle: string | null;
	projectName: string | null;
	pathwayPath: string | null;
	projectLevel: string | null;
	evaluatorName: string | null;
	status: "open" | "claimed" | "confirmed";
}

/** A member's speaker-slot history (most recent first), with the evaluator resolved. */
async function loadSpeechLog(
	userId: string,
	clubId: string | null,
	limit: number,
): Promise<SpeechLogRow[]> {
	const evaluatorSlot = alias(roleSlots, "evaluator_slot");
	const evaluatorUser = alias(user, "evaluator_user");

	return db
		.select({
			slotId: roleSlots.id,
			scheduledAt: meetings.scheduledAt,
			roleName: roleDefinitions.name,
			speechTitle: speakerDetails.speechTitle,
			projectName: speakerDetails.projectName,
			pathwayPath: speakerDetails.pathwayPath,
			projectLevel: speakerDetails.projectLevel,
			evaluatorName: evaluatorUser.name,
			status: roleSlots.status,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.leftJoin(speakerDetails, eq(speakerDetails.slotId, roleSlots.id))
		.leftJoin(evaluatorSlot, eq(evaluatorSlot.evaluatesSlotId, roleSlots.id))
		.leftJoin(evaluatorUser, eq(evaluatorUser.id, evaluatorSlot.assignedUserId))
		.where(
			and(
				eq(roleSlots.assignedUserId, userId),
				eq(roleDefinitions.isSpeakerRole, true),
				clubId ? eq(meetings.clubId, clubId) : undefined,
			),
		)
		.orderBy(desc(meetings.scheduledAt))
		.limit(limit);
}

/** Roles a member has served (any role), grouped by role name, for the current calendar year. */
async function loadRolesServed(userId: string, clubId: string) {
	const yearStart = new Date(new Date().getFullYear(), 0, 1);
	return db
		.select({
			name: roleDefinitions.name,
			count: sql<number>`count(*)::int`,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(roleSlots.assignedUserId, userId),
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, yearStart),
			),
		)
		.groupBy(roleDefinitions.name)
		.orderBy(desc(sql`count(*)`));
}

/** A roster member's profile: real identity + speech log + roles served. Pathways/awards stay mocked. */
export const getMemberProfile = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ clubId: uuid, memberId: uuid }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, data.clubId);

		const [member] = await db
			.select({
				id: members.id,
				name: members.name,
				email: members.email,
				office: members.office,
				userId: members.userId,
				createdAt: members.createdAt,
			})
			.from(members)
			.where(
				and(eq(members.id, data.memberId), eq(members.clubId, data.clubId)),
			)
			.limit(1);

		if (!member) {
			return { member: null, speechLog: [], rolesServed: [], speeches: 0 };
		}

		// Bridge to the member's auth user (admin link or email match) for history.
		let linkedUserId = member.userId;
		if (!linkedUserId && member.email) {
			const [u] = await db
				.select({ id: user.id })
				.from(user)
				.where(eq(user.email, member.email))
				.limit(1);
			linkedUserId = u?.id ?? null;
		}

		const speechLog = linkedUserId
			? await loadSpeechLog(linkedUserId, data.clubId, 6)
			: [];
		const rolesServed = linkedUserId
			? await loadRolesServed(linkedUserId, data.clubId)
			: [];

		return {
			member: {
				id: member.id,
				name: member.name,
				email: member.email,
				office: member.office,
				createdAt: member.createdAt,
			},
			speechLog,
			rolesServed,
			speeches: speechLog.length,
		};
	});

/** The current user's recent speech history (across their clubs). Backs the dashboard speech log. */
export const listMySpeeches = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		return loadSpeechLog(currentUser.id, null, 6);
	},
);
