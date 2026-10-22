/**
 * `get_my_schedule` — the caller's OWN upcoming meetings, roles and answer
 * (#1281, #985 part 1).
 *
 * `audience: "member"`, and authenticate-only like `get_my_feedback`: it names
 * no club, so `mcp-authz.guard.test.ts` waives it by name. WHOSE schedule comes
 * from the credential alone (`auth.user.id`); the input has no member, person or
 * club id, so there is no argument a caller could change to read somebody
 * else's. The clubs are `auth.clubs` (non-archived, active membership), which is
 * also why an archived club never appears.
 *
 * Roles come from `loadMyCommitments`, the dashboard's own read. Attendance
 * comes from the plan seam (`listMyAttendanceForMeetings`): the plan and the
 * roll, each ONE batched read over every meeting in the window, narrowed to the
 * caller's own member ids in SQL, so the query count does not grow with the
 * number of meetings and no other member's row is ever read.
 */
import { and, asc, gte, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { listMyAttendanceForMeetings } from "#/server/attendance-plan-logic";
import { loadMyCommitments } from "#/server/my-activity-logic";
import { ensureScheduleToppedUp } from "#/server/schedule-topup-logic";
import { authenticateToken } from "../authz-logic";
import type { McpToolDefinition } from "../tool";

const DAY_MS = 24 * 60 * 60 * 1000;

const inputSchema = {
	days: z
		.number()
		.int()
		.min(1)
		.max(90)
		.default(28)
		.describe("How many days ahead to look (1-90, default 28)."),
};

/** An instant as ISO 8601 with the club timezone's UTC offset, e.g. `2026-10-27T19:00:00-07:00`. */
export function isoInTimezone(instant: Date, timezone: string): string {
	const wall = utcToZonedWallTime(instant, timezone); // YYYY-MM-DDTHH:mm
	const asUtc = Date.parse(`${wall}:00Z`);
	const offsetMin = Math.round(
		(asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000,
	);
	const sign = offsetMin < 0 ? "-" : "+";
	const abs = Math.abs(offsetMin);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	return `${wall}:00${sign}${hh}:${mm}`;
}

export type MyAttendance = "coming" | "not_coming" | "unavailable" | null;

/**
 * The roll wins over the plan (CODING_STANDARDS.md "Data layer", #1257): roll
 * `absent` is `unavailable` whatever the plan says, roll `present` is `coming`
 * even after a `not_coming`. Excused or no record falls through to the plan:
 * `not_coming` > `coming` > null.
 */
export function combineAttendance(
	roll: string | undefined,
	plan: string | undefined,
): MyAttendance {
	if (roll === "absent") return "unavailable";
	if (roll === "present") return "coming";
	if (plan === "not_coming") return "not_coming";
	if (plan === "coming") return "coming";
	return null;
}

export const getMyScheduleTool: McpToolDefinition = {
	name: "get_my_schedule",
	audience: "member",
	config: {
		title: "Get my schedule",
		description:
			"The caller's own upcoming meetings (default next 28 days) in the " +
			"clubs they belong to: when, which roles they hold, and whether they " +
			"have said they are coming. Takes no id: it is always the person this " +
			"token belongs to.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const auth = await authenticateToken(ctx);
		const myClubs = auth.clubs;
		if (myClubs.length === 0) return { meetings: [] };

		const now = new Date();
		const until = new Date(now.getTime() + args.days * DAY_MS);

		// The browser's authenticated reads materialise the recurrence; a token
		// read must see the same calendar (ADR-0021). Once per club, not per meeting.
		await Promise.all(myClubs.map((c) => ensureScheduleToppedUp(c.clubId)));

		const rows = await db
			.select({
				id: meetings.id,
				clubId: meetings.clubId,
				scheduledAt: meetings.scheduledAt,
				status: meetings.status,
			})
			.from(meetings)
			.where(
				and(
					inArray(
						meetings.clubId,
						myClubs.map((c) => c.clubId),
					),
					gte(meetings.scheduledAt, now),
					lt(meetings.scheduledAt, until),
					ne(meetings.status, "cancelled"),
				),
			)
			.orderBy(asc(meetings.scheduledAt));
		if (rows.length === 0) return { meetings: [] };

		const meetingIds = rows.map((r) => r.id);
		const myMemberIds = new Set(myClubs.map((c) => c.membershipId));
		const [commitments, { plan, roll }] = await Promise.all([
			loadMyCommitments(auth.user.id),
			listMyAttendanceForMeetings(db, {
				meetingIds,
				memberIds: [...myMemberIds],
			}),
		]);

		const rolesByMeeting = new Map<string, string[]>();
		for (const c of commitments) {
			const list = rolesByMeeting.get(c.meetingId) ?? [];
			list.push(c.roleName);
			rolesByMeeting.set(c.meetingId, list);
		}
		const planByMeeting = new Map<string, string>();
		for (const p of plan) planByMeeting.set(p.meetingId, p.status);
		const rollByMeeting = new Map(roll.map((r) => [r.meetingId, r.status]));
		const clubById = new Map(myClubs.map((c) => [c.clubId, c]));

		const out = rows.map((m) => {
			// Always present: the rows came from these clubs.
			const club = clubById.get(m.clubId);
			if (!club) throw new Error("unreachable: meeting outside caller clubs");
			return {
				meetingId: m.id,
				clubId: m.clubId,
				clubName: club.name,
				startsAt: isoInTimezone(m.scheduledAt, club.timezone),
				instant: m.scheduledAt.getTime(),
				status: m.status as "scheduled" | "completed",
				myRoles: rolesByMeeting.get(m.id) ?? [],
				myAttendance: combineAttendance(
					rollByMeeting.get(m.id),
					planByMeeting.get(m.id),
				),
			};
		});
		out.sort(
			(a, b) => a.instant - b.instant || a.clubName.localeCompare(b.clubName),
		);
		return {
			meetings: out.map(({ instant: _i, ...rest }) => rest),
		};
	},
};
