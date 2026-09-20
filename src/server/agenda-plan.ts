/**
 * The `upsert_agendas` planner (#808): a set of club-local dates → what each one
 * would do.
 *
 * Shared by the MCP preview, by every render of the confirm page, and by the
 * re-plan inside the apply transaction, so none of the three can drift — which
 * is the whole basis of the hash comparison. Same shape as
 * `src/server/guest-book-plan.ts`, for the same reason.
 *
 * ## Why this is not under `src/server/mcp/`
 *
 * `mcp-authz.guard.test.ts` fails any `.ts` under `src/server/mcp/` that imports
 * a session guard, and it should: `/api/mcp` is bearer-only, and that is the
 * whole CSRF posture. The confirm page is authorized by a SESSION and re-plans
 * through this module, so the planner cannot live in that tree — the same move
 * #806 made for `guest-book-plan.ts`. `blocking-codes.guard.test.ts` enrols this
 * file so its codes still count as raised.
 *
 * ## The query budget is CONSTANT in the size of the batch
 *
 * Planning 52 dates costs what planning one costs. The naive loop issues a
 * lookup per date, and this function runs on the preview, on every render of the
 * page, and again inside the apply transaction **while the club's advisory lock
 * is held** — where `lock.ts` allows 5s and `src/db/index.ts` takes a pool of 10
 * shared by the whole app. 52 round trips inside that lock is the shape that
 * starves unrelated requests.
 *
 * TWO statements, whatever the batch:
 *
 *   1. the club (timezone, `default_meeting_minutes`) LEFT JOINed to its
 *      standing recurrence rule (time-of-day, location, weekday);
 *   2. the club's meetings, ordered by `scheduled_at`.
 *
 * Everything else — which date names which meeting, the field diff, the weekday
 * check — is done in memory. `agenda-plan-query-budget.integration.test.ts`
 * counts them.
 *
 * #808's own budget named three statements: meetings, role definitions, and the
 * club. It is two here, and the difference is worth stating because a reviewer
 * counting against the issue would otherwise think something was skipped. The
 * recurrence rule it did not list is folded into the club's row by the join. The
 * role definitions are NOT read here at all: a plan says "create a meeting on
 * that date" and role slots are generated at APPLY time, so reading the template
 * on every render of the page would be work thrown away every time.
 *
 * ## Why the meetings query is not ranged
 *
 * #808 specified `WHERE scheduled_at BETWEEN min(dates) AND max(dates)`. That
 * covers classification and the diff and NOT the meeting number: numbers freeze
 * when a meeting is completed (#358) and `deriveMeetingNumber` counts forward
 * from the most recent numbered meeting in the club, so it needs the whole
 * ordered spine — which is why `list_meetings` reads one beside its ranged
 * query. One unranged select carrying both the spine columns and the meta is
 * strictly fewer statements than a ranged select plus a spine, and it is the
 * same read `applyBatchCreateMeetings` and `ensureScheduleToppedUp` already make
 * on this very path.
 */
import { asc, eq } from "drizzle-orm";
import type { db } from "#/db";
import { clubMeetingRecurrence, clubs, meetings } from "#/db/schema";
import {
	type AgendaCreateMeta,
	type AgendaEntry,
	type AgendaFieldChange,
	type AgendaMetaField,
	agendaCreateMeta,
	agendaFieldChanges,
	ambiguousDateMessage,
	missingTimeMessage,
	normalizeMetaValue,
} from "#/lib/agenda-upsert";
import {
	localDateWeekday,
	localDateWeekdayIndex,
	type Weekday,
} from "#/lib/club-local-date";
import { utcToZonedWallTime } from "#/lib/datetime";
import { planHash } from "#/lib/mcp-plan";
import {
	isMeetingLocked,
	MEETING_LOCKED_BLOCKING_MESSAGE,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNumber } from "#/lib/meeting-number";
import { UPSERT_AGENDAS_TOOL } from "#/lib/pending-plan";
import { type McpBlockingItem, McpError } from "#/server/mcp/errors";

type Conn =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Things a line reports that do NOT stop the apply.
 *
 * `weekday_mismatch` — the club has a standing rule and this date falls on a
 * different weekday. A special meeting on another day is legitimate (#808), so
 * this is said and not refused.
 *
 * `meeting_cancelled` — the date names a cancelled meeting. It still occupies
 * its calendar date (cancellation is the skip mechanism, see
 * `schedule-topup-logic.ts`), so this really is the meeting the caller means;
 * they should just know which one they are editing.
 *
 * `time_ignored` — the entry named a time and the meeting already exists at a
 * different one. Moving a meeting is a reschedule with its own authorization
 * (ADR-0010) and is out of scope for this tool, so the time is dropped — said
 * out loud rather than discarded silently, which is the rule `DUPLICATE_SLOT`
 * states for `assign_roles`.
 */
export type AgendaWarning =
	| "weekday_mismatch"
	| "meeting_cancelled"
	| "time_ignored";

interface AgendaLineBase {
	/** Index into the call's own `meetings` array. */
	index: number;
	date: string;
	weekday: Weekday;
	warnings: AgendaWarning[];
}

export interface AgendaCreateLine extends AgendaLineBase {
	action: "create";
	/** Club-local `HH:MM` the meeting would start at. */
	time: string;
	location: string | null;
	meta: AgendaCreateMeta;
}

export interface AgendaUpdateLine extends AgendaLineBase {
	action: "update";
	meetingId: string;
	/** Club-local `HH:MM` the meeting already starts at. Not changed. */
	time: string;
	/** ONLY the fields that actually move. An empty list is a no-op line. */
	changes: AgendaFieldChange[];
}

export type AgendaPlanLine = AgendaCreateLine | AgendaUpdateLine;

/**
 * What the apply executes, and the ONLY thing the hash is taken over.
 *
 * The rule is about REACH, not about how a fact was derived. Almost everything
 * here is read from live state — a change's `from` side is the whole point of
 * the hash — so "live-derived" cannot be the exclusion test. What is excluded
 * is anything that moves because of a meeting this plan does NOT name: the
 * meeting numbers below are derived from the club's whole spine, so completing
 * an unrelated meeting elsewhere in the season would change every provisional
 * number and fail an outstanding link as stale for a reason that has nothing to
 * do with it.
 *
 * `warnings` is therefore INSIDE, deliberately. `meeting_cancelled` is read
 * from live state like the numbers are, but it is a fact about a meeting this
 * plan names by date — so a reader who was shown "this meeting is cancelled",
 * or was not, should look again before it is written. Same rule, different
 * side of it, as `GuestBookPlan`.
 */
export interface AgendaPlan {
	lines: AgendaPlanLine[];
}

export interface AgendaPlanResult {
	plan: AgendaPlan;
	blocking: McpBlockingItem[];
	/**
	 * The provisional meeting number for each `update` line, keyed by its index.
	 *
	 * Shown to the reader, never hashed — see `AgendaPlan`. Absent for a
	 * `create`: the meeting has no id yet, and this tool never WRITES a number
	 * anyway (#358 — one stored number renumbers every later un-numbered meeting
	 * in the club).
	 */
	meetingNumbers: Record<number, number | null>;
	/**
	 * `clubs.default_meeting_minutes`, for the apply's `create` branch.
	 *
	 * Returned from here because the planner has already read the club row and a
	 * second read inside the locked transaction would be a query for a value that
	 * is sitting right there. Deliberately OUTSIDE `AgendaPlan` and so outside
	 * the hash: `lengthMinutes` is copy-at-insert, so a club changing its default
	 * should not fail every outstanding confirm link as stale.
	 */
	defaultMeetingMinutes: number;
}

export interface AgendaPlanClub {
	clubId: string;
	timezone: string;
}

/** One club meeting as the planner reads it: the spine columns plus the meta. */
interface MeetingRow {
	id: string;
	scheduledAt: Date;
	status: "scheduled" | "cancelled" | "completed";
	meetingNumber: number | null;
	theme: string | null;
	wordOfTheDay: string | null;
	wodDefinition: string | null;
	wodExample: string | null;
	location: string | null;
}

function storedMeta(m: MeetingRow): Record<AgendaMetaField, string | null> {
	return {
		theme: m.theme,
		wordOfTheDay: m.wordOfTheDay,
		wodDefinition: m.wodDefinition,
		wodExample: m.wodExample,
		location: m.location,
	};
}

/**
 * Plan every date in one pass.
 *
 * `conn` is `db` on the preview and on every render, and the transaction handle
 * inside the apply — so the re-plan that the hash is compared against sees the
 * locked state and nothing else.
 *
 * Duplicate dates within one call are NOT handled here, deliberately: they are
 * rejected at the input boundary as a `VALIDATION` error
 * (`upsert-agendas.ts`'s schema) and again by the stored-payload parser
 * (`agenda-plan-pending-schemas.ts`), which is the right shape for a mistake the
 * caller can see for itself — the same reasoning `errors.ts` records for
 * `FIELD_TOO_LONG`. A blocking code for it would be a third enforcement point
 * nothing could reach.
 */
export async function plan(
	conn: Conn,
	club: AgendaPlanClub,
	entries: AgendaEntry[],
): Promise<AgendaPlanResult> {
	const blocking: McpBlockingItem[] = [];

	const [clubRow] = await conn
		.select({
			defaultMeetingMinutes: clubs.defaultMeetingMinutes,
			// `enabled` is deliberately NOT read. A DISABLED rule still supplies a
			// time and a weekday — see below — so selecting it would be a column
			// nothing branches on.
			ruleWeekday: clubMeetingRecurrence.weekday,
			ruleTimeOfDay: clubMeetingRecurrence.timeOfDay,
			ruleLocation: clubMeetingRecurrence.location,
		})
		.from(clubs)
		.leftJoin(clubMeetingRecurrence, eq(clubMeetingRecurrence.clubId, clubs.id))
		.where(eq(clubs.id, club.clubId))
		.limit(1);
	if (!clubRow) throw new McpError("NOT_FOUND", "Club not found.");

	// A DISABLED rule still supplies a time and a weekday. Pausing top-up (#190)
	// says "stop materialising meetings", not "the club has forgotten when it
	// meets" — and a caller naming a date explicitly is not asking for top-up.
	// Only the ABSENCE of a row means there is nothing to fall back on.
	//
	// Both halves are null-CHECKED rather than cast. The left join makes every
	// rule column nullable, and `weekday` is `notNull()` on a row that exists, so
	// an `as number` would be true today and silently wrong the day that column
	// changes — the kind of claim that survives typecheck and fails at runtime.
	const rule =
		clubRow.ruleTimeOfDay === null || clubRow.ruleWeekday === null
			? null
			: {
					weekday: clubRow.ruleWeekday,
					timeOfDay: clubRow.ruleTimeOfDay,
					location: clubRow.ruleLocation,
				};

	const spine: MeetingRow[] = await conn
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
			meetingNumber: meetings.meetingNumber,
			theme: meetings.theme,
			wordOfTheDay: meetings.wordOfTheDay,
			wodDefinition: meetings.wodDefinition,
			wodExample: meetings.wodExample,
			location: meetings.location,
		})
		.from(meetings)
		.where(eq(meetings.clubId, club.clubId))
		.orderBy(asc(meetings.scheduledAt));

	// ONE grouping pass over the club, not one lookup per requested date. This is
	// what makes 52 dates cost what one costs.
	const byDate = new Map<string, MeetingRow[]>();
	for (const m of spine) {
		const date = utcToZonedWallTime(m.scheduledAt, club.timezone).slice(0, 10);
		const list = byDate.get(date);
		if (list) list.push(m);
		else byDate.set(date, [m]);
	}

	const lines: AgendaPlanLine[] = [];
	const meetingNumbers: Record<number, number | null> = {};

	for (const [index, entry] of entries.entries()) {
		const weekday = localDateWeekday(entry.date);
		const warnings: AgendaWarning[] = [];
		// Not blocking: a special meeting on another day is legitimate (AC5).
		if (rule && localDateWeekdayIndex(entry.date) !== rule.weekday) {
			warnings.push("weekday_mismatch");
		}

		const onDate = byDate.get(entry.date) ?? [];

		if (onDate.length > 1) {
			// The unique index covers the exact INSTANT, not the date, so two
			// meetings on one club-local day are perfectly legal and this tool has
			// no way to pick between them.
			blocking.push({
				code: "AMBIGUOUS_DATE",
				entryIndex: index,
				message: ambiguousDateMessage(entry.date),
				detail: { date: entry.date, meetingIds: onDate.map((m) => m.id) },
			});
			continue;
		}

		const existing = onDate[0];

		if (!existing) {
			const time = entry.time ?? rule?.timeOfDay;
			if (!time) {
				blocking.push({
					code: "MISSING_TIME",
					entryIndex: index,
					message: missingTimeMessage(entry.date),
					detail: { date: entry.date },
				});
				continue;
			}
			const location = normalizeMetaValue(entry.location);
			lines.push({
				index,
				date: entry.date,
				weekday,
				warnings,
				action: "create",
				time,
				// An entry that says nothing about location inherits the club's
				// standing one, matching `ensureScheduleToppedUp`; an entry that
				// explicitly clears it gets null.
				location: location === undefined ? (rule?.location ?? null) : location,
				meta: agendaCreateMeta(entry),
			});
			continue;
		}

		// The lock is the AGENDA's, and it is enforced twice on purpose (AC13):
		// here, so the page explains it before the reader clicks, and again inside
		// the apply transaction, where a meeting completed in between is caught.
		// The two say different sentences — see `AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE`.
		if (isMeetingLocked(existing.status)) {
			blocking.push({
				code: "MEETING_LOCKED",
				entryIndex: index,
				message: MEETING_LOCKED_BLOCKING_MESSAGE,
				detail: { date: entry.date, meetingId: existing.id },
			});
			continue;
		}

		if (existing.status === "cancelled") warnings.push("meeting_cancelled");

		const time = utcToZonedWallTime(existing.scheduledAt, club.timezone).slice(
			11,
			16,
		);
		if (entry.time && entry.time !== time) warnings.push("time_ignored");

		lines.push({
			index,
			date: entry.date,
			weekday,
			warnings,
			action: "update",
			meetingId: existing.id,
			time,
			changes: agendaFieldChanges(entry, storedMeta(existing)),
		});
		meetingNumbers[index] = deriveMeetingNumber(spine, existing.id);
	}

	return {
		plan: { lines },
		blocking,
		meetingNumbers,
		defaultMeetingMinutes: clubRow.defaultMeetingMinutes,
	};
}

/**
 * The plan hash, for the MCP preview, for every render of the confirm page, and
 * for the comparison inside the apply transaction.
 *
 * `tool` stays `"upsert_agendas"` and `userId` stays the plan's CREATOR — the
 * only user who can open the confirm link — so the preview and every later
 * render hash the same function of the same inputs. Changing either would fail
 * every outstanding link as stale on deploy.
 */
export function agendaPlanHash(input: {
	clubId: string;
	userId: string;
	plan: AgendaPlan;
}): string {
	return planHash({
		// The shared constant, NOT a literal. `PlanHashInput.tool` is `string`,
		// so a typo here typechecks and fails every outstanding link as stale.
		tool: UPSERT_AGENDAS_TOOL,
		clubId: input.clubId,
		userId: input.userId,
		plan: input.plan,
	});
}

/** The per-action tallies a reader checks before saying yes. */
export function agendaPlanSummary(p: AgendaPlan) {
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	for (const line of p.lines) {
		if (line.action === "create") created++;
		else if (line.changes.length > 0) updated++;
		else unchanged++;
	}
	return { created, updated, unchanged, total: p.lines.length };
}
