/**
 * `reschedule_meeting` — move ONE meeting's start (date and/or time) or change
 * its length (#1513).
 *
 * ## Preview, then apply, in the conversation (the `edit_agenda` shape)
 *
 * A call WITHOUT `planHash` writes nothing and returns the plan: old to new
 * start, end and date in the club's timezone, any warning, and a planHash. The
 * SAME call with that hash re-plans under the meeting's row lock and applies;
 * a mismatch is `PLAN_STALE` carrying the fresh plan.
 *
 * ## The write is `applyMeetingMetaPatch` and nothing else
 *
 * The web dialog's own writer: it writes only the columns that changed, logs one
 * `meeting_edit` entry with before and after, and refuses a cancelled meeting.
 * Going through it keeps the audit entry and everything else keyed on
 * `scheduledAt` right. An omitted field keeps its stored value, so
 * sending only `startTime` keeps the club-local DATE, including across a DST
 * change.
 *
 * ## Refusals, decided from the row this tool loaded
 *
 * `errors.ts` forbids mapping by message text, so status and time are checked
 * here, not by catching the seam's plain `Error`s. The seam's write policy
 * accepts a completed meeting (so the dialog can edit a past meeting's notes),
 * so it would not refuse one: this tool must.
 *   - `LOCKED`: the meeting is completed, or its stored start has passed.
 *   - `VALIDATION`: cancelled; the new start is not in the future; the new start
 *     does not exist on the club's clock (a DST gap); the slot is taken by
 *     another meeting of the club (`meetings_club_scheduled_unique`, checked at
 *     preview and again by the apply's own insert-time violation).
 *
 * The run sheet is never retimed here (that is `edit_agenda`); the plan only
 * WARNS when it would end after the new end time.
 */
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { agendaRunSheet } from "#/lib/agenda-run-sheet";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import { clubLocalParts, localDate } from "#/lib/club-local-date";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { planHash } from "#/lib/mcp-plan";
import { readAgendaSnapshot } from "#/server/meeting-agenda-edit-logic";
import { applyMeetingMetaPatch } from "#/server/meetings-logic";
import { isUniqueViolation } from "#/server/pg-errors";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { DbOrTx } from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { isoInTimezone } from "./get-my-schedule";

export const RESCHEDULE_MEETING_TOOL = "reschedule_meeting";

export const NOTHING_TO_CHANGE_MESSAGE =
	"Send at least one of date, startTime or lengthMinutes.";
export const BAD_TIME_MESSAGE =
	"startTime must be a club-local 24-hour time like 18:45.";
export const MEETING_CANCELLED_MESSAGE =
	"This meeting is cancelled. Restore it first, then move it.";
export const MEETING_STARTED_MESSAGE =
	"This meeting is completed or has already started, so it can no longer be moved.";
export const NEW_START_PAST_MESSAGE =
	"The new start time has already passed. Pick a time in the future.";
export const NO_SUCH_TIME_MESSAGE =
	"That date and time do not exist on the club's clock (the clocks skip it that day). Pick another time.";
export const SLOT_TAKEN_MESSAGE =
	"Another meeting of this club already starts at that date and time.";
const STALE_PLAN_MESSAGE =
	"The meeting changed since that preview. Show the user the fresh plan and ask again.";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const inputSchema = {
	meetingId: z.string().uuid(),
	date: localDate
		.optional()
		.describe("The new club-local date, YYYY-MM-DD. Omit to keep the date."),
	startTime: z
		.string()
		.optional()
		.describe("The new club-local start, 24-hour HH:mm. Omit to keep it."),
	lengthMinutes: z
		.number()
		.int()
		.positive()
		.max(24 * 60)
		.optional()
		.describe("The new meeting length in minutes. Omit to keep it."),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

type Change<T> = { from: T; to: T };

type ReschedulePlan = {
	meetingId: string;
	timezone: string;
	/** True when nothing sent differs from what is stored: an apply writes nothing. */
	noop: boolean;
	/** Club-local ISO with offset, e.g. 2026-11-12T18:45:00-06:00. */
	start: Change<string>;
	end: Change<string>;
	/** Club-local YYYY-MM-DD. */
	date: Change<string>;
	lengthMinutes: Change<number>;
	warnings: string[];
};

type Args = { date?: string; startTime?: string; lengthMinutes?: number };

type Planned = {
	plan: ReschedulePlan;
	/** The datetime-local value the seam takes, when the start moves. */
	scheduledAtWall: string | null;
	newLength: number | null;
};

/** Club-local ISO (with offset) of a meeting's end: start + length. The one
 *  place the end is computed; `get_agenda` and `list_meetings` use it too. */
export function meetingEndsAt(
	scheduledAt: Date,
	lengthMinutes: number,
	timezone: string,
): string {
	return isoInTimezone(
		new Date(scheduledAt.getTime() + lengthMinutes * 60_000),
		timezone,
	);
}

// The seam (`applyMeetingMetaPatch`) and its datetime-local input are
// minute-precision; so is every instant this tool shows (`isoInTimezone` drops
// seconds). Compare at the same granularity, or a stored start with seconds would
// read as "changed" to this tool and the plan could not say what moved.
const toMinute = (d: Date) => Math.floor(d.getTime() / 60_000);

/** Build the plan from what is stored now. `lock` takes the meeting row. */
async function buildPlan(
	conn: DbOrTx,
	meetingId: string,
	timezone: string,
	args: Args,
	now: Date,
	lock: boolean,
): Promise<Planned> {
	const base = conn
		.select({
			clubId: meetings.clubId,
			status: meetings.status,
			scheduledAt: meetings.scheduledAt,
			lengthMinutes: meetings.lengthMinutes,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	const [meeting] = lock ? await base.for("update") : await base;
	if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");

	if (meeting.status === "cancelled") {
		throw new McpError("VALIDATION", MEETING_CANCELLED_MESSAGE);
	}
	if (
		meeting.status === "completed" ||
		meeting.scheduledAt.getTime() <= now.getTime()
	) {
		throw new McpError("LOCKED", MEETING_STARTED_MESSAGE);
	}

	const stored = clubLocalParts(meeting.scheduledAt, timezone);
	const newDate = args.date ?? stored.date;
	const newTime = args.startTime ?? stored.time;
	const wall = `${newDate}T${newTime}`;
	const startMoves = args.date !== undefined || args.startTime !== undefined;

	let newStart = meeting.scheduledAt;
	if (startMoves) {
		newStart = zonedWallTimeToUtc(wall, timezone);
		// A wall time inside a DST gap resolves to a neighbouring instant; say so
		// rather than silently moving the meeting to a time nobody asked for.
		if (utcToZonedWallTime(newStart, timezone) !== wall) {
			throw new McpError("VALIDATION", NO_SUCH_TIME_MESSAGE);
		}
	}
	const newLength = args.lengthMinutes ?? meeting.lengthMinutes;
	const startChanged = toMinute(newStart) !== toMinute(meeting.scheduledAt);
	// Same minute: keep the stored instant (and its seconds); nothing is written.
	if (!startChanged) newStart = meeting.scheduledAt;
	const lengthChanged = newLength !== meeting.lengthMinutes;

	if (startChanged) {
		if (newStart.getTime() <= now.getTime()) {
			throw new McpError("VALIDATION", NEW_START_PAST_MESSAGE);
		}
		const [clash] = await conn
			.select({ id: meetings.id })
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, meeting.clubId),
					eq(meetings.scheduledAt, newStart),
					ne(meetings.id, meetingId),
				),
			)
			.limit(1);
		if (clash) throw new McpError("VALIDATION", SLOT_TAKEN_MESSAGE);
	}

	const warnings: string[] = [];
	if (startChanged || lengthChanged) {
		const snap = await readAgendaSnapshot(meetingId, conn);
		if (snap) {
			const sheet = agendaRunSheet({
				...snap,
				scheduledAt: newStart.toISOString(),
				lengthMinutes: newLength,
			});
			if (sheet.overByMinutes > 0) {
				warnings.push(
					`The agenda's run sheet ends ${sheet.overByMinutes} minute${sheet.overByMinutes === 1 ? "" : "s"} after the new end time (${sheet.endsAt} against ${sheet.slotEndsAt}). The apply is not blocked; use edit_agenda to shorten rows.`,
				);
			}
		}
	}

	const plan: ReschedulePlan = {
		meetingId,
		timezone,
		noop: !startChanged && !lengthChanged,
		start: {
			from: isoInTimezone(meeting.scheduledAt, timezone),
			to: isoInTimezone(newStart, timezone),
		},
		end: {
			from: meetingEndsAt(meeting.scheduledAt, meeting.lengthMinutes, timezone),
			to: meetingEndsAt(newStart, newLength, timezone),
		},
		date: { from: stored.date, to: newDate },
		lengthMinutes: { from: meeting.lengthMinutes, to: newLength },
		warnings,
	};
	return {
		plan,
		scheduledAtWall: startChanged ? wall : null,
		newLength: lengthChanged ? newLength : null,
	};
}

function summarize(plan: ReschedulePlan): string {
	if (plan.noop)
		return "Nothing to change: the meeting already has these values.";
	const parts: string[] = [];
	if (plan.start.from !== plan.start.to) {
		parts.push(`start ${plan.start.from} to ${plan.start.to}`);
	}
	if (plan.lengthMinutes.from !== plan.lengthMinutes.to) {
		parts.push(
			`length ${plan.lengthMinutes.from} to ${plan.lengthMinutes.to} min`,
		);
	}
	parts.push(`ends ${plan.end.to}`);
	return `Will change: ${parts.join("; ")}.`;
}

export const rescheduleMeetingTool: McpToolDefinition = {
	name: RESCHEDULE_MEETING_TOOL,
	audience: "officer",
	// Moves one upcoming meeting; moving it back undoes it.
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
	},
	config: {
		title: "Reschedule meeting",
		description:
			"Move one upcoming meeting to another date and/or start time " +
			"(club-local), or change its length. Send meetingId plus at least one " +
			"of date (YYYY-MM-DD), startTime (HH:mm) and lengthMinutes; an omitted " +
			"field keeps its stored value. Without planHash this writes nothing: " +
			"it returns a plan with old to new start, end and date in the club's " +
			"timezone, a warning when the agenda's run sheet would end after the " +
			"new end time, and a planHash. Show the plan to the user; call again " +
			"with the same input plus that planHash to apply it. Refused for a " +
			"meeting that is completed or has started (LOCKED), cancelled, moved " +
			"into the past, or moved onto another meeting's slot (VALIDATION). It " +
			"does not retime the agenda rows; that is edit_agenda.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		// Authorize FIRST, on the meeting id alone, so a plain member sending a bad
		// field gets FORBIDDEN and not a VALIDATION message.
		const idParsed = inputSchema.meetingId.safeParse(
			(input as { meetingId?: unknown }).meetingId,
		);
		if (!idParsed.success) {
			throw new McpError("VALIDATION", "meetingId: must be a meeting id.");
		}
		const meetingId = idParsed.data;
		const { club, user } = await authorizeTokenForMeeting(ctx, meetingId);

		const parsed = z.object(inputSchema).safeParse(input);
		if (!parsed.success) {
			throw new McpError(
				"VALIDATION",
				parsed.error.issues
					.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
					.join("; "),
			);
		}
		const args = parsed.data;
		if (
			args.date === undefined &&
			args.startTime === undefined &&
			args.lengthMinutes === undefined
		) {
			throw new McpError("VALIDATION", NOTHING_TO_CHANGE_MESSAGE);
		}
		if (args.startTime !== undefined && !TIME_RE.test(args.startTime)) {
			throw new McpError("VALIDATION", BAD_TIME_MESSAGE);
		}

		const hashOf = (plan: ReschedulePlan) =>
			planHash({
				tool: RESCHEDULE_MEETING_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});
		const staleError = (plan: ReschedulePlan) =>
			new McpError("PLAN_STALE", STALE_PLAN_MESSAGE, {
				plan,
				planHash: hashOf(plan),
				summary: summarize(plan),
			});
		const now = new Date();

		if (args.planHash === undefined) {
			const { plan } = await buildPlan(
				db,
				meetingId,
				club.timezone,
				args,
				now,
				false,
			);
			return {
				applied: false,
				meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
			};
		}

		const expected = args.planHash;
		type Outcome = { stale: ReschedulePlan } | { plan: ReschedulePlan };
		let outcome: Outcome;
		try {
			outcome = await db.transaction(async (tx): Promise<Outcome> => {
				// The timezone and archived state are read INSIDE the transaction,
				// under a share lock on the club row, and the plan is built with
				// THAT zone: `applyMeetingMetaPatch` reloads the club and converts
				// with whatever it finds, so a zone read at authorization could
				// write a different instant than the one approved. A changed zone
				// changes the plan, hence the hash: PLAN_STALE, not a surprise.
				const [fresh] = await tx
					.select({ timezone: clubs.timezone, archivedAt: clubs.archivedAt })
					.from(clubs)
					.where(eq(clubs.id, club.clubId))
					.limit(1)
					.for("share");
				if (!fresh) throw new McpError("NOT_FOUND", "Club not found.");
				if (isClubArchived(fresh)) {
					throw new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE);
				}
				const planned = await buildPlan(
					tx,
					meetingId,
					fresh.timezone,
					args,
					now,
					true,
				);
				if (hashOf(planned.plan) !== expected) {
					return { stale: planned.plan };
				}
				if (planned.plan.noop) return { plan: planned.plan };
				await applyMeetingMetaPatch(
					{
						meetingId,
						actorMemberId: club.membershipId,
						...(planned.scheduledAtWall !== null && {
							scheduledAt: planned.scheduledAtWall,
						}),
						...(planned.newLength !== null && {
							lengthMinutes: planned.newLength,
						}),
						canReschedule: true,
					},
					tx,
				);
				return { plan: planned.plan };
			});
		} catch (err) {
			// Another meeting took the slot between the plan's check and the UPDATE.
			if (isUniqueViolation(err)) {
				throw new McpError("VALIDATION", SLOT_TAKEN_MESSAGE);
			}
			throw err;
		}

		if ("stale" in outcome) throw staleError(outcome.stale);
		return {
			applied: true,
			meetingId,
			clubId: club.clubId,
			summary: summarize(outcome.plan),
			plan: outcome.plan,
		};
	},
};
