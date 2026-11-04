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
 * both the delete and this preview use. The integration test asserts the planned set
 * equals what the save really deleted, so a drift between the two fails there.
 * The planHash covers the stored rule, the text, the length AND both meeting
 * sets, so a meeting someone touches between preview and apply is `PLAN_STALE`.
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
 * `authorizeToken`), `VALIDATION` for no field, a bad time or length, or a time
 * change on a club with no standing rule.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs } from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { planHash } from "#/lib/mcp-plan";
import { applyClubScheduleSettingsUpdate } from "#/server/clubs-logic";
import {
	getRecurrenceRule,
	type RecurrenceRuleInput,
	type RecurrenceRuleRow,
	saveRecurrenceRule,
	selectOldPatternMeetings,
} from "#/server/recurrence-rule-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const UPDATE_MEETING_SCHEDULE_TOOL = "update_meeting_schedule";

/** A day is the longest a meeting can be; also keeps the integer column safe. */
export const MAX_DEFAULT_MEETING_MINUTES = 1440;
const MAX_SCHEDULE_TEXT_CHARS = 200;

export const NO_STANDING_RULE_MESSAGE =
	"This club has no standing meeting schedule yet. Set up a meeting schedule in the app first.";
export const NOTHING_TO_CHANGE_MESSAGE =
	"Send at least one of timeOfDay, scheduleText or defaultMeetingMinutes.";
export const BAD_TIME_MESSAGE =
	"timeOfDay must be a club-local 24-hour time like 18:45.";
const MEETINGS_MOVED_MESSAGE =
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
	/** Deleted and recreated at `newTime` by the save. */
	recreated: (MeetingLine & { newTime: string })[];
	/** Touched meetings on the old pattern: they keep their time. */
	staying: (MeetingLine & { note: string })[];
	/** The stored rule the time change is made on top of (no timestamps). */
	storedRule: Omit<
		RecurrenceRuleRow,
		"createdAt" | "updatedAt" | "clubId" | "id"
	> | null;
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
	clubId: string,
	args: Args,
	now: Date,
): Promise<{ plan: SchedulePlan; rule: RecurrenceRuleRow | null }> {
	const [club] = await db
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

	const rule = await getRecurrenceRule(clubId);
	if (args.timeOfDay !== undefined && !rule) {
		throw new McpError("VALIDATION", NO_STANDING_RULE_MESSAGE);
	}

	const changes: SchedulePlan["changes"] = {};
	const warnings: string[] = [];
	let recreated: SchedulePlan["recreated"] = [];
	let staying: SchedulePlan["staying"] = [];

	if (
		rule &&
		args.timeOfDay !== undefined &&
		args.timeOfDay !== rule.timeOfDay
	) {
		const newTime = args.timeOfDay;
		changes.timeOfDay = { from: rule.timeOfDay, to: newTime };
		const { deleted, kept } = await selectOldPatternMeetings(
			rule,
			clubId,
			club.timezone,
			now,
		);
		recreated = deleted.map((m) => ({
			meetingId: m.id,
			...wallTime(m.scheduledAt, club.timezone),
			newTime,
		}));
		staying = kept.map((m) => ({
			meetingId: m.id,
			...wallTime(m.scheduledAt, club.timezone),
			note: "Someone has touched this meeting, so it keeps its old time. Move it on its own in the app.",
		}));
		if (!rule.enabled && recreated.length > 0) {
			warnings.push(
				"This club's standing schedule is switched off, so the meetings listed under `recreated` will be deleted and NOT recreated until it is switched back on in the app.",
			);
		}
	}

	if (args.scheduleText !== undefined) {
		const next = args.scheduleText?.trim() ? args.scheduleText.trim() : null;
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
			recreated,
			staying,
			storedRule: rule
				? {
						mode: rule.mode,
						weekday: rule.weekday,
						intervalWeeks: rule.intervalWeeks,
						anchorDate: rule.anchorDate,
						ordinals: rule.ordinals,
						timeOfDay: rule.timeOfDay,
						location: rule.location,
						keepAhead: rule.keepAhead,
						enabled: rule.enabled,
					}
				: null,
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
			`standing time ${c.timeOfDay.from} to ${c.timeOfDay.to} (${plan.recreated.length} meeting${plan.recreated.length === 1 ? "" : "s"} recreated, ${plan.staying.length} kept at the old time)`,
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
		const { club, user } = await authorizeToken(ctx, args.clubId);
		const clubId = club.clubId;

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

		const now = new Date();
		const { plan, rule } = await buildPlan(clubId, args, now);

		if (args.planHash === undefined) {
			return {
				applied: false,
				clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
			};
		}

		const freshHash = hashOf(plan);
		if (freshHash !== args.planHash) {
			throw new McpError("PLAN_STALE", MEETINGS_MOVED_MESSAGE, {
				plan,
				planHash: freshHash,
				summary: summarize(plan),
			});
		}

		if (plan.noop) {
			return {
				applied: true,
				clubId,
				summary: summarize(plan),
				plan,
				created: 0,
			};
		}

		// Club columns first, so meetings the time change recreates take the new
		// default length.
		await applyClubScheduleSettingsUpdate({
			clubId,
			...(plan.changes.scheduleText && {
				meetingSchedule: plan.changes.scheduleText.to,
			}),
			...(plan.changes.defaultMeetingMinutes && {
				defaultMeetingMinutes: plan.changes.defaultMeetingMinutes.to,
			}),
		});

		let created = 0;
		if (plan.changes.timeOfDay && rule) {
			const next: RecurrenceRuleInput = {
				mode: rule.mode as RecurrenceRuleInput["mode"],
				weekday: rule.weekday,
				intervalWeeks: rule.intervalWeeks,
				anchorDate: rule.anchorDate,
				ordinals: rule.ordinals,
				timeOfDay: plan.changes.timeOfDay.to,
				location: rule.location,
				keepAhead: rule.keepAhead,
				enabled: rule.enabled,
			};
			({ created } = await saveRecurrenceRule(clubId, next, now));
		}

		return {
			applied: true,
			clubId,
			summary: summarize(plan),
			plan,
			created,
		};
	},
};
