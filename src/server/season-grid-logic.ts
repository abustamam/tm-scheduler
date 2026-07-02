import { and, asc, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	memberAvailability,
	members,
	roleDefinitions,
	roleSlots,
	type slotStatusEnum,
} from "#/db/schema";
import { buildRoleCounts, buildShortCodes, slotLabel } from "#/lib/agenda";

export type SeasonGridCount = 4 | 8 | "all";
export type SlotStatus = (typeof slotStatusEnum.enumValues)[number];

export interface SeasonGridMeeting {
	id: string;
	scheduledAt: string;
	timezone: string;
	openCount: number;
	totalSlots: number;
	isPast: boolean;
	isAnchor: boolean;
}
export interface SeasonGridRow {
	roleDefinitionId: string;
	slotIndex: number;
	label: string; // "Speaker 2" (hover)
	shortCode: string; // "SP2"
	sortOrder: number;
}
export interface SeasonGridMember {
	id: string;
	name: string;
}
export interface SeasonGridCell {
	meetingId: string;
	roleDefinitionId: string;
	slotIndex: number;
	memberId: string | null;
	status: SlotStatus;
}
export interface SeasonGridData {
	meetings: SeasonGridMeeting[];
	rows: SeasonGridRow[];
	/** Member-orientation AXIS — active members only (inactive members get no row). */
	members: SeasonGridMember[];
	/** Complete id→name lookup covering EVERY member referenced by `cells`,
	 *  including inactive members who held a role in a past-lookback meeting, so
	 *  the roles orientation still renders their name (history preserved). */
	memberNames: SeasonGridMember[];
	cells: SeasonGridCell[];
	unavailable: { memberId: string; meetingId: string }[];
}

const PAST_LOOKBACK = 2;

export async function loadSeasonGrid(input: {
	clubId: string;
	count: SeasonGridCount;
}): Promise<SeasonGridData> {
	const now = new Date();

	// 1. Columns: up to PAST_LOOKBACK most-recent past meetings + upcoming.
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
		columns: { timezone: true },
	});
	const timezone = club?.timezone ?? "UTC";

	const past = await db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
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
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
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
					meetingId: roleSlots.meetingId,
					roleDefinitionId: roleSlots.roleDefinitionId,
					slotIndex: roleSlots.slotIndex,
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					roleName: roleDefinitions.name,
					sortOrder: roleDefinitions.sortOrder,
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
	}));

	// 4. Cells + per-meeting counts.
	const cells: SeasonGridCell[] = slotRows.map((s) => ({
		meetingId: s.meetingId,
		roleDefinitionId: s.roleDefinitionId,
		slotIndex: s.slotIndex,
		memberId: s.assignedMemberId,
		status: s.status,
	}));
	const openByMeeting = new Map<string, number>();
	const totalByMeeting = new Map<string, number>();
	for (const c of cells) {
		totalByMeeting.set(c.meetingId, (totalByMeeting.get(c.meetingId) ?? 0) + 1);
		if (c.memberId === null)
			openByMeeting.set(c.meetingId, (openByMeeting.get(c.meetingId) ?? 0) + 1);
	}

	const gridMeetings: SeasonGridMeeting[] = ordered.map((m) => ({
		id: m.id,
		scheduledAt: m.scheduledAt.toISOString(),
		timezone,
		openCount: openByMeeting.get(m.id) ?? 0,
		totalSlots: totalByMeeting.get(m.id) ?? 0,
		isPast: m.scheduledAt < now,
		isAnchor: m.id === anchorId,
	}));

	// 5. Members + availability. The member-orientation AXIS is active-only, but
	//    the name lookup (`memberNames`) covers every member — including inactive
	//    ones who held a role in the past-lookback window — so the roles
	//    orientation still resolves their name (history preserved).
	const allMemberRows = await db
		.select({ id: members.id, name: members.name, status: members.status })
		.from(members)
		.where(eq(members.clubId, input.clubId))
		.orderBy(asc(members.name));
	const memberRows: SeasonGridMember[] = allMemberRows
		.filter((m) => m.status !== "inactive")
		.map((m) => ({ id: m.id, name: m.name }));
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

	return {
		meetings: gridMeetings,
		rows,
		members: memberRows,
		memberNames,
		cells,
		unavailable,
	};
}
