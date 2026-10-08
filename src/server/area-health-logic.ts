// The one reader that crosses clubs (#1117, part of #1115): an area's health as
// counts, rates and dates, and nothing about any person. #1119 puts it behind
// the Area Director guard and renders it; THIS module has no session and trusts
// its caller.
//
// WHAT KEEPS PEOPLE OUT. A person's name, email or phone is never selected, from
// any table. The guard is the import list, not a grep for column names:
// `area-health-pii.guard.test.ts` fails on any import outside a short allowlist
// (it names the tables this file may touch and the pure modules it may call),
// on any use of the roster table other than its id, club and status, and on any
// query shape that reads columns without naming them. A table this file does
// not import cannot leak, whatever its columns are called. Read that test
// before adding an import here.
//
// So: no other server loader is called (they return people), and the count
// queries are written here. Only the pure rules in `#/lib/` are reused.
//
// A fixed number of queries per area, whatever its size: each aggregate is one
// statement over every club in the area, grouped by club. Never a loop of
// queries per club or per meeting.
//
// READ-ONLY. Nothing here writes, and the schedule top-up (ADR-0021) is never
// called: "next" is the meetings already on the calendar.
import {
	and,
	count,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import {
	areaClubs,
	areas,
	clubs,
	dcpGoalProgress,
	dcpScoreboards,
	divisions,
	duesPeriods,
	meetingAttendance,
	meetings,
	memberDues,
	members,
	officerTerms,
	officerTrainingPeriods,
	officerTrainingRecords,
	roleSlots,
} from "#/db/schema";
import {
	type AreaHealth,
	type ClubHealthData,
	type ClubHealthStatus,
	type ClubIdentity,
	deriveClubHealth,
	NEXT_MEETINGS_SHOWN,
	recentWindowStart,
	sortClubHealth,
} from "#/lib/area-health";
import { areaLabel } from "#/lib/area-health-fields";
import { isClubArchived } from "#/lib/club-archive";
import { currentProgramYear } from "#/lib/dcp";
import {
	isTrainingPeriod,
	TRAINABLE_OFFICER_POSITIONS,
	type TrainingRecordLike,
	type TrainingWindow,
	trainingProgramYearForDate,
} from "#/lib/officer-training";

export const AREA_NOT_FOUND_MESSAGE = "That area does not exist.";

/** `and(...)` is typed as possibly undefined; every call here has conditions. */
const allOf = (...conditions: SQL[]): SQL => and(...conditions) as SQL;

/** The rows of one aggregate query, keyed by club. */
function byClub<T extends { clubId: string }>(
	rows: readonly T[],
): Map<string, T> {
	return new Map(rows.map((r) => [r.clubId, r]));
}

/** Rows of a query with several per club, collected per club. */
function groupByClub<T extends { clubId: string }>(
	rows: readonly T[],
): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const row of rows) {
		const list = grouped.get(row.clubId);
		if (list) list.push(row);
		else grouped.set(row.clubId, [row]);
	}
	return grouped;
}

/**
 * Every number the view shows for each of `clubIds`, in a fixed set of queries.
 * `clubIds` is non-empty and holds only live, unarchived clubs.
 */
async function loadClubData(
	clubIds: string[],
	now: Date,
): Promise<Map<string, ClubHealthData>> {
	const recentFrom = recentWindowStart(now);
	const trainingYear = trainingProgramYearForDate(now);

	// "Held": not cancelled, and before `now`. "Recent": from `recentFrom`
	// (inclusive) up to `now` (exclusive). `now` is a parameter, never the
	// database clock, so an injected time moves every rule together.
	const isHeld = allOf(
		ne(meetings.status, "cancelled"),
		lt(meetings.scheduledAt, now),
	);
	const isRecent = allOf(
		gte(meetings.scheduledAt, recentFrom),
		lt(meetings.scheduledAt, now),
	);
	const isRecentHeld = allOf(isHeld, isRecent);
	const isRecentCancelled = allOf(eq(meetings.status, "cancelled"), isRecent);

	// Per club, per recent held meeting that has a roll: the present rows. One
	// derived table, then summed per club below.
	const perRolledMeeting = db
		.select({
			clubId: meetings.clubId,
			presentMembers:
				sql<number>`count(*) filter (where ${eq(meetingAttendance.status, "present")} and ${meetingAttendance.memberId} is not null)`
					.mapWith(Number)
					.as("present_members"),
			presentGuests:
				sql<number>`count(*) filter (where ${eq(meetingAttendance.status, "present")} and ${meetingAttendance.guestId} is not null)`
					.mapWith(Number)
					.as("present_guests"),
		})
		.from(meetingAttendance)
		.innerJoin(meetings, eq(meetingAttendance.meetingId, meetings.id))
		.where(and(inArray(meetings.clubId, clubIds), isRecentHeld))
		.groupBy(meetings.clubId, meetings.id)
		.as("per_rolled_meeting");

	// The next meetings already on the calendar, a fixed few per club.
	const upcoming = db
		.select({
			clubId: meetings.clubId,
			scheduledAt: meetings.scheduledAt,
			place:
				sql<number>`row_number() over (partition by ${meetings.clubId} order by ${meetings.scheduledAt}, ${meetings.id})`.as(
					"place",
				),
		})
		.from(meetings)
		.where(
			and(
				inArray(meetings.clubId, clubIds),
				ne(meetings.status, "cancelled"),
				gte(meetings.scheduledAt, now),
			),
		)
		.as("upcoming");

	const [
		meetingRows,
		nextRows,
		slotRows,
		attendanceRows,
		seatRows,
		trainingTotalRows,
		trainingRecordRows,
		trainingWindowRows,
		dcpRows,
		duesRows,
	] = await Promise.all([
		db
			.select({
				clubId: meetings.clubId,
				rows: count(),
				recentHeld:
					sql<number>`count(*) filter (where ${isRecentHeld})`.mapWith(Number),
				recentCancelled:
					sql<number>`count(*) filter (where ${isRecentCancelled})`.mapWith(
						Number,
					),
				lastHeldAt:
					sql<Date | null>`max(${meetings.scheduledAt}) filter (where ${isHeld})`.mapWith(
						meetings.scheduledAt,
					),
			})
			.from(meetings)
			.where(inArray(meetings.clubId, clubIds))
			.groupBy(meetings.clubId),

		db
			.select({ clubId: upcoming.clubId, scheduledAt: upcoming.scheduledAt })
			.from(upcoming)
			.where(lte(upcoming.place, NEXT_MEETINGS_SHOWN))
			.orderBy(upcoming.clubId, upcoming.scheduledAt),

		db
			.select({
				clubId: meetings.clubId,
				total: count(),
				filled:
					sql<number>`count(*) filter (where ${inArray(roleSlots.status, ["claimed", "confirmed"])})`.mapWith(
						Number,
					),
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(roleSlots.meetingId, meetings.id))
			.where(and(inArray(meetings.clubId, clubIds), isRecentHeld))
			.groupBy(meetings.clubId),

		db
			.select({
				clubId: perRolledMeeting.clubId,
				rollTaken: count(),
				presentMembers:
					sql<number>`coalesce(sum(${perRolledMeeting.presentMembers}), 0)`.mapWith(
						Number,
					),
				presentGuests:
					sql<number>`coalesce(sum(${perRolledMeeting.presentGuests}), 0)`.mapWith(
						Number,
					),
			})
			.from(perRolledMeeting)
			.groupBy(perRolledMeeting.clubId),

		// Seats: distinct elected offices with an open term on an active member.
		db
			.select({
				clubId: members.clubId,
				seats: sql<number>`count(distinct ${officerTerms.position})`.mapWith(
					Number,
				),
			})
			.from(officerTerms)
			.innerJoin(members, eq(officerTerms.membershipId, members.id))
			.where(
				and(
					inArray(members.clubId, clubIds),
					isNull(officerTerms.termEnd),
					eq(members.status, "active"),
					inArray(officerTerms.position, [...TRAINABLE_OFFICER_POSITIONS]),
				),
			)
			.groupBy(members.clubId),

		// Whether a club records training at all, in any year.
		db
			.select({ clubId: members.clubId, recordRows: count() })
			.from(officerTrainingRecords)
			.innerJoin(members, eq(officerTrainingRecords.membershipId, members.id))
			.where(inArray(members.clubId, clubIds))
			.groupBy(members.clubId),

		// The training year's records: the shape the rule counts, no names.
		db
			.select({
				clubId: members.clubId,
				membershipId: officerTrainingRecords.membershipId,
				position: officerTrainingRecords.position,
				period: officerTrainingRecords.period,
			})
			.from(officerTrainingRecords)
			.innerJoin(members, eq(officerTrainingRecords.membershipId, members.id))
			.where(
				and(
					inArray(members.clubId, clubIds),
					eq(officerTrainingRecords.programYear, trainingYear),
				),
			),

		db
			.select({
				clubId: officerTrainingPeriods.clubId,
				period: officerTrainingPeriods.period,
				startsOn: officerTrainingPeriods.startsOn,
				endsOn: officerTrainingPeriods.endsOn,
			})
			.from(officerTrainingPeriods)
			.where(
				and(
					inArray(officerTrainingPeriods.clubId, clubIds),
					eq(officerTrainingPeriods.programYear, trainingYear),
				),
			),

		// The stored goal progress of this program year's scoreboards. A club with
		// a scoreboard and no goal rows still yields one row, with a null goal.
		db
			.select({
				clubId: dcpScoreboards.clubId,
				goalKey: dcpGoalProgress.goalKey,
				achieved: dcpGoalProgress.achieved,
			})
			.from(dcpScoreboards)
			.leftJoin(
				dcpGoalProgress,
				eq(dcpGoalProgress.scoreboardId, dcpScoreboards.id),
			)
			.where(
				and(
					inArray(dcpScoreboards.clubId, clubIds),
					eq(dcpScoreboards.programYear, currentProgramYear(now)),
				),
			),

		// Every dues period of each club, with its paid-or-waived rows counted.
		db
			.select({
				clubId: duesPeriods.clubId,
				id: duesPeriods.id,
				dueDate: duesPeriods.dueDate,
				createdAt: duesPeriods.createdAt,
				paid: count(memberDues.id),
			})
			.from(duesPeriods)
			.leftJoin(memberDues, eq(memberDues.duesPeriodId, duesPeriods.id))
			.where(inArray(duesPeriods.clubId, clubIds))
			.groupBy(duesPeriods.id),
	]);

	const meetingsByClub = byClub(meetingRows);
	const nextByClub = groupByClub(nextRows);
	const slotsByClub = byClub(slotRows);
	const attendanceByClub = byClub(attendanceRows);
	const seatsByClub = byClub(seatRows);
	const trainingTotalByClub = byClub(trainingTotalRows);
	const recordsByClub = groupByClub(trainingRecordRows);
	const windowsByClub = groupByClub(trainingWindowRows);
	const dcpByClub = groupByClub(dcpRows);
	const duesByClub = groupByClub(duesRows);

	const data = new Map<string, ClubHealthData>();
	for (const clubId of clubIds) {
		const m = meetingsByClub.get(clubId);
		const scoreboardRows = dcpByClub.get(clubId);
		let dcpProgress: Record<string, number> | null = null;
		if (scoreboardRows) {
			dcpProgress = {};
			for (const r of scoreboardRows) {
				if (r.goalKey !== null && r.achieved !== null) {
					dcpProgress[r.goalKey] = r.achieved;
				}
			}
		}
		data.set(clubId, {
			meetings: {
				rows: m?.rows ?? 0,
				recentHeld: m?.recentHeld ?? 0,
				recentCancelled: m?.recentCancelled ?? 0,
				lastHeldAt: m?.lastHeldAt ?? null,
				next: (nextByClub.get(clubId) ?? []).map((r) => r.scheduledAt),
			},
			slots: {
				filled: slotsByClub.get(clubId)?.filled ?? 0,
				total: slotsByClub.get(clubId)?.total ?? 0,
			},
			attendance: {
				rollTaken: attendanceByClub.get(clubId)?.rollTaken ?? 0,
				presentMembers: attendanceByClub.get(clubId)?.presentMembers ?? 0,
				presentGuests: attendanceByClub.get(clubId)?.presentGuests ?? 0,
			},
			officerSeatsFilled: seatsByClub.get(clubId)?.seats ?? 0,
			training: {
				recordRows: trainingTotalByClub.get(clubId)?.recordRows ?? 0,
				// `period` is 1 or 2 by a CHECK; a row that somehow is not is skipped
				// rather than scored as a period it is not.
				records: (recordsByClub.get(clubId) ?? []).flatMap(
					(r): TrainingRecordLike[] =>
						isTrainingPeriod(r.period)
							? [
									{
										membershipId: r.membershipId,
										position: r.position,
										period: r.period,
									},
								]
							: [],
				),
				overrides: (windowsByClub.get(clubId) ?? []).flatMap(
					(r): TrainingWindow[] =>
						isTrainingPeriod(r.period)
							? [{ period: r.period, startsOn: r.startsOn, endsOn: r.endsOn }]
							: [],
				),
			},
			dcpProgress,
			duesPeriods: (duesByClub.get(clubId) ?? []).map((r) => ({
				id: r.id,
				dueDate: r.dueDate,
				createdAt: r.createdAt,
				paid: r.paid,
			})),
		});
	}
	return data;
}

/**
 * One area's health, read at `now`. Throws when the area does not exist.
 * Trusts its caller: the Area Director guard is #1119's.
 */
export async function loadAreaHealth(
	areaId: string,
	now: Date = new Date(),
): Promise<AreaHealth> {
	const [area] = await db
		.select({
			number: areas.number,
			letter: divisions.letter,
			programYear: divisions.programYear,
		})
		.from(areas)
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.where(eq(areas.id, areaId));
	if (!area) throw new Error(AREA_NOT_FOUND_MESSAGE);

	// One query for every club in the area, archive state included: asking
	// "is this club readable" per club would be a query per club.
	const placed = await db
		.select({
			areaClubId: areaClubs.id,
			clubId: areaClubs.clubId,
			areaName: areaClubs.name,
			areaClubNumber: areaClubs.clubNumber,
			clubName: clubs.name,
			clubNumber: clubs.clubNumber,
			archivedAt: clubs.archivedAt,
		})
		.from(areaClubs)
		.leftJoin(clubs, eq(clubs.id, areaClubs.clubId))
		.where(eq(areaClubs.areaId, areaId));

	const identities: (ClubIdentity & { clubId: string | null })[] = placed.map(
		(row) => {
			// A linked row reads its name and number live, so a renamed club shows
			// its new name. A name-only row, and one whose club was permanently
			// deleted, reads the copy in the area.
			const linked = row.clubId !== null && row.clubName !== null;
			const status: ClubHealthStatus = !linked
				? "not_on_gavelup"
				: isClubArchived({ archivedAt: row.archivedAt })
					? "archived"
					: "on_gavelup";
			return {
				areaClubId: row.areaClubId,
				clubId: linked ? row.clubId : null,
				name: linked ? (row.clubName as string) : row.areaName,
				clubNumber: linked ? row.clubNumber : row.areaClubNumber,
				status,
			};
		},
	);

	const liveClubIds = identities
		.filter((c) => c.status === "on_gavelup" && c.clubId !== null)
		.map((c) => c.clubId as string);
	const data =
		liveClubIds.length > 0
			? await loadClubData(liveClubIds, now)
			: new Map<string, ClubHealthData>();

	return {
		areaId,
		label: areaLabel(area.letter, area.number),
		programYear: area.programYear,
		asOf: now.toISOString(),
		clubs: sortClubHealth(
			identities.map(({ clubId, ...identity }) =>
				deriveClubHealth(
					identity,
					clubId === null ? null : (data.get(clubId) ?? null),
					now,
				),
			),
		),
	};
}
