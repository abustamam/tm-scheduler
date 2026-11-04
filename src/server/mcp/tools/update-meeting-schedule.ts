/**
 * `update_meeting_schedule` — change the club's standing meeting time, its
 * free-text schedule line and its default meeting length (#1514).
 *
 * ## Preview, then apply, in the conversation (the `edit_agenda` shape)
 *
 * A call WITHOUT `planHash` writes nothing and returns the plan: old → new for
 * each field sent, the future meetings a time change will delete and recreate,
 * the touched ones that will keep their old time, and a planHash. The SAME call
 * with that hash re-plans and applies. A mismatch is `PLAN_STALE` carrying the
 * fresh plan.
 *
 * ## What a time change does to future meetings
 *
 * Nothing new: it goes through `saveRecurrenceRule`, the browser's own save,
 * with the stored rule read back and only `timeOfDay` changed so every other
 * field is byte-identical. That deletes each future meeting nobody has touched
 * that sits on the old pattern's dates and tops the schedule up under the new
 * time. "Touched" is `findPristineEmptyMeetingIds`. A touched meeting keeps its
 * old time; those are moved one at a time in the app.
 *
 * The plan has to name EXACTLY the meetings the save will delete.
 * `selectOldPatternMeetings` (`recurrence-rule-logic.ts`) is the one selection
 * both the delete and this preview use, and the replacements are the top-up's
 * own slot logic (`planTopUpInstants`) run on what will remain, so a meeting is
 * listed as `recreated` only when the apply really creates it; a deleted one
 * with no replacement is listed apart. The planHash covers the stored rule, the
 * text, the length, the replacements AND both meeting sets, so a meeting
 * someone touches, or a slot the clock passes, between preview and apply is
 * `PLAN_STALE`.
 *
 * The apply is ONE transaction: lock the rule row, re-plan, compare the hash,
 * write the club columns, save the rule (delete, top-up). A throw anywhere
 * rolls the club columns back too, and a web save of the same rule waits on the
 * lock. The delete acts on the set selected inside that transaction; if it
 * differs from the planned set the transaction rolls back and the call is
 * `PLAN_STALE`.
 *
 * ## The other two fields
 *
 * The schedule line is never rewritten on its own: a time change with no
 * `scheduleText` only WARNS that the line may now be stale. Both club columns
 * go through `applyClubScheduleSettingsUpdate`, a sparse write — the profile
 * seam replaces district and mission when they are omitted. They are written
 * BEFORE the rule, so meetings recreated by the time change take the new default
 * length.
 *
 * ## Refusals
 *
 * `FORBIDDEN` for a plain member, `ARCHIVED` for an archived club (both from
 * `authorizeToken`, which runs BEFORE the input bounds are checked, so a member
 * never learns them), `VALIDATION` for no field, a bad time or length, or a
 * time change on a club with no standing rule or with its schedule switched off.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import {
	MAX_DEFAULT_MEETING_MINUTES,
	MAX_SCHEDULE_TEXT_CHARS,
	normalizeScheduleText,
} from "#/lib/club-schedule-settings";
import { utcToZonedWallTime } from "#/lib/datetime";
import { planHash } from "#/lib/mcp-plan";
import { applyClubScheduleSettingsUpdate } from "#/server/clubs-logic";
import {
	getRecurrenceRule,
	lockRecurrenceRule,
	type RecurrenceRuleInput,
	type RecurrenceRuleRow,
	ruleToInput,
	saveRecurrenceRuleIn,
	selectOldPatternMeetings,
} from "#/server/recurrence-rule-logic";
import { type DbOrTx, planTopUpInstants } from "#/server/schedule-topup-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const UPDATE_MEETING_SCHEDULE_TOOL = "update_meeting_schedule";

export const NO_STANDING_RULE_MESSAGE =
	"This club has no standing meeting schedule yet. Set up a meeting schedule in the app first.";
export const NOTHING_TO_CHANGE_MESSAGE =
	"Send at least one of timeOfDay, scheduleText or defaultMeetingMinutes.";
export const BAD_TIME_MESSAGE =
	"timeOfDay must be a club-local 24-hour time like 18:45.";
export const SWITCHED_OFF_MESSAGE =
	"This club's standing meeting schedule is switched off, so a new time would delete meetings and create none. Switch the schedule on in the app first, then change the time.";
const STALE_PLAN_MESSAGE =
	"The club's schedule or its meetings changed since that preview. Show the user the fresh plan and ask again.";

const inputSchema = {
	clubId: z.string().uuid(),
	timeOfDay: z
		.string()
		.optional()
		.describe("The standing meeting time, club-local 24-hour HH:mm."),
	scheduleText: z
		.string()
		.max(MAX_SCHEDULE_TEXT_CHARS)
		.nullable()
		.optional()
		.describe(
			"The free-text schedule line shown to guests, e.g. '2nd & 4th Thursday, 6:45-7:45 PM'. null clears it. Never changed unless sent.",
		),
	defaultMeetingMinutes: z
		.number()
		.int()
		.positive()
		.max(MAX_DEFAULT_MEETING_MINUTES)
		.optional()
		.describe("The length new meetings get. Existing meetings keep theirs."),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type Change<T> = { from: T; to: T };

type MeetingLine = {
	meetingId: string;
	/** Club-local date, YYYY-MM-DD. */
	date: string;
	/** Club-local HH:mm now. */
	time: string;
};

type SchedulePlan = {
	clubId: string;
	timezone: string;
	/** Only the fields that CHANGE; a field sent with its current value is absent. */
	changes: {
		timeOfDay?: Change<string>;
		scheduleText?: Change<string | null>;
		defaultMeetingMinutes?: Change<number>;
	};
	noop: boolean;
	/** What a meeting made from now on gets: the sent default length, else the stored one. */
	lengthForNewMeetings: number;
	/** Deleted, and the save creates a replacement on the same date at `newTime`. */
	recreated: (MeetingLine & { newTime: string })[];
	/** Deleted with NO replacement (the top-up will not create one): lost. */
	removedWithoutReplacement: MeetingLine[];
	/** Every meeting the save's top-up will create, from the top-up's own slot logic. */
	created: { date: string; time: string }[];
	/** Touched meetings on the old pattern: they keep their time. */
	staying: (MeetingLine & { note: string })[];
	/** The stored rule the time change is made on top of (no timestamps). */
	storedRule: RecurrenceRuleInput | null;
	/** The line as stored, when a time change leaves it possibly stale. */
	currentScheduleText: string | null;
	warnings: string[];
};

function wallTime(instant: Date, tz: string): { date: string; time: string } {
	const w = utcToZonedWallTime(instant, tz);
	return { date: w.slice(0, 10), time: w.slice(11, 16) };
}

type Args = {
	timeOfDay?: string;
	scheduleText?: string | null;
	defaultMeetingMinutes?: number;
};

/** Build the plan from what is stored now. Read-only. */
async function buildPlan(
	conn: DbOrTx,
	clubId: string,
	args: Args,
	now: Date,
): Promise<{ plan: SchedulePlan; rule: RecurrenceRuleRow | null }> {
	const [club] = await conn
		.select({
			timezone: clubs.timezone,
			meetingSchedule: clubs.meetingSchedule,
			defaultMeetingMinutes: clubs.defaultMeetingMinutes,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	// Unreachable: authorization just resolved this club.
	if (!club) throw new McpError("NOT_FOUND", "Club not found.");

	const rule = await getRecurrenceRule(clubId, conn);
	if (args.timeOfDay !== undefined && !rule) {
		throw new McpError("VALIDATION", NO_STANDING_RULE_MESSAGE);
	}

	const changes: SchedulePlan["changes"] = {};
	const warnings: string[] = [];
	const recreated: SchedulePlan["recreated"] = [];
	const removedWithoutReplacement: SchedulePlan["removedWithoutReplacement"] =
		[];
	let created: SchedulePlan["created"] = [];
	let staying: SchedulePlan["staying"] = [];

	if (
		rule &&
		args.timeOfDay !== undefined &&
		args.timeOfDay !== rule.timeOfDay
	) {
		if (!rule.enabled) {
			throw new McpError("VALIDATION", SWITCHED_OFF_MESSAGE);
		}
		const newTime = args.timeOfDay;
		changes.timeOfDay = { from: rule.timeOfDay, to: newTime };
		const { deleted, kept } = await selectOldPatternMeetings(
			rule,
			clubId,
			club.timezone,
			now,
			conn,
		);

		// The replacements: the top-up's own slot logic, on the meetings that will
		// remain and the rule as it will be stored.
		const gone = new Set(deleted.map((m) => m.id));
		const remaining = (
			await conn
				.select({
					id: meetings.id,
					scheduledAt: meetings.scheduledAt,
					status: meetings.status,
				})
				.from(meetings)
				.where(eq(meetings.clubId, clubId))
		).filter((m) => !gone.has(m.id));
		const instants = planTopUpInstants({
			rule: { ...rule, timeOfDay: newTime },
			timezone: club.timezone,
			existing: remaining,
			now,
		});
		created = instants.map((i) => wallTime(i, club.timezone));
		const createdByDate = new Map(created.map((c) => [c.date, c.time]));

		for (const m of deleted) {
			const line = wallTime(m.scheduledAt, club.timezone);
			const replacementTime = createdByDate.get(line.date);
			if (replacementTime === undefined) {
				removedWithoutReplacement.push({ meetingId: m.id, ...line });
			} else {
				recreated.push({
					meetingId: m.id,
					...line,
					newTime: replacementTime,
				});
			}
		}
		staying = kept.map((m) => ({
			meetingId: m.id,
			...wallTime(m.scheduledAt, club.timezone),
			note: "Someone has touched this meeting, so it keeps its old time. Move it on its own in the app.",
		}));
		if (removedWithoutReplacement.length > 0) {
			warnings.push(
				`${removedWithoutReplacement.length} meeting${removedWithoutReplacement.length === 1 ? "" : "s"} under \`removedWithoutReplacement\` will be deleted and no meeting will take ${removedWithoutReplacement.length === 1 ? "its" : "their"} place, because the new time has already passed or the schedule is already full.`,
			);
		}
	}

	if (args.scheduleText !== undefined) {
		const next = normalizeScheduleText(args.scheduleText);
		if (next !== club.meetingSchedule) {
			changes.scheduleText = { from: club.meetingSchedule, to: next };
		}
	}
	if (
		args.defaultMeetingMinutes !== undefined &&
		args.defaultMeetingMinutes !== club.defaultMeetingMinutes
	) {
		changes.defaultMeetingMinutes = {
			from: club.defaultMeetingMinutes,
			to: args.defaultMeetingMinutes,
		};
	}

	if (changes.timeOfDay && args.scheduleText === undefined) {
		warnings.push(
			club.meetingSchedule
				? `The schedule line guests see ("${club.meetingSchedule}") is left as it is and may now be out of date. Send scheduleText to change it.`
				: "No schedule line is set for guests, so nothing there can be out of date.",
		);
	}

	const noop = Object.keys(changes).length === 0;
	return {
		rule,
		plan: {
			clubId,
			timezone: club.timezone,
			changes,
			noop,
			lengthForNewMeetings:
				args.defaultMeetingMinutes ?? club.defaultMeetingMinutes,
			recreated,
			removedWithoutReplacement,
			created,
			staying,
			storedRule: rule ? ruleToInput(rule) : null,
			currentScheduleText: club.meetingSchedule,
			warnings,
		},
	};
}

function summarize(plan: SchedulePlan): string {
	if (plan.noop) return "Nothing to change: every value sent is already set.";
	const parts: string[] = [];
	const c = plan.changes;
	if (c.timeOfDay) {
		parts.push(
			`standing time ${c.timeOfDay.from} to ${c.timeOfDay.to} (${plan.recreated.length} meeting${plan.recreated.length === 1 ? "" : "s"} recreated, ${plan.removedWithoutReplacement.length} deleted with no replacement, ${plan.staying.length} kept at the old time)`,
		);
	}
	if (c.scheduleText) parts.push("schedule line");
	if (c.defaultMeetingMinutes) {
		parts.push(
			`default length ${c.defaultMeetingMinutes.from} to ${c.defaultMeetingMinutes.to} min`,
		);
	}
	return `Will change: ${parts.join("; ")}.`;
}

export const updateMeetingScheduleTool: McpToolDefinition = {
	name: UPDATE_MEETING_SCHEDULE_TOOL,
	audience: "officer",
	// A time change deletes untouched future meetings and recreates them.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Update meeting schedule",
		description:
			"Change the club's standing meeting time (timeOfDay, club-local HH:mm), " +
			"its free-text schedule line (scheduleText) and/or the length new " +
			"meetings get (defaultMeetingMinutes). Send at least one. Without " +
			"planHash this writes nothing: it returns a plan with old to new for " +
			"each field, the future meetings a time change will delete and " +
			"recreate at the new time, the touched meetings that keep their old " +
			"time, any warnings, and a planHash. Show the plan to the user; call " +
			"again with the same input plus that planHash to apply it. The " +
			"schedule line is never rewritten unless sent. Needs an existing " +
			"standing schedule for a time change. It does not change the weekday " +
			"or pattern.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		// Authorize FIRST, on the club id alone: a plain member sending a bad
		// length must get FORBIDDEN, not a VALIDATION message that reveals the
		// bounds. An id that is no uuid names no club to authorize against.
		const clubIdParsed = inputSchema.clubId.safeParse(
			(input as { clubId?: unknown }).clubId,
		);
		if (!clubIdParsed.success) {
			throw new McpError("VALIDATION", "clubId: must be a club id.");
		}
		const { club, user } = await authorizeToken(ctx, clubIdParsed.data);
		const clubId = club.clubId;

		// safeParse, so a bad length or text is `VALIDATION` here too and not a
		// bare ZodError the transport has to translate.
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
			args.timeOfDay === undefined &&
			args.scheduleText === undefined &&
			args.defaultMeetingMinutes === undefined
		) {
			throw new McpError("VALIDATION", NOTHING_TO_CHANGE_MESSAGE);
		}
		if (args.timeOfDay !== undefined && !TIME_RE.test(args.timeOfDay)) {
			throw new McpError("VALIDATION", BAD_TIME_MESSAGE);
		}

		const hashOf = (plan: SchedulePlan) =>
			planHash({
				tool: UPDATE_MEETING_SCHEDULE_TOOL,
				clubId,
				userId: user.id,
				plan,
			});
		const staleError = (plan: SchedulePlan) =>
			new McpError("PLAN_STALE", STALE_PLAN_MESSAGE, {
				plan,
				planHash: hashOf(plan),
				summary: summarize(plan),
			});

		const now = new Date();

		if (args.planHash === undefined) {
			const { plan } = await buildPlan(db, clubId, args, now);
			return {
				applied: false,
				clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
			};
		}

		// Re-plan, compare and write in ONE transaction, with the rule row locked
		// so a web save of the same club waits and cannot interleave.
		type Outcome =
			| { stale: SchedulePlan }
			| { plan: SchedulePlan; created: number };
		const DRIFT = Symbol("planned delete set drifted");
		let outcome: Outcome;
		try {
			outcome = await db.transaction(async (tx): Promise<Outcome> => {
				await lockRecurrenceRule(tx, clubId);
				const { plan, rule } = await buildPlan(tx, clubId, args, now);
				if (hashOf(plan) !== args.planHash) return { stale: plan };
				if (plan.noop) return { plan, created: 0 };

				// Club columns before the top-up, so meetings the time change recreates
				// take the new default length; but AFTER the delete selection, which
				// compares each meeting with the old default. A time change writes them
				// through `saveRecurrenceRuleIn`'s hook; otherwise right here.
				const writeClubColumns = () =>
					applyClubScheduleSettingsUpdate(
						{
							clubId,
							...(plan.changes.scheduleText && {
								meetingSchedule: plan.changes.scheduleText.to,
							}),
							...(plan.changes.defaultMeetingMinutes && {
								defaultMeetingMinutes: plan.changes.defaultMeetingMinutes.to,
							}),
						},
						tx,
					).then(() => undefined);

				let created = 0;
				if (plan.changes.timeOfDay && rule) {
					const saved = await saveRecurrenceRuleIn(
						tx,
						clubId,
						{ ...ruleToInput(rule), timeOfDay: plan.changes.timeOfDay.to },
						now,
						writeClubColumns,
					);
					created = saved.created;
					const planned = [
						...plan.recreated.map((m) => m.meetingId),
						...plan.removedWithoutReplacement.map((m) => m.meetingId),
					].sort();
					const deleted = [...saved.deletedMeetingIds].sort();
					if (
						planned.length !== deleted.length ||
						planned.some((id, i) => id !== deleted[i])
					) {
						throw DRIFT;
					}
				} else {
					await writeClubColumns();
				}
				return { plan, created };
			});
		} catch (e) {
			if (e !== DRIFT) throw e;
			// Rolled back. Plan again from what is stored now.
			const { plan } = await buildPlan(db, clubId, args, now);
			throw staleError(plan);
		}

		if ("stale" in outcome) throw staleError(outcome.stale);
		return {
			applied: true,
			clubId,
			summary: summarize(outcome.plan),
			plan: outcome.plan,
			created: outcome.created,
		};
	},
};
