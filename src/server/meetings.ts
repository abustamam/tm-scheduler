import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	clubs,
	meetings,
	roleDefinitions,
	roleSlots,
	speakerDetails,
	user,
} from "#/db/schema";
import { generateSlotRows, resolveEvaluatorLinks } from "#/lib/agenda";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { requireClubRole, requireMembership, requireUser } from "./guards";

const uuid = z.string().uuid();

/** Upcoming, non-cancelled meetings for a club, each with an open-slot count. */
export const listUpcomingMeetings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, clubId);

		return db
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				theme: meetings.theme,
				location: meetings.location,
				status: meetings.status,
				timezone: clubs.timezone,
				openSlots: sql<number>`count(*) filter (where ${roleSlots.status} = 'open')::int`,
				totalSlots: sql<number>`count(${roleSlots.id})::int`,
			})
			.from(meetings)
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.leftJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
			.where(
				and(
					eq(meetings.clubId, clubId),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
				),
			)
			.groupBy(meetings.id, clubs.timezone)
			.orderBy(asc(meetings.scheduledAt));
	});

/** A meeting plus its ordered slots, assignees, speaker details, and evaluator→speaker links. */
export const getMeeting = createServerFn({ method: "GET" })
	.validator((meetingId: unknown) => uuid.parse(meetingId))
	.handler(async ({ data: meetingId }) => {
		const currentUser = await requireUser();

		const meeting = await db.query.meetings.findFirst({
			where: eq(meetings.id, meetingId),
		});
		if (!meeting) {
			throw new Error("Meeting not found.");
		}
		const membership = await requireMembership(currentUser.id, meeting.clubId);
		const canManage =
			membership.clubRole === "admin" || membership.clubRole === "vpe";

		const assignee = alias(user, "assignee");
		const rows = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				slotIndex: roleSlots.slotIndex,
				claimedAt: roleSlots.claimedAt,
				evaluatesSlotId: roleSlots.evaluatesSlotId,
				roleName: roleDefinitions.name,
				category: roleDefinitions.category,
				sortOrder: roleDefinitions.sortOrder,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				assigneeId: assignee.id,
				assigneeName: assignee.name,
				speechTitle: speakerDetails.speechTitle,
				pathwayPath: speakerDetails.pathwayPath,
				projectName: speakerDetails.projectName,
				projectLevel: speakerDetails.projectLevel,
				minMinutes: speakerDetails.minMinutes,
				maxMinutes: speakerDetails.maxMinutes,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(assignee, eq(assignee.id, roleSlots.assignedUserId))
			.leftJoin(speakerDetails, eq(speakerDetails.slotId, roleSlots.id))
			.where(eq(roleSlots.meetingId, meetingId))
			.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));

		// Resolve which speaker each evaluator slot evaluates.
		const slots = resolveEvaluatorLinks(rows);

		const club = await db.query.clubs.findFirst({
			where: eq(clubs.id, meeting.clubId),
			columns: { timezone: true },
		});

		return { meeting, slots, canManage, timezone: club?.timezone ?? "UTC" };
	});

/** The current user's upcoming claimed roles across every club they belong to. */
export const listMyCommitments = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		return db
			.select({
				slotId: roleSlots.id,
				status: roleSlots.status,
				meetingId: meetings.id,
				scheduledAt: meetings.scheduledAt,
				theme: meetings.theme,
				location: meetings.location,
				clubName: clubs.name,
				timezone: clubs.timezone,
				roleName: roleDefinitions.name,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				speechTitle: speakerDetails.speechTitle,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(speakerDetails, eq(speakerDetails.slotId, roleSlots.id))
			.where(
				and(
					eq(roleSlots.assignedUserId, currentUser.id),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
				),
			)
			.orderBy(asc(meetings.scheduledAt));
	},
);

const createMeetingSchema = z.object({
	clubId: uuid,
	// HTML datetime-local value, interpreted in the club's timezone.
	scheduledAt: z.string().min(1),
	location: z.string().trim().optional(),
	theme: z.string().trim().optional(),
	wordOfTheDay: z.string().trim().optional(),
	notes: z.string().trim().optional(),
});

/** Admin/VPE only: create a meeting and auto-generate its slots from the club's template. */
export const createMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => createMeetingSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);

		const club = await db.query.clubs.findFirst({
			where: eq(clubs.id, data.clubId),
		});
		if (!club) throw new Error("Club not found.");
		const scheduledAt = zonedWallTimeToUtc(data.scheduledAt, club.timezone);

		const defs = await db
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, data.clubId))
			.orderBy(asc(roleDefinitions.sortOrder));

		return db.transaction(async (tx) => {
			const [meeting] = await tx
				.insert(meetings)
				.values({
					clubId: data.clubId,
					scheduledAt,
					location: data.location || null,
					theme: data.theme || null,
					wordOfTheDay: data.wordOfTheDay || null,
					notes: data.notes || null,
				})
				.returning({ id: meetings.id });

			const slotRows = generateSlotRows(defs, meeting.id);
			if (slotRows.length > 0) {
				await tx.insert(roleSlots).values(slotRows);
			}
			return { meetingId: meeting.id };
		});
	});
