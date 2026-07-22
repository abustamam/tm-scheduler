import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	clubs,
	guests,
	meetings,
	memberAvailability,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { resolveEvaluatorLinks } from "#/lib/agenda";
import {
	localDateKey,
	localDayRange,
	meetingUrlKey,
	urlKeysForMeetings,
} from "#/lib/meeting-url";
import { officerPositionLabel } from "#/lib/officers";
import {
	canManageClub,
	getSessionUser,
	requireClubRole,
	requireClubViewAccess,
	requireMeetingAgendaEditor,
	requireUser,
	requireWordOfTheDayEditor,
} from "./guards";
import {
	type Contact,
	contactKey,
	loadHolderContacts,
	loadRosterWithContact,
} from "./meeting-contacts-logic";
import { resolveMeetingKey } from "./meeting-resolve-logic";
import {
	applyCompleteMeeting,
	applyCreateMeeting,
	applyMeetingUpdate,
	applyReopenMeeting,
	applyWordOfTheDayUpdate,
} from "./meetings-logic";
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

	// canManage: only resolve when a session user is present; else false. A real
	// admin OR a superadmin with an active read_write impersonation session (#246)
	// manages the meeting; read_only impersonation does not surface write controls.
	let canManage = false;
	if (currentUserId) {
		canManage = await canManageClub(currentUserId, meeting.clubId);
	}

	const assignee = alias(members, "assignee");
	const guestAssignee = alias(guests, "assignee_guest");
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
			// assigneeId is the MEMBER id (null for a guest or open slot) — used for
			// "is mine" / roster flags. A guest assignee is carried separately.
			assigneeId: assignee.id,
			assigneeGuestId: guestAssignee.id,
			// The rendered assignee name resolves either source (#151); the caller
			// pairs it with `assigneeIsGuest` to show the "· Guest" marker.
			assigneeName: sql<
				string | null
			>`coalesce(${assignee.name}, ${guestAssignee.name})`,
			speechTitle: speeches.title,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
			minMinutes: speeches.minMinutes,
			maxMinutes: speeches.maxMinutes,
			presentationUrl: speeches.presentationUrl,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(assignee, eq(assignee.id, roleSlots.assignedMemberId))
		.leftJoin(guestAssignee, eq(guestAssignee.id, roleSlots.assignedGuestId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));

	// Flag guest-held slots so every read path can render the "· Guest" marker.
	const rowsWithGuestFlag = rows.map((r) => ({
		...r,
		assigneeIsGuest: r.assigneeGuestId != null,
	}));

	// Resolve which speaker each evaluator slot evaluates.
	const slots = resolveEvaluatorLinks(rowsWithGuestFlag);

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

	// Canonical date URL key for THIS meeting: club-local date, suffixed with
	// -HHmm only when the club has 2+ meetings that local day (date-urls feature).
	const tz = club?.timezone ?? "UTC";
	const { start: dayStart, end: dayEnd } = localDayRange(
		localDateKey(meeting.scheduledAt, tz),
		tz,
	);
	const [{ count: sameDayCount } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, meeting.clubId),
				gte(meetings.scheduledAt, dayStart),
				lt(meetings.scheduledAt, dayEnd),
				ne(meetings.status, "cancelled"),
			),
		);
	const urlKey = meetingUrlKey(meeting.scheduledAt, tz, sameDayCount >= 2);

	// The club's next non-cancelled meeting strictly after this one (spec: relative
	// to the presented meeting, not wall-clock now). Backs the Thank-You slide.
	const [nextMeeting] = await db
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, meeting.clubId),
				gte(meetings.scheduledAt, meeting.scheduledAt),
				ne(meetings.id, meeting.id),
				ne(meetings.status, "cancelled"),
			),
		)
		.orderBy(asc(meetings.scheduledAt))
		.limit(1);

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

	// Roster for the VPE assign/recruit picker — active members with contact for
	// tap-to-nudge (#37). Management-only: contact is never fetched for a public
	// caller (loadRosterWithContact isn't called when !canManage).
	const roster = canManage ? await loadRosterWithContact(meeting.clubId) : [];

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

	// Club guests for the admin assign picker (#151) — pick-an-existing-guest.
	// Management-only, like the roster; guests never appear on the public view.
	const clubGuests = canManage
		? await db
				.select({ id: guests.id, name: guests.name })
				.from(guests)
				.where(eq(guests.clubId, meeting.clubId))
				.orderBy(asc(guests.name))
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

	// Holder contact for filled-slot confirm nudges (#37). Gated: only queried
	// when the caller manages the club. `holderPhone`/`holderEmail` are null on
	// the public payload.
	const holderContacts = canManage
		? await loadHolderContacts(
				meeting.clubId,
				slots.flatMap((s) => (s.assigneeId ? [s.assigneeId] : [])),
				slots.flatMap((s) => (s.assigneeGuestId ? [s.assigneeGuestId] : [])),
			)
		: new Map<string, Contact>();

	const slotsWithContact = slots.map((s) => {
		const key = s.assigneeGuestId
			? contactKey("guest", s.assigneeGuestId)
			: s.assigneeId
				? contactKey("member", s.assigneeId)
				: null;
		const c = key ? holderContacts.get(key) : undefined;
		return {
			...s,
			holderPhone: c?.phone ?? null,
			holderEmail: c?.email ?? null,
		};
	});

	return {
		meeting,
		slots: slotsWithContact,
		canManage,
		roleRecency,
		nextMeetingAt: nextMeeting?.scheduledAt ?? null,
		timezone: club?.timezone ?? "UTC",
		clubName: club?.name ?? "",
		clubNumber: club?.clubNumber ?? null,
		clubSlug: club?.slug ?? "",
		urlKey,
		clubDistrict: club?.district ?? null,
		clubMission: club?.mission ?? null,
		clubMeetingSchedule: club?.meetingSchedule ?? null,
		officers,
		unavailableMembers,
		unavailableMemberIds: unavailableMembers.map((m) => m.id),
		roster,
		clubGuests,
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

const meetingKeyInput = z.object({ clubId: uuid, key: z.string().min(1) });

/**
 * Public meeting detail resolved by URL key (club-local date / date-HHmm / uuid),
 * session-aware `canManage`. Mirrors `getMeeting` but keyed by the pretty URL
 * segment. Throws "Meeting not found." (recognized by `isMeetingNotFoundError`)
 * when the key resolves to nothing, so route loaders render `notFound()`.
 */
export const getMeetingByKey = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingKeyInput.parse(input))
	.handler(async ({ data }) => {
		const meetingId = await resolveMeetingKey(data.clubId, data.key);
		if (!meetingId) throw new Error("Meeting not found.");
		const sessionUser = await getSessionUser();
		return loadMeetingDetail(meetingId, sessionUser?.id ?? null);
	});

/**
 * Public meeting detail resolved by URL key (share link, present, print). Forces
 * `canManage = false` regardless of the requester's session, so member/guest
 * CONTACT and other manager-only data are NEVER shipped on a public payload —
 * even to a signed-in admin checking what members see. The soft honor-system gate
 * on `/club/:clubId` must never carry PII (#37 / PR #284).
 */
export const getPublicMeetingByKey = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingKeyInput.parse(input))
	.handler(async ({ data }) => {
		const meetingId = await resolveMeetingKey(data.clubId, data.key);
		if (!meetingId) throw new Error("Meeting not found.");
		return loadMeetingDetail(meetingId, null);
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
		await requireClubViewAccess(currentUser.id, clubId);

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
		const rows = await db
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

		// A member belongs to one club, so every row shares a timezone; fall back
		// to UTC only for the (empty-rows) edge case.
		const timezone = rows[0]?.timezone ?? "UTC";
		const keys = urlKeysForMeetings(
			rows.map((r) => ({ id: r.meetingId, scheduledAt: r.scheduledAt })),
			timezone,
		);
		return rows.map((r) => ({
			...r,
			urlKey: keys.get(r.meetingId) ?? r.meetingId,
		}));
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

const updateWordOfTheDaySchema = z.object({
	meetingId: uuid,
	actorMemberId: uuid.nullable().optional(),
	/** Self-asserted TMOD/Grammarian member id (public page). Null for authed admin. */
	selfMemberId: uuid.nullable().optional(),
	wordOfTheDay: z.string().trim().optional(),
	wodDefinition: z.string().trim().optional(),
	wodExample: z.string().trim().optional(),
});

/** Edit only a meeting's Word of the Day (word + definition + example). Admin OR
 *  the meeting's self-asserted TMOD OR its self-asserted Grammarian (#296). A
 *  narrower capability than `updateMeeting`: it can't touch any other meta.
 *  AUTHED or self-assert. */
export const updateWordOfTheDay = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateWordOfTheDaySchema.parse(input))
	.handler(async ({ data }) => {
		await requireWordOfTheDayEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyWordOfTheDayUpdate({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
			wordOfTheDay: data.wordOfTheDay,
			wodDefinition: data.wodDefinition,
			wodExample: data.wodExample,
		});
	});

const lifecycleSchema = z.object({
	meetingId: uuid,
	actorMemberId: uuid.nullable().optional(),
});

/** Close out a meeting: set `status = completed` and lock its agenda (#150).
 *  Admin/manage-capability only; guarded to on/after the scheduled date. AUTHED. */
export const completeMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => lifecycleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, data.meetingId))
			.limit(1);
		if (!row) throw new Error("Meeting not found.");
		await requireClubRole(currentUser.id, row.clubId, ["admin"]);
		return applyCompleteMeeting({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

/** Reopen a completed meeting back to `scheduled` so it can be amended (#150).
 *  Admin/manage-capability only; no date guard. AUTHED. */
export const reopenMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => lifecycleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, data.meetingId))
			.limit(1);
		if (!row) throw new Error("Meeting not found.");
		await requireClubRole(currentUser.id, row.clubId, ["admin"]);
		return applyReopenMeeting({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
