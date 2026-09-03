import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	clubs,
	meetings,
	pathwaysProjects,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { MEETING_FIELDS, MEETING_UPDATE_FIELDS } from "#/lib/meeting-limits";
import {
	localDateKey,
	localDayRange,
	meetingUrlKey,
	urlKeysForMeetings,
} from "#/lib/meeting-url";
import { officerPositionLabel } from "#/lib/officers";
import { WOD_FIELDS, WOD_UPDATE_FIELDS } from "#/lib/wod-limits";
import {
	listNotComingWithNames,
	listPlanForMeetings,
} from "./attendance-plan-logic";
import {
	isReadableClubForMeeting,
	isReadableClubForMember,
} from "./club-readable-logic";
import {
	canManageClub,
	getSessionUser,
	requireClubRole,
	requireClubViewAccess,
	requireMeetingAgendaEditor,
	requireUser,
	requireWordOfTheDayEditor,
} from "./guards";
import { listClubGuests } from "./guests-logic";
import {
	type Contact,
	contactKey,
	loadHolderContacts,
	loadRosterWithContact,
} from "./meeting-contacts-logic";
import { resolveMeetingNumber } from "./meeting-number-logic";
import { resolvePublicMeetingKey } from "./meeting-resolve-logic";
import { loadMeetingSlots } from "./meeting-slots-logic";
import {
	loadTemplateContent,
	loadTemplateKey,
} from "./meeting-templates-logic";
import {
	applyCompleteMeeting,
	applyCreateMeeting,
	applyMeetingUpdate,
	applyReopenMeeting,
	applyWordOfTheDayUpdate,
	loadPublicUpcomingMeetings,
	loadTmodPanelData,
} from "./meetings-logic";
import { loadMyCommitments } from "./my-activity-logic";
import { currentOfficersForClub } from "./officer-terms-logic";
import { loadPastMeetings } from "./past-meetings-logic";
import { listRoleDefinitions } from "./role-definitions-logic";
import { indexRoleRecency, loadRoleRecency } from "./role-recency-logic";

const uuid = z.string().uuid();

/** Upcoming, non-cancelled meetings for a club, each with an open-slot count.
 *  PUBLIC — no session required, but NOT ungated: an archived club yields `[]`.
 *  The query and its archive gate live in `loadPublicUpcomingMeetings` because a
 *  `createServerFn` body is unreachable from a test (#544). */
export const listUpcomingMeetings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => loadPublicUpcomingMeetings(clubId));

const tmodPlanInput = z.object({
	meetingId: uuid,
	/** The caller's self-asserted member id, verified against the meeting's TMOD
	 *  slot inside `loadTmodPanelData`. Never trusted here. */
	memberId: uuid,
});

/**
 * The plan ladder AND the contact-bearing roster for this meeting's Toastmaster
 * (#576). Separate from `getMeetingDetail` on purpose — see `loadTmodPanelData`
 * for why neither may ride the public payload behind a client flag, and for the
 * privacy widening the roster half represents.
 *
 * The route calls this ONLY when the viewer is the TMOD and not already an
 * officer (an officer gets both on the payload). Returns empty arrays for
 * anyone else, so calling it speculatively leaks nothing.
 */
export const getTmodPanelData = createServerFn({ method: "GET" })
	.validator((i: unknown) => tmodPlanInput.parse(i))
	.handler(async ({ data }) => {
		// The session is read HERE and passed down, so `loadTmodPanelData` stays
		// callable from vitest with no request context. It gates the contact half
		// only; the ladder rides the self-asserted `memberId`.
		const user = await getSessionUser();
		return loadTmodPanelData({ ...data, sessionUserId: user?.id ?? null });
	});

const pastMeetingsInput = z.object({
	clubId: uuid,
	/** ISO instant; rows STRICTLY before it. Defaults to now. */
	before: z.string().min(1).optional(),
	limit: z.number().int().positive().max(100).optional(),
	offset: z.number().int().min(0).optional(),
});

/**
 * Past, non-cancelled meetings for a club, newest first — the archive behind
 * `/meetings` (#375) and the nav strip's backward paging.
 *
 * PUBLIC — no session required, exactly like `listUpcomingMeetings`, which it
 * mirrors. It carries the same non-PII columns (date, theme, location, status,
 * slot counts) and every page it links to is already public (#317/#327), so it
 * exposes nothing new; making it authed would leave the nav strip forward-only
 * for the anonymous visitor the strip fix is for.
 *
 * NOTE: the issue asked for a "minutes sent" flag per row. No such record
 * exists — `meetings` has no sent timestamp and `sendMeetingMinutesEmail` writes
 * none. The row reports `hasMinutes` (minutes actually recorded) instead.
 */
export const listPastMeetings = createServerFn({ method: "GET" })
	.validator((input: unknown) => pastMeetingsInput.parse(input))
	.handler(async ({ data }) =>
		loadPastMeetings({
			clubId: data.clubId,
			before: data.before ? new Date(data.before) : undefined,
			limit: data.limit,
			offset: data.offset,
		}),
	);

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

	// ONE loader, shared with the agenda editor (`meeting-slots-logic.ts`). The
	// editor computes its running clock from these same slots, so a second
	// query scoped to what it reads is how the two surfaces would come to
	// disagree about when the meeting ends.
	const slots = await loadMeetingSlots(meetingId);

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
			// The club's run-of-show variant (#367) — both renderers of this
			// payload (printed run sheet and projected deck) need it.
			geIntroducesFunctionaries: true,
			// The club's Table Topics window (#443), for the same reason and the
			// same two renderers: the Timer's marks on the printed row and the
			// "Speaker time:" line on the deck are derived from these two numbers,
			// so a club that states its own rule stops being contradicted by ours.
			tableTopicsMinSeconds: true,
			tableTopicsMaxSeconds: true,
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

	// Members recorded `not_coming` for this meeting, by themselves or by an
	// officer (with names, so the VPE can see who NOT to chase when filling open
	// roles). `not_coming` only: a plan row is no longer proof of absence, and
	// listing a member who just confirmed they are COMING is exactly backwards.
	const unavailableMembers = await listNotComingWithNames(db, meetingId);

	const allRungs = (await listPlanForMeetings(db, [meetingId])).map(
		({ memberId, status }) => ({ memberId, status }),
	);
	// The whole ladder for the officer's panel. Admin-only: `reached_out` is the
	// officer's private record of having asked, and it now shares one array with
	// the member's own answer.
	const plan = canManage ? allRungs : [];
	// The members' OWN answers, public. The personal strip must show a member the
	// answer they gave, and the server cannot resolve "my" — the viewer is known
	// only on the client (route:288), which is why the route derives its own
	// per-member ids by filtering this array locally, rather than the server
	// resolving a "my status" field. `reached_out` is filtered out HERE, once,
	// rather than at each consumer.
	const answeredRungs = allRungs.filter(
		(r): r is { memberId: string; status: "coming" | "not_coming" } =>
			r.status !== "reached_out",
	);

	// Roster for the VPE assign/recruit picker — active members with contact for
	// tap-to-nudge (#37). Management-only: contact is never fetched for a public
	// caller (loadRosterWithContact isn't called when !canManage).
	const roster = canManage ? await loadRosterWithContact(meeting.clubId) : [];

	// The meeting's template content (#agenda-templates). One extra round trip
	// only when `template_id` is set (its three reads run in parallel — see
	// `loadTemplateContent`), so a standard meeting pays nothing.
	//
	// THROW rather than fall through. `resolveAgendaRows` reads `template: null`
	// as "standard meeting", so a templated meeting whose content failed to load
	// would silently render the STANDARD beats against CONTEST slots — and since
	// no contest slot matches `toastmaster_of_the_day` or `speaker`, nearly every
	// beat gates out and the officer gets a near-empty agenda with no error at
	// all. A loud failure beats a blank sheet on contest night.
	let template = null;
	// The current template's `key` (not its id — see `loadTemplateKey`), for
	// the "Current" badge in the change-meeting-type dialog. A private copy's
	// id is fresh every conversion and matches no picker choice; its `key` is
	// what's stable.
	let templateKey: string | null = null;
	if (meeting.templateId) {
		[template, templateKey] = await Promise.all([
			loadTemplateContent(meeting.templateId),
			loadTemplateKey(meeting.templateId),
		]);
		if (!template) {
			throw new Error(
				`Meeting ${meeting.id} references template ${meeting.templateId}, which does not exist.`,
			);
		}
	}

	// Club role template for the "+ Add role" picker — management-only, like the
	// roster. Ordered like the roles page. Disabled roles (#368) are excluded via
	// `listRoleDefinitions`'s `onlyEnabled` — this picker OFFERS a role to be
	// filled, which is exactly what a "skeleton crew" club turned a role off to
	// stop; the roles admin page is where a disabled role stays visible. Routed
	// through the same helper `getPublicClubRoles` uses so "only enabled" is one
	// tested rule, not a second SQL filter that could drift from it.
	// Scoped to THIS meeting's shape (#agenda-templates): a templated meeting
	// offers its template's roles, not the club's standard ones. Unscoped, a
	// contest's picker lists Toastmaster and Grammarian and offers no way to add
	// a contestant.
	const clubRoles = canManage
		? (
				await listRoleDefinitions(meeting.clubId, {
					onlyEnabled: true,
					templateId: meeting.templateId,
				})
			).map((r) => ({
				id: r.id,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
			}))
		: [];

	// Club guests for the admin assign picker (#151) — pick-an-existing-guest.
	// Management-only, like the roster; guests never appear on the public view.
	//
	// Through `listClubGuests`, NOT an inline query (#637). This was its own
	// `select ... where club_id = ?` with no stage filter, so the picker offered
	// every guest in the club — including `joined` ones. Assigning one of those
	// puts `assigned_guest_id` on a slot for somebody who is a MEMBER, splitting
	// a human whose two records were just joined up (#635), and nothing refuses
	// it because assigning a guest to a slot is an ordinary operation.
	//
	// The seam had the correct filter and a comment saying exactly why converted
	// guests must be excluded. It survived because `loadMeetingDetail` is a
	// module-private function in a `createServerFn` module: unreachable from
	// vitest, so the copy had no coverage while the seam beside it did.
	//
	// Projected to `{ id, name }` deliberately. `listClubGuests` also selects
	// `email` and `phone` for the VP-Membership board, and the meeting payload
	// has never carried guest contact details — passing its rows straight
	// through would widen PII on this page as a side effect of a bug fix.
	const clubGuests = canManage
		? (await listClubGuests(meeting.clubId)).map((g) => ({
				id: g.id,
				name: g.name,
			}))
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
			holderPreferredName: c?.preferredName ?? null,
		};
	});

	// The number to DISPLAY (#358): the stored one, or derived by counting held
	// meetings forward from the club's most recent numbered meeting. Null when
	// the club has never numbered one. Renderers use THIS, not
	// `meeting.meetingNumber` (which is the raw stored column, often null).
	const meetingNumber = await resolveMeetingNumber(meetingId);

	return {
		meeting,
		meetingNumber,
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
		// MCF's variant (#367): the General Evaluator, not the Toastmaster of the
		// Day, introduces the functionaries. Feeds `buildRunOfShow` (print) and
		// `buildSlideDeck` (deck) so the two never disagree.
		geIntroducesFunctionaries: club?.geIntroducesFunctionaries ?? false,
		// Null means "not stated" and every surface falls back to the standard
		// 1–2 minute window — see `#/lib/table-topics-limits` (#443).
		tableTopicsMinSeconds: club?.tableTopicsMinSeconds ?? null,
		tableTopicsMaxSeconds: club?.tableTopicsMaxSeconds ?? null,
		// The meeting's template content (#agenda-templates), or null for a
		// standard meeting. Feeds `resolveAgendaRows` on both the screen and the
		// print route so the two cannot disagree about what the meeting is.
		template,
		// The current template's `key`, or null for a standard meeting — see
		// `loadTemplateKey`. Feeds the "Current" badge in the change-meeting-type
		// dialog; NOT the same value as `meeting.templateId`.
		templateKey,
		officers,
		unavailableMembers,
		plan,
		answeredRungs,
		roster,
		clubGuests,
		clubRoles,
	};
}

/** A meeting plus its ordered slots, assignees, speaker details, and evaluator→speaker links.
 *  PUBLIC — uses an optional session only to resolve canManage.
 *
 *  Archive-gated by MEETING id (#544). This one is easy to miss and the most
 *  costly to: it takes a bare `meetingId`, so the `resolvePublicMeetingKey` seam
 *  that gates the two key-based readers never applies, and it calls the SAME
 *  `loadMeetingDetail` they do. Leaving it open would have let the legacy
 *  `/meetings/:id` UUID — every pre-takedown bookmark is a working key — serve
 *  an archived club's full agenda straight around the gate on its sibling. */
export const getMeeting = createServerFn({ method: "GET" })
	.validator((meetingId: unknown) => uuid.parse(meetingId))
	.handler(async ({ data: meetingId }) => {
		if (!(await isReadableClubForMeeting(meetingId))) {
			throw new Error("Meeting not found.");
		}
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
		const meetingId = await resolvePublicMeetingKey(data.clubId, data.key);
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
		const meetingId = await resolvePublicMeetingKey(data.clubId, data.key);
		if (!meetingId) throw new Error("Meeting not found.");
		return loadMeetingDetail(meetingId, null);
	});

/**
 * The club's soonest upcoming (non-cancelled) meeting with its full agenda, or
 * `{ meeting: null }` when none is scheduled. Backs the `/next` shortcut, which
 * redirects to that meeting's canonical `/club/:clubId/meeting/:key` page. AUTHED
 * — any signed-in club member.
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
		return loadMyCommitments(currentUser.id);
	},
);

/** A member's upcoming claimed roles by memberId. PUBLIC — no session required.
 *  Mirrors `listMyCommitments` but keyed to the member param instead of the session.
 *
 *  NOTE: the select+where below duplicates `loadMyCommitments`
 *  (`my-activity-logic.ts`), which this file already imports — the only real
 *  difference is that this one decorates rows with `urlKey` afterwards. A third
 *  hand-copy lives in `public-reads.integration.test.ts` as its ONLY test, and
 *  it has already drifted (it omits `lengthMinutes`), so that test cannot see a
 *  defect present in both production copies. Worth unifying if a third caller
 *  ever lands; deliberately not tracked as an issue. */
export const listMemberCommitments = createServerFn({ method: "GET" })
	.validator((memberId: unknown) => uuid.parse(memberId))
	.handler(async ({ data: memberId }) => {
		// Archive-gated by MEMBER id (#544): this is public and keyed only by a
		// roster member, and each row carries the club's NAME plus the meeting's
		// date, theme and location.
		if (!(await isReadableClubForMember(memberId))) return [];
		// Same four aliases and the same coalesce pair as `loadMyCommitments` — the
		// evaluation-resource link has to reach THIS card too. CLAUDE.md calls the
		// anonymous roster-pick identity "the dominant path in this no-auth
		// product", so shipping the link only on the two `_authed` cards would have
		// missed the members most likely to want the form on their phone
		// mid-meeting. Adds no new exposure: the agenda already prints the project
		// publicly, so the only new datum is the PDF href.
		//
		// Yes, this widens the duplication the NOTE above already flags. It is a
		// deliberate trade at ship time over refactoring a public session-less
		// reader; the NOTE's "worth unifying" now has a third production caller
		// arguing for it.
		const speakerSlot = alias(roleSlots, "speaker_slot");
		const evaluatedSpeech = alias(speeches, "evaluated_speech");
		const evaluatedProject = alias(pathwaysProjects, "evaluated_project");
		const ownProject = alias(pathwaysProjects, "own_project");
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
				evaluatesSlotId: roleSlots.evaluatesSlotId,
				roleCategory: roleDefinitions.category,
				evaluatedProjectName: sql<string | null>`
					coalesce(${evaluatedProject.name}, ${evaluatedSpeech.projectName})
				`,
				ownProjectName: sql<string | null>`
					coalesce(${ownProject.name}, ${speeches.projectName})
				`,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
			.leftJoin(ownProject, eq(ownProject.id, speeches.projectId))
			.leftJoin(speakerSlot, eq(speakerSlot.id, roleSlots.evaluatesSlotId))
			.leftJoin(evaluatedSpeech, eq(evaluatedSpeech.id, speakerSlot.speechId))
			.leftJoin(
				evaluatedProject,
				eq(evaluatedProject.id, evaluatedSpeech.projectId),
			)
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
	location: MEETING_FIELDS.location.optional(),
	theme: MEETING_FIELDS.theme.optional(),
	wordOfTheDay: WOD_FIELDS.word.optional(),
	notes: MEETING_FIELDS.notes.optional(),
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

// No `actorMemberId` on the wire (#396) — see `speakerSlotSchema` in slots.ts:
// the agenda-editor guard resolves who the caller is and that is what is logged.
const updateMeetingSchema = z.object({
	meetingId: uuid,
	/** Self-asserted TMOD member id (public page). Null for authed admin. */
	selfMemberId: uuid.nullable().optional(),
	scheduledAt: z.string().min(1),
	lengthMinutes: z.number().int().positive().optional(),
	location: MEETING_UPDATE_FIELDS.location.optional(),
	theme: MEETING_UPDATE_FIELDS.theme.optional(),
	wordOfTheDay: WOD_UPDATE_FIELDS.word.optional(),
	wodDefinition: WOD_UPDATE_FIELDS.definition.optional(),
	wodExample: WOD_UPDATE_FIELDS.example.optional(),
	notes: MEETING_UPDATE_FIELDS.notes.optional(),
	reminders: MEETING_UPDATE_FIELDS.reminders.optional(),
	// The club's meeting number (#358). Nullable = cleared back to derived.
	meetingNumber: z.number().int().positive().nullable().optional(),
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
			actorMemberId: authz.actorMemberId,
			canReschedule: authz.via === "admin",
		});
	});

const updateWordOfTheDaySchema = z.object({
	meetingId: uuid,
	/** Self-asserted TMOD/Grammarian member id (public page). Null for authed admin. */
	selfMemberId: uuid.nullable().optional(),
	wordOfTheDay: WOD_FIELDS.word.optional(),
	wodDefinition: WOD_FIELDS.definition.optional(),
	wodExample: WOD_FIELDS.example.optional(),
});

/** Edit only a meeting's Word of the Day (word + definition + example). Admin OR
 *  the meeting's self-asserted TMOD OR its self-asserted Grammarian (#296). A
 *  narrower capability than `updateMeeting`: it can't touch any other meta.
 *  AUTHED or self-assert. */
export const updateWordOfTheDay = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateWordOfTheDaySchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireWordOfTheDayEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyWordOfTheDayUpdate({
			meetingId: data.meetingId,
			actorMemberId: authz.actorMemberId,
			wordOfTheDay: data.wordOfTheDay,
			wodDefinition: data.wodDefinition,
			wodExample: data.wodExample,
		});
	});

const lifecycleSchema = z.object({
	meetingId: uuid,
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
		const membership = await requireClubRole(currentUser.id, row.clubId, [
			"admin",
		]);
		return applyCompleteMeeting({
			meetingId: data.meetingId,
			actorMemberId: membership.id,
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
		const membership = await requireClubRole(currentUser.id, row.clubId, [
			"admin",
		]);
		return applyReopenMeeting({
			meetingId: data.meetingId,
			actorMemberId: membership.id,
		});
	});
