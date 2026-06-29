import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	clubMemberships,
	meetings,
	roleDefinitions,
	roleSlots,
	speakerDetails,
	user,
} from "#/db/schema";
import { requireMembership, requireUser } from "./guards";

const uuid = z.string().uuid();

/**
 * A club's active members with a real "speeches given" count derived from the
 * role-slot history (count of speaker-role slots assigned to each member).
 *
 * Pathways progress (path / level / % / project) and member status are NOT in
 * the schema — those stay mocked in the view (see docs/persistence-todo.md).
 */
export const listClubMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, clubId);

		const members = await db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				clubRole: clubMemberships.clubRole,
				joinedAt: clubMemberships.joinedAt,
			})
			.from(clubMemberships)
			.innerJoin(user, eq(user.id, clubMemberships.userId))
			.where(
				and(
					eq(clubMemberships.clubId, clubId),
					eq(clubMemberships.status, "active"),
				),
			)
			.orderBy(asc(user.name));

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

		return members.map((m) => ({
			...m,
			speeches: speechByUser.get(m.id) ?? 0,
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
	userId: string,
	clubId: string | null,
	limit: number,
): Promise<SpeechLogRow[]> {
	const evaluatorSlot = alias(roleSlots, "evaluator_slot");
	const evaluatorUser = alias(user, "evaluator_user");

	const rows = await db
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

	return rows;
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

/** A member's profile: real identity + speech log + roles served. Pathways/awards stay mocked. */
export const getMemberProfile = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ clubId: uuid, userId: z.string().min(1) }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, data.clubId);

		const [member] = await db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				clubRole: clubMemberships.clubRole,
				joinedAt: clubMemberships.joinedAt,
			})
			.from(clubMemberships)
			.innerJoin(user, eq(user.id, clubMemberships.userId))
			.where(
				and(
					eq(clubMemberships.clubId, data.clubId),
					eq(clubMemberships.userId, data.userId),
				),
			)
			.limit(1);

		if (!member) {
			return { member: null, speechLog: [], rolesServed: [], speeches: 0 };
		}

		const speechLog = await loadSpeechLog(data.userId, data.clubId, 6);
		const rolesServed = await loadRolesServed(data.userId, data.clubId);
		const speeches = speechLog.length;

		return { member, speechLog, rolesServed, speeches };
	});

/** The current user's recent speech history (across their clubs). Backs the dashboard speech log. */
export const listMySpeeches = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		return loadSpeechLog(currentUser.id, null, 6);
	},
);
