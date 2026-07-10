import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	clubs,
	meetings,
	memberAvailability,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { resolveEvaluatorLinks } from "#/lib/agenda";
import { officerPositionLabel } from "#/lib/officers";
import {
	getMembership,
	getSessionUser,
	requireClubRole,
	requireMeetingAgendaEditor,
	requireMembership,
	requireUser,
} from "./guards";
import { applyCreateMeeting, applyMeetingUpdate } from "./meetings-logic";
import { currentOfficersForClub } from "./officer-terms-logic";
import { indexRoleRecency, loadRoleRecency } from "./role-recency-logic";

const uuid = z.string().uuid();

/** Upcoming, non-cancelled meetings for a club, each with an open-slot count.
 *  PUBLIC — no session required. */
export const listUpcomingMeetings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
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

/**
 * Load a meeting plus its ordered slots, assignees, speaker details, and
 * evaluator→speaker links. Shared by `getMeeting` (public) and `getNextMeeting` (authed).
 *
 * `currentUserId` is optional: when null/undefined, canManage is false.
 * When set, the user's membership is checked for admin status.
 */
async function loadMeetingDetail(
	meetingId: string,
	currentUserId?: string | null,
) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
	});
	if (!meeting) {
		throw new Error("Meeting not found.");
	}

	// canManage: only resolve when a session user is present; else false.
	let canManage = false;
	if (currentUserId) {
		const membership = await getMembership(currentUserId, meeting.clubId);
		canManage = membership?.clubRole === "admin";
	}

	const assignee = alias(members, "assignee");
	const rows = await db
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			status: roleSlots.status,
			slotIndex: roleSlots.slotIndex,
			claimedAt: roleSlots.claimedAt,
			evaluatesSlotId: roleSlots.evaluatesSlotId,
			roleName: roleDefinitions.name,
			category: roleDefinitions.category,
			description: roleDefinitions.description,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			assigneeId: assignee.id,
			assigneeName: assignee.name,
			speechTitle: speeches.title,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
			minMinutes: speeches.minMinutes,
			maxMinutes: speeches.maxMinutes,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(assignee, eq(assignee.id, roleSlots.assignedMemberId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));

	// Resolve which speaker each evaluator slot evaluates.
	const slots = resolveEvaluatorLinks(rows);

	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
		columns: {
			timezone: true,
			name: true,
			slug: true,
			clubNumber: true,
			district: true,
			mission: true,
			meetingSchedule: true,
		},
	});

	// Officers for the printable agenda's officer grid (#100). The full agenda
	// line-up (President → Sergeant at Arms; Immediate Past President is left off
	// the agenda), in canonical order — a vacant office comes back as name: null
	// and prints as "Open" so every seat is visible. A member holding two offices
	// shows once per office. The grid shows human labels.
	const officerRows = await currentOfficersForClub(meeting.clubId);
	const officers = officerRows.map((o) => ({
		office: officerPositionLabel(o.position),
		name: o.name ?? "Open",
	}));

	// Members who've marked themselves Not Available for this meeting (with
	// names, so the VPE can see who NOT to chase when filling open roles).
	const unavailableMembers = await db
		.select({ id: members.id, name: members.name })
		.from(memberAvailability)
		.innerJoin(members, eq(members.id, memberAvailability.memberId))
		.where(eq(memberAvailability.meetingId, meetingId))
		.orderBy(asc(members.name));

	// Roster for the VPE assign picker — active members only. Kept out of the
	// public/unauthenticated payload: only populated when the caller can manage.
	const roster = canManage
		? await db
				.select({ id: members.id, name: members.name })
				.from(members)
				.where(
					and(eq(members.clubId, meeting.clubId), eq(members.status, "active")),
				)
				.orderBy(asc(members.name))
		: [];

	// Club role template for the "+ Add role" picker — management-only, like the
	// roster. Ordered like the roles page.
	const clubRoles = canManage
		? await db
				.select({
					id: roleDefinitions.id,
					name: roleDefinitions.name,
					category: roleDefinitions.category,
					defaultCount: roleDefinitions.defaultCount,
					sortOrder: roleDefinitions.sortOrder,
					isSpeakerRole: roleDefinitions.isSpeakerRole,
				})
				.from(roleDefinitions)
				.where(eq(roleDefinitions.clubId, meeting.clubId))
				.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name))
		: [];

	// Role recency for the assign picker (#146): per role, when each member last
	// held it in a prior non-cancelled meeting. Management-only, like the roster.
	const roleRecency = canManage
		? indexRoleRecency(
				await loadRoleRecency({
					clubId: meeting.clubId,
					before: meeting.scheduledAt,
				}),
			)
		: {};

	return {
		meeting,
		slots,
		canManage,
		roleRecency,
		timezone: club?.timezone ?? "UTC",
		clubName: club?.name ?? "",
		clubNumber: club?.clubNumber ?? null,
		clubSlug: club?.slug ?? "",
		clubDistrict: club?.district ?? null,
		clubMission: club?.mission ?? null,
		clubMeetingSchedule: club?.meetingSchedule ?? null,
		officers,
		unavailableMembers,
		unavailableMemberIds: unavailableMembers.map((m) => m.id),
		roster,
		clubRoles,
	};
}

/** A meeting plus its ordered slots, assignees, speaker details, and evaluator→speaker links.
 *  PUBLIC — uses an optional session only to resolve canManage. */
export const getMeeting = createServerFn({ method: "GET" })
	.validator((meetingId: unknown) => uuid.parse(meetingId))
	.handler(async ({ data: meetingId }) => {
		// Optional session: may be null (no-session callers get canManage=false).
		const sessionUser = await getSessionUser();
		return loadMeetingDetail(meetingId, sessionUser?.id ?? null);
	});

/**
 * The club's soonest upcoming (non-cancelled) meeting with its full agenda, or
 * `{ meeting: null }` when none is scheduled. Backs the `/next` shortcut, which
 * redirects to that meeting's `/meetings/$id` page. AUTHED — any signed-in club
 * member.
 */
export const getNextMeeting = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, clubId);

		const [next] = await db
			.select({ id: meetings.id })
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, clubId),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
				),
			)
			.orderBy(asc(meetings.scheduledAt))
			.limit(1);

		if (!next) {
			return {
				meeting: null,
				slots: [] as Awaited<ReturnType<typeof loadMeetingDetail>>["slots"],
				canManage: false,
				timezone: "UTC",
				clubName: "",
				clubSlug: "",
			};
		}
		return loadMeetingDetail(next.id, currentUser.id);
	});

/** The current user's upcoming claimed roles across every club they belong to.
 *  AUTHED — VPE dashboard only. */
export const listMyCommitments = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();

		// Resolve the signed-in user → Person (people.user_id) → their roster
		// member(s) (ADR-0008 Phase B).
		const myMembers = await db
			.select({ id: members.id })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(eq(people.userId, currentUser.id));

		if (myMembers.length === 0) {
			return [];
		}

		// Use the first linked member (typical: one user = one member).
		const memberId = myMembers[0].id;

		return db
			.select({
				slotId: roleSlots.id,
				status: roleSlots.status,
				meetingId: meetings.id,
				scheduledAt: meetings.scheduledAt,
				lengthMinutes: meetings.lengthMinutes,
				theme: meetings.theme,
				location: meetings.location,
				clubName: clubs.name,
				timezone: clubs.timezone,
				roleName: roleDefinitions.name,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				speechTitle: speeches.title,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, memberId),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
				),
			)
			.orderBy(asc(meetings.scheduledAt));
	},
);

/** A member's upcoming claimed roles by memberId. PUBLIC — no session required.
 *  Mirrors `listMyCommitments` but keyed to the member param instead of the session. */
export const listMemberCommitments = createServerFn({ method: "GET" })
	.validator((memberId: unknown) => uuid.parse(memberId))
	.handler(async ({ data: memberId }) => {
		return db
			.select({
				slotId: roleSlots.id,
				status: roleSlots.status,
				meetingId: meetings.id,
				scheduledAt: meetings.scheduledAt,
				lengthMinutes: meetings.lengthMinutes,
				theme: meetings.theme,
				location: meetings.location,
				clubName: clubs.name,
				timezone: clubs.timezone,
				roleName: roleDefinitions.name,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				speechTitle: speeches.title,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, memberId),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
				),
			)
			.orderBy(asc(meetings.scheduledAt));
	});

const createMeetingSchema = z.object({
	clubId: uuid,
	// HTML datetime-local value, interpreted in the club's timezone.
	scheduledAt: z.string().min(1),
	location: z.string().trim().optional(),
	theme: z.string().trim().optional(),
	wordOfTheDay: z.string().trim().optional(),
	notes: z.string().trim().optional(),
});

/** Admin/VPE only: create a meeting and auto-generate its slots from the club's template.
 *  AUTHED — requires admin club role. */
export const createMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => createMeetingSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyCreateMeeting(data);
	});

const updateMeetingSchema = z.object({
	meetingId: uuid,
	actorMemberId: uuid.nullable().optional(),
	/** Self-asserted TMOD member id (public page). Null for authed admin. */
	selfMemberId: uuid.nullable().optional(),
	scheduledAt: z.string().min(1),
	lengthMinutes: z.number().int().positive().optional(),
	location: z.string().trim().optional(),
	theme: z.string().trim().optional(),
	wordOfTheDay: z.string().trim().optional(),
	wodDefinition: z.string().trim().optional(),
	wodExample: z.string().trim().optional(),
	notes: z.string().trim().optional(),
	reminders: z.string().trim().optional(),
});

/** Edit a meeting's meta. Admin/VPE (may also reschedule) OR the meeting's
 *  self-asserted TMOD (meta only — reschedule rejected). AUTHED or self-assert. */
export const updateMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateMeetingSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyMeetingUpdate({
			...data,
			actorMemberId: data.actorMemberId ?? null,
			canReschedule: authz.via === "admin",
		});
	});
