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
} from "#/db/schema";
import { requireMembership, requireUser } from "./guards";

const uuid = z.string().uuid();

/**
 * A club's roster members (from the `members` table — the no-auth roster) with
 * a "speeches given" count keyed directly to the member row.
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
				status: members.status,
				createdAt: members.createdAt,
				joinedAt: members.joinedAt,
				originalJoinDate: members.originalJoinDate,
			})
			.from(members)
			.where(eq(members.clubId, clubId))
			.orderBy(asc(members.name));

		const speechRows = await db
			.select({
				memberId: roleSlots.assignedMemberId,
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
			.groupBy(roleSlots.assignedMemberId);

		const speechByMember = new Map(
			speechRows
				.filter((r) => r.memberId)
				.map((r) => [r.memberId as string, r.speeches]),
		);

		return roster.map((m) => ({
			id: m.id,
			name: m.name,
			email: m.email,
			office: m.office,
			userId: m.userId,
			status: m.status,
			createdAt: m.createdAt,
			joinedAt: m.joinedAt,
			originalJoinDate: m.originalJoinDate,
			speeches: speechByMember.get(m.id) ?? 0,
		}));
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
	memberId: string,
	clubId: string | null,
	limit: number,
): Promise<SpeechLogRow[]> {
	const evaluatorSlot = alias(roleSlots, "evaluator_slot");
	const evaluatorMember = alias(members, "evaluator_member");

	return db
		.select({
			slotId: roleSlots.id,
			scheduledAt: meetings.scheduledAt,
			roleName: roleDefinitions.name,
			speechTitle: speakerDetails.speechTitle,
			projectName: speakerDetails.projectName,
			pathwayPath: speakerDetails.pathwayPath,
			projectLevel: speakerDetails.projectLevel,
			evaluatorName: evaluatorMember.name,
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
		.leftJoin(
			evaluatorMember,
			eq(evaluatorMember.id, evaluatorSlot.assignedMemberId),
		)
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				eq(roleDefinitions.isSpeakerRole, true),
				clubId ? eq(meetings.clubId, clubId) : undefined,
			),
		)
		.orderBy(desc(meetings.scheduledAt))
		.limit(limit);
}

/** Roles a member has served (any role), grouped by role name, for the current calendar year. */
async function loadRolesServed(memberId: string, clubId: string) {
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
				eq(roleSlots.assignedMemberId, memberId),
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
				phone: members.phone,
				office: members.office,
				userId: members.userId,
				status: members.status,
				createdAt: members.createdAt,
				joinedAt: members.joinedAt,
				originalJoinDate: members.originalJoinDate,
			})
			.from(members)
			.where(
				and(eq(members.id, data.memberId), eq(members.clubId, data.clubId)),
			)
			.limit(1);

		if (!member) {
			return { member: null, speechLog: [], rolesServed: [], speeches: 0 };
		}

		// History keys directly to the member row — no user bridge needed.
		const speechLog = await loadSpeechLog(member.id, data.clubId, 6);
		const rolesServed = await loadRolesServed(member.id, data.clubId);

		return {
			member: {
				id: member.id,
				name: member.name,
				email: member.email,
				phone: member.phone,
				office: member.office,
				userId: member.userId,
				status: member.status,
				createdAt: member.createdAt,
				joinedAt: member.joinedAt,
				originalJoinDate: member.originalJoinDate,
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

		// Resolve the signed-in user's linked roster member.
		const [myMember] = await db
			.select({ id: members.id })
			.from(members)
			.where(eq(members.userId, currentUser.id))
			.limit(1);

		if (!myMember) {
			return [];
		}

		return loadSpeechLog(myMember.id, null, 6);
	},
);
