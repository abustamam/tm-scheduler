import { and, asc, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	guests,
	meetingOutreach,
	meetings,
	memberAvailability,
	members,
	roleDefinitions,
	roleSlots,
	type slotStatusEnum,
} from "#/db/schema";
import { buildRoleCounts, buildShortCodes, slotLabel } from "#/lib/agenda";
import { urlKeysForMeetings } from "#/lib/meeting-url";
import { coalesceToE164, DEFAULT_COUNTRY_CODE } from "#/lib/phone";
import { isReadableClub } from "./club-readable-logic";

export type SeasonGridCount = 4 | 8 | "all";
export type SlotStatus = (typeof slotStatusEnum.enumValues)[number];

export interface SeasonGridMeeting {
	id: string;
	scheduledAt: string;
	timezone: string;
	/** Club-local-date URL key for the public meeting view (#214 follow-up).
	 *  Falls back to `id` if it can't be resolved. */
	urlKey: string;
	openCount: number;
	totalSlots: number;
	isPast: boolean;
	isAnchor: boolean;
	/** #150: a completed (locked) meeting reads distinctly from a scheduled one. */
	isCompleted: boolean;
}
export interface SeasonGridRow {
	roleDefinitionId: string;
	/** A speaking slot — the member×meeting role picker uses this to nudge for
	 *  speech details after assigning one. */
	isSpeakerRole: boolean;
	slotIndex: number;
	label: string; // "Speaker 2" (hover)
	shortCode: string; // "SP2"
	sortOrder: number;
}
export interface SeasonGridMember {
	id: string;
	name: string;
	/** Present only on the member axis when contact is included (authed).
	 *  Never populated for the public sheet or for name-only lookups. */
	email?: string | null;
	phone?: string | null;
}
export interface SeasonGridCell {
	/** The `role_slots.id` — needed to claim/release this slot (#198). */
	slotId: string;
	meetingId: string;
	roleDefinitionId: string;
	slotIndex: number;
	memberId: string | null;
	/** A non-member guest holding this slot (#151); null unless guest-assigned. */
	guestId: string | null;
	status: SlotStatus;
}
export interface SeasonGridData {
	/** The club's URL slug — used to build the public sign-up-sheet share link.
	 *  Optional so existing view/picker test fixtures need not set it; always
	 *  populated by loadSeasonGrid. */
	clubSlug?: string | null;
	meetings: SeasonGridMeeting[];
	rows: SeasonGridRow[];
	/** Member-orientation AXIS — active members only (inactive members get no row). */
	members: SeasonGridMember[];
	/** Complete id→name lookup covering EVERY member referenced by `cells`,
	 *  including inactive members who held a role in a past-lookback meeting, so
	 *  the roles orientation still renders their name (history preserved). */
	memberNames: SeasonGridMember[];
	/** id→name lookup for every guest referenced by `cells` (#151). Guests never
	 *  appear on the member axis; the roles orientation resolves their name here. */
	guestNames: SeasonGridMember[];
	cells: SeasonGridCell[];
	unavailable: { memberId: string; meetingId: string }[];
	/** Members contacted about each meeting (#340). Admin-only: populated only
	 *  when loadSeasonGrid is called with includeOutreach; empty otherwise, so it
	 *  never reaches members or the public sheet. */
	contacted: { memberId: string; meetingId: string }[];
}

const PAST_LOOKBACK = 2;

export async function loadSeasonGrid(input: {
	clubId: string;
	count: SeasonGridCount;
	/** Include member email/phone on the member axis. Off by default so the
	 *  public sheet never carries contact PII. */
	includeContact?: boolean;
	/** Include the per-(member, meeting) "contacted" set. Admin-only; off by
	 *  default so members / the public sheet never receive it. */
	includeOutreach?: boolean;
}): Promise<SeasonGridData> {
	const now = new Date();

	// 1. Columns: up to PAST_LOOKBACK most-recent past meetings + upcoming.
	// `defaultCountryCode` rides along on the row this query already fetches. It
	// is only USED on the contact path (below), but reading it here costs nothing
	// — one more column on a single-row lookup — whereas loading it separately
	// there cost a whole extra SERIALIZED round trip, since it sat behind every
	// query above it. Fetching an unused column is strictly cheaper than the gate
	// that avoided fetching it.
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
		columns: { timezone: true, slug: true, defaultCountryCode: true },
	});
	const timezone = club?.timezone ?? "UTC";

	const past = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
		})
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				ne(meetings.status, "cancelled"),
				lt(meetings.scheduledAt, now),
			),
		)
		.orderBy(desc(meetings.scheduledAt))
		.limit(PAST_LOOKBACK);

	const upcomingQuery = db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
		})
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				ne(meetings.status, "cancelled"),
				gte(meetings.scheduledAt, now),
			),
		)
		.orderBy(asc(meetings.scheduledAt));
	const upcoming =
		input.count === "all"
			? await upcomingQuery
			: await upcomingQuery.limit(input.count);

	const ordered = [...past.reverse(), ...upcoming];
	const meetingIds = ordered.map((m) => m.id);
	const anchorId = upcoming[0]?.id ?? null;

	// 2. Slots (+ role defs) for those meetings.
	const slotRows = meetingIds.length
		? await db
				.select({
					id: roleSlots.id,
					meetingId: roleSlots.meetingId,
					roleDefinitionId: roleSlots.roleDefinitionId,
					slotIndex: roleSlots.slotIndex,
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					assignedGuestId: roleSlots.assignedGuestId,
					roleName: roleDefinitions.name,
					sortOrder: roleDefinitions.sortOrder,
					isSpeakerRole: roleDefinitions.isSpeakerRole,
				})
				.from(roleSlots)
				.innerJoin(
					roleDefinitions,
					eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				)
				.where(inArray(roleSlots.meetingId, meetingIds))
		: [];

	// 3. Union row axis: distinct (roleDefinitionId, slotIndex), ordered.
	const rowMap = new Map<
		string,
		{
			roleDefinitionId: string;
			slotIndex: number;
			roleName: string;
			sortOrder: number;
			isSpeakerRole: boolean;
		}
	>();
	for (const s of slotRows) {
		const key = `${s.roleDefinitionId}:${s.slotIndex}`;
		if (!rowMap.has(key))
			rowMap.set(key, {
				roleDefinitionId: s.roleDefinitionId,
				slotIndex: s.slotIndex,
				roleName: s.roleName,
				sortOrder: s.sortOrder,
				isSpeakerRole: s.isSpeakerRole,
			});
	}
	const rowDefs = [...rowMap.values()].sort(
		(a, b) =>
			a.sortOrder - b.sortOrder ||
			a.roleDefinitionId.localeCompare(b.roleDefinitionId) ||
			a.slotIndex - b.slotIndex,
	);
	const roleCounts = buildRoleCounts(
		rowDefs.map((r) => ({ roleName: r.roleName })),
	);
	const shortCodes = buildShortCodes(
		rowDefs.map((r) => ({
			roleDefinitionId: r.roleDefinitionId,
			slotIndex: r.slotIndex,
			name: r.roleName,
		})),
	);
	const rows: SeasonGridRow[] = rowDefs.map((r) => ({
		roleDefinitionId: r.roleDefinitionId,
		slotIndex: r.slotIndex,
		label: slotLabel(
			{ roleName: r.roleName, slotIndex: r.slotIndex },
			roleCounts,
		),
		shortCode: shortCodes.get(`${r.roleDefinitionId}:${r.slotIndex}`) ?? "?",
		sortOrder: r.sortOrder,
		isSpeakerRole: r.isSpeakerRole,
	}));

	// 4. Cells + per-meeting counts.
	const cells: SeasonGridCell[] = slotRows.map((s) => ({
		slotId: s.id,
		meetingId: s.meetingId,
		roleDefinitionId: s.roleDefinitionId,
		slotIndex: s.slotIndex,
		memberId: s.assignedMemberId,
		guestId: s.assignedGuestId,
		status: s.status,
	}));
	const openByMeeting = new Map<string, number>();
	const totalByMeeting = new Map<string, number>();
	for (const c of cells) {
		totalByMeeting.set(c.meetingId, (totalByMeeting.get(c.meetingId) ?? 0) + 1);
		// Open = no assignee at all: neither a member nor a guest (#151).
		if (c.memberId === null && c.guestId === null)
			openByMeeting.set(c.meetingId, (openByMeeting.get(c.meetingId) ?? 0) + 1);
	}

	const gridKeys = urlKeysForMeetings(ordered, timezone);
	const gridMeetings: SeasonGridMeeting[] = ordered.map((m) => ({
		id: m.id,
		scheduledAt: m.scheduledAt.toISOString(),
		timezone,
		urlKey: gridKeys.get(m.id) ?? m.id,
		openCount: openByMeeting.get(m.id) ?? 0,
		totalSlots: totalByMeeting.get(m.id) ?? 0,
		isPast: m.scheduledAt < now,
		isAnchor: m.id === anchorId,
		isCompleted: m.status === "completed",
	}));

	// 5. Members + availability. The member-orientation AXIS is active-only, but
	//    the name lookup (`memberNames`) covers every member — including inactive
	//    ones who held a role in the past-lookback window — so the roles
	//    orientation still resolves their name (history preserved).
	const allMemberRows = await db
		.select({
			id: members.id,
			name: members.name,
			status: members.status,
			email: members.email,
			phone: members.phone,
		})
		.from(members)
		.where(eq(members.clubId, input.clubId))
		.orderBy(asc(members.name));
	// Coalesce phone to E.164 with the club default country code (#295) so the
	// rendered WhatsApp link is a valid full number even for rows stored before
	// normalize-on-write. `coalesceToE164` also preserves an un-normalizable value
	// rather than dropping it — see its doc comment in `#/lib/phone`.
	//
	// The country code comes off the `clubs` row fetched at the top rather than
	// from a second `loadClubDefaultCountryCode` call. That call was the thing the
	// `includeContact` gate existed to avoid on the public path, and it was
	// SERIALIZED behind everything above it — so the gate was saving a round trip
	// that a single extra column removes for BOTH paths. The public grid still
	// makes no extra `clubs` query; it just no longer needs a branch to say so.
	// `season-grid-cc-query.integration.test.ts` pins the query COUNT.
	//
	// `?.trim() || DEFAULT_COUNTRY_CODE` reproduces `loadClubDefaultCountryCode`'s
	// never-null contract (#397): a club that never set a code still has to
	// produce one, so this stays a `||` (blank ⇒ default), not a `??`.
	const active = allMemberRows.filter((m) => m.status !== "inactive");
	let memberRows: SeasonGridMember[];
	if (input.includeContact) {
		const cc = club?.defaultCountryCode?.trim() || DEFAULT_COUNTRY_CODE;
		memberRows = active.map((m) => ({
			id: m.id,
			name: m.name,
			email: m.email,
			phone: coalesceToE164(m.phone, cc),
		}));
	} else {
		memberRows = active.map((m) => ({ id: m.id, name: m.name }));
	}
	const memberNames: SeasonGridMember[] = allMemberRows.map((m) => ({
		id: m.id,
		name: m.name,
	}));

	const unavailable = meetingIds.length
		? await db
				.select({
					memberId: memberAvailability.memberId,
					meetingId: memberAvailability.meetingId,
				})
				.from(memberAvailability)
				.where(inArray(memberAvailability.meetingId, meetingIds))
		: [];

	const contacted =
		input.includeOutreach && meetingIds.length
			? await db
					.select({
						memberId: meetingOutreach.memberId,
						meetingId: meetingOutreach.meetingId,
					})
					.from(meetingOutreach)
					.where(inArray(meetingOutreach.meetingId, meetingIds))
			: [];

	// Guest name lookup for guest-held cells (#151). Guests are a distinct list —
	// they never appear on the member axis, so this is separate from memberNames.
	const guestRows = await db
		.select({ id: guests.id, name: guests.name })
		.from(guests)
		.where(eq(guests.clubId, input.clubId));
	const guestNames: SeasonGridMember[] = guestRows.map((g) => ({
		id: g.id,
		name: g.name,
	}));

	return {
		clubSlug: club?.slug ?? null,
		meetings: gridMeetings,
		rows,
		members: memberRows,
		memberNames,
		guestNames,
		cells,
		unavailable,
		contacted,
	};
}

/** A grid with nothing in it — the not-found answer for a club a public caller
 *  may not read. Spelled out rather than built by filtering a loaded grid, so
 *  no query runs at all for an archived club.
 *
 *  A FUNCTION, not a shared const: the real `loadSeasonGrid` hands every caller
 *  its own arrays, and a singleton returned from a loader would let one caller's
 *  in-place `.sort()` or `.push()` reshape what the next archived club gets. */
function emptyGrid(): SeasonGridData {
	return {
		clubSlug: null,
		meetings: [],
		rows: [],
		members: [],
		memberNames: [],
		guestNames: [],
		cells: [],
		unavailable: [],
		contacted: [],
	};
}

/**
 * Public (no-auth) variant of {@link loadSeasonGrid}. Hardcodes
 * `includeContact: false` so the sheet shared at `/club/:clubId` — which sits
 * behind only a soft "pick your name" gate — can NEVER carry member email/phone.
 * Keeping this a named seam (rather than a `false` literal inside the
 * un-testable `createServerFn` handler) lets the "public payload has no contact"
 * invariant be asserted in a unit test.
 *
 * ARCHIVED CLUBS GET AN EMPTY GRID (#544). This was the widest of the leaks that
 * issue swept up, and the one that made the other two look mild: `members` /
 * `memberNames` / `guestNames` are ROSTER NAMES, so an archived club's whole
 * membership stayed anonymously enumerable through a bare endpoint call long
 * after the club was taken down. `includeContact: false` bounds WHICH member
 * fields ride along; it says nothing about WHETHER the club should answer.
 */
export async function loadPublicSeasonGrid(input: {
	clubId: string;
	count: SeasonGridCount;
}): Promise<SeasonGridData> {
	if (!(await isReadableClub(input.clubId))) return emptyGrid();
	return loadSeasonGrid({ ...input, includeContact: false });
}
