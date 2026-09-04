/**
 * Club Officer Training (COT) DB logic — the record behind DCP goal 9 (#531).
 *
 * Split out of the `createServerFn` module `officer-training.ts` for both
 * reasons CLAUDE.md gives. Bundle: a plain db-touching export in a server-fn
 * module is NOT stripped and drags `#/db` → `pg` → `Buffer` into the browser
 * (`server-modules.guard.test.ts` enforces it). Reachability: a
 * `createServerFn` handler cannot be invoked from vitest, so a query left
 * inline there is coverable by a source grep and nothing else — and the whole
 * point of #531 is that the counting rule ("distinct PEOPLE") is testable.
 *
 * All the rules — the four-officer bar, TI's default windows, the leap year, the
 * distinct-people de-dup, the goal-9 suggestion — live in the pure, client-safe
 * `#/lib/officer-training`. This module only fetches rows and hands them over.
 *
 * ## Authorization lives in the caller, as it does for the rest of DCP
 *
 * Every seam here is reached only through `officer-training.ts`, whose fns run
 * `requireUser()` + `requireClubRole(userId, clubId, ["admin"])`. That is
 * ADR-0019 §4: the President resolves to club `admin` through effective-admin,
 * so no officer-position-based authz is introduced — an officer does not get to
 * record their own training. `requireClubRole` → `requireMembership` also
 * carries the `clubs.archived_at` gate, which is why these functions do not
 * call `assertClubNotArchived` themselves (matching `dcp-logic.ts`).
 *
 * What the seam DOES enforce, because a session cannot: **club scoping on every
 * id the caller supplies.** A membership id and a record id both arrive from the
 * client, and `requireClubRole` proves the caller administers `clubId` — not
 * that the id they passed belongs to it. Both write paths therefore re-derive
 * the club from `members.club_id` and refuse a mismatch, so an admin of club A
 * cannot write into or delete out of club B.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	members,
	officerTerms,
	officerTrainingPeriods,
	officerTrainingRecords,
} from "#/db/schema";
import {
	countTrainedOfficers,
	defaultTrainingWindow,
	focusPeriod,
	type IsoDate,
	isIsoDate,
	isOutsideWindow,
	isTrainablePosition,
	type OfficerSeat,
	suggestG9,
	TRAINING_PERIODS,
	type TrainingPeriod,
	type TrainingPeriodTally,
	type TrainingRecordLike,
	type TrainingWindow,
	tallyPeriod,
	todayIso,
} from "#/lib/officer-training";
import { type OfficerPosition, officerRank } from "#/lib/officers";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const clubYear = {
	clubId: z.string().uuid(),
	// Same bounds as the DCP scoreboard schemas, so a training row can never name
	// a year no scoreboard could exist for.
	programYear: z.number().int().min(2000).max(2100),
};

/**
 * 1 or 2. A `z.union` of literals rather than `min(1).max(2)` so the parsed type
 * is `TrainingPeriod` and not `number` — the pure helpers are keyed on the
 * literal union, and widening here would push a cast into every call site.
 */
const periodSchema = z.union([z.literal(1), z.literal(2)]);

/** `YYYY-MM-DD`, and a real calendar day — `2026-02-31` parses and is rejected. */
const isoDateSchema = z
	.string()
	.refine(isIsoDate, "Enter a date as YYYY-MM-DD.")
	.refine((v) => {
		const d = new Date(`${v}T00:00:00Z`);
		return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
	}, "That is not a real calendar date.");

export const getOfficerTrainingSchema = z.object(clubYear);
export type GetOfficerTrainingInput = z.infer<typeof getOfficerTrainingSchema>;

export const setTrainingWindowSchema = z
	.object({
		...clubYear,
		period: periodSchema,
		startsOn: isoDateSchema,
		endsOn: isoDateSchema,
	})
	// Mirrors the `officer_training_periods_order_check` CHECK. Both copies earn
	// their keep: this one produces a readable message, the constraint is the one
	// a raw `sql` write cannot bypass.
	.refine((v) => v.endsOn >= v.startsOn, {
		message: "The window must end on or after it starts.",
		path: ["endsOn"],
	});
export type SetTrainingWindowInput = z.infer<typeof setTrainingWindowSchema>;

export const resetTrainingWindowSchema = z.object({
	...clubYear,
	period: periodSchema,
});
export type ResetTrainingWindowInput = z.infer<
	typeof resetTrainingWindowSchema
>;

export const addTrainingRecordSchema = z.object({
	...clubYear,
	membershipId: z.string().uuid(),
	position: z.enum([
		"president",
		"vp_education",
		"vp_membership",
		"vp_public_relations",
		"secretary",
		"treasurer",
		"sergeant_at_arms",
		"immediate_past_president",
	]),
	period: periodSchema,
	trainedOn: isoDateSchema.nullable().optional(),
});
export type AddTrainingRecordInput = z.infer<typeof addTrainingRecordSchema>;

export const removeTrainingRecordSchema = z.object({
	clubId: z.string().uuid(),
	recordId: z.string().uuid(),
});
export type RemoveTrainingRecordInput = z.infer<
	typeof removeTrainingRecordSchema
>;

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface TrainingRecordView {
	id: string;
	membershipId: string;
	memberName: string;
	position: OfficerPosition;
	period: TrainingPeriod;
	trainedOn: IsoDate | null;
	/**
	 * The recorded date falls outside the window of the period it claims credit
	 * for. ADVISORY: it does not change the count. Surfacing the mismatch is the
	 * point — silently voiding a club's claim would be worse, since TI is the
	 * arbiter of whether the session counted.
	 */
	outsideWindow: boolean;
	/** This office is not one of TI's seven, so the row counts toward nothing. */
	counts: boolean;
}

export interface OfficerTrainingView {
	programYear: number;
	/** The calendar date the phases and countdowns below were computed against. */
	today: IsoDate;
	/** Both periods, chronological. */
	periods: TrainingPeriodTally[];
	/** The period to lead with (first open, else first upcoming, else 2). */
	focus: TrainingPeriod;
	/** Every record for the club-year, newest date first within each period. */
	records: TrainingRecordView[];
	/** Currently-held TI-countable offices, canonical order (President first). */
	seats: OfficerSeat[];
	/** Active roster for the "record a training" picker, by name. */
	roster: { membershipId: string; name: string }[];
	/**
	 * What an Apply would write to goal 9 (0 or 1). Nothing writes it without one
	 * — ADR-0019's house style, the third assist beside the roster assist (goals
	 * 7/8) and the Pathways assist (goals 1–6, #245).
	 */
	g9Suggestion: number;
	/**
	 * Whether the club has recorded ANY training for this year. A bare
	 * `g9Suggestion: 0` is ambiguous — "recorded and genuinely short" vs "never
	 * recorded anything" — and applying the second would clear a President's
	 * hand-entered Met. So the UI only OFFERS the apply when this is true,
	 * mirroring how `pathwaysSynced` gates the education assist.
	 */
	hasRecords: boolean;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface ResolvedWindow {
	window: TrainingWindow;
	/** false → a stored row is overriding TI's dates for this club-year. */
	isDefault: boolean;
}

/**
 * Both training windows for a club-year: the stored override where one exists,
 * else TI's own dates.
 *
 * **Row absent = TI's window**, not "no window". The table is sparse on purpose
 * so a club gets a correct countdown having configured nothing, and a row only
 * appears where an admin edited the dates. A reader that treats a missing row as
 * "unknown" would show no deadline at all for the overwhelmingly common case,
 * which is the state #531 is closing.
 */
export async function loadTrainingWindows(
	clubId: string,
	programYear: number,
): Promise<ResolvedWindow[]> {
	const rows = await db
		.select({
			period: officerTrainingPeriods.period,
			startsOn: officerTrainingPeriods.startsOn,
			endsOn: officerTrainingPeriods.endsOn,
		})
		.from(officerTrainingPeriods)
		.where(
			and(
				eq(officerTrainingPeriods.clubId, clubId),
				eq(officerTrainingPeriods.programYear, programYear),
			),
		);
	const stored = new Map(rows.map((r) => [r.period, r]));
	return TRAINING_PERIODS.map((period) => {
		const row = stored.get(period);
		if (!row) {
			return {
				window: defaultTrainingWindow(programYear, period),
				isDefault: true,
			};
		}
		return {
			window: { period, startsOn: row.startsOn, endsOn: row.endsOn },
			isDefault: false,
		};
	});
}

/**
 * Store a club's own dates for one training period (an UPSERT on the sparse
 * override table). Editable because a district may deviate from TI's window, and
 * because only a real date range makes "the window shuts in three weeks" an
 * honest thing for the app to say.
 */
export async function setTrainingWindow(
	input: SetTrainingWindowInput,
): Promise<ResolvedWindow[]> {
	const now = new Date();
	await db
		.insert(officerTrainingPeriods)
		.values({
			clubId: input.clubId,
			programYear: input.programYear,
			period: input.period,
			startsOn: input.startsOn,
			endsOn: input.endsOn,
		})
		.onConflictDoUpdate({
			target: [
				officerTrainingPeriods.clubId,
				officerTrainingPeriods.programYear,
				officerTrainingPeriods.period,
			],
			set: {
				startsOn: input.startsOn,
				endsOn: input.endsOn,
				updatedAt: now,
			},
		});
	return loadTrainingWindows(input.clubId, input.programYear);
}

/**
 * Drop a club's override so the period falls back to TI's dates. The escape
 * hatch a defaults-plus-override model needs: without it a typo'd window is
 * permanent, and there is no other way to discover what TI's dates were.
 */
export async function resetTrainingWindow(
	input: ResetTrainingWindowInput,
): Promise<ResolvedWindow[]> {
	await db
		.delete(officerTrainingPeriods)
		.where(
			and(
				eq(officerTrainingPeriods.clubId, input.clubId),
				eq(officerTrainingPeriods.programYear, input.programYear),
				eq(officerTrainingPeriods.period, input.period),
			),
		);
	return loadTrainingWindows(input.clubId, input.programYear);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Every training record for a club-year, with the member's name.
 *
 * Club scoping goes through `members.club_id` — the records table carries no
 * `club_id` of its own, deliberately (a second copy is a second thing that can
 * disagree, and `officer_terms` is modelled the same way).
 *
 * NO filter on the officer's term or the member's status. A record must survive
 * its officer's term ending mid-window and the member later going inactive: the
 * club was credited for the training that happened, and deleting the credit
 * because the person moved on would silently drop the club below the bar.
 */
export async function loadTrainingRecords(
	clubId: string,
	programYear: number,
): Promise<TrainingRecordView[]> {
	const windows = await loadTrainingWindows(clubId, programYear);
	const byPeriod = new Map(windows.map((w) => [w.window.period, w.window]));

	const rows = await db
		.select({
			id: officerTrainingRecords.id,
			membershipId: officerTrainingRecords.membershipId,
			memberName: members.name,
			position: officerTrainingRecords.position,
			period: officerTrainingRecords.period,
			trainedOn: officerTrainingRecords.trainedOn,
		})
		.from(officerTrainingRecords)
		.innerJoin(members, eq(members.id, officerTrainingRecords.membershipId))
		.where(
			and(
				eq(members.clubId, clubId),
				eq(officerTrainingRecords.programYear, programYear),
			),
		)
		.orderBy(
			asc(officerTrainingRecords.period),
			asc(members.name),
			asc(officerTrainingRecords.position),
		);

	return rows.map((r) => {
		// The CHECK constraint restricts the column to 1|2; the cast states what
		// the database already guarantees rather than widening the view type.
		const period = r.period as TrainingPeriod;
		const window = byPeriod.get(period);
		return {
			id: r.id,
			membershipId: r.membershipId,
			memberName: r.memberName,
			position: r.position,
			period,
			trainedOn: r.trainedOn,
			outsideWindow: window ? isOutsideWindow(r.trainedOn, window) : false,
			counts: isTrainablePosition(r.position),
		};
	});
}

/**
 * Resolve a membership id the CLIENT supplied to its club, or null when it does
 * not exist. `requireClubRole` proves the caller administers `clubId`; it says
 * nothing about whether the id they passed belongs to that club, so every write
 * below compares this against the club it was called for.
 */
async function clubOfMembership(membershipId: string): Promise<string | null> {
	const [row] = await db
		.select({ clubId: members.clubId })
		.from(members)
		.where(eq(members.id, membershipId))
		.limit(1);
	return row?.clubId ?? null;
}

/**
 * Record that an officer was trained for an office in one of the year's two
 * periods. Idempotent on (membership, office, year, period) — a double submit
 * updates the date rather than adding a second row.
 *
 * Rejects an `immediate_past_president` record rather than storing one that
 * counts for nothing: TI lists seven elected offices and IPP is not among them,
 * and a row the club can see but the count ignores is worse than a refusal.
 */
export async function addTrainingRecord(
	input: AddTrainingRecordInput,
	recordedBy: string | null,
): Promise<{ ok: true }> {
	if (!isTrainablePosition(input.position)) {
		throw new Error(
			"Immediate Past President is not one of the seven offices Toastmasters counts for officer training.",
		);
	}
	const owner = await clubOfMembership(input.membershipId);
	if (owner !== input.clubId) {
		throw new Error("That member is not on this club's roster.");
	}
	const now = new Date();
	const trainedOn = input.trainedOn ?? null;
	await db
		.insert(officerTrainingRecords)
		.values({
			membershipId: input.membershipId,
			position: input.position,
			programYear: input.programYear,
			period: input.period,
			trainedOn,
			recordedBy,
		})
		.onConflictDoUpdate({
			target: [
				officerTrainingRecords.membershipId,
				officerTrainingRecords.position,
				officerTrainingRecords.programYear,
				officerTrainingRecords.period,
			],
			set: { trainedOn, recordedBy, updatedAt: now },
		});
	return { ok: true };
}

/**
 * Delete one training record. Scoped to the club through the membership join:
 * without that predicate a club admin holding another club's record id could
 * delete it, since the id alone carries no ownership. Returns whether a row was
 * actually removed, so a stale UI can tell "already gone" from "not yours"
 * without the seam leaking which.
 */
export async function removeTrainingRecord(
	input: RemoveTrainingRecordInput,
): Promise<{ removed: boolean }> {
	const rows = await db
		.delete(officerTrainingRecords)
		.where(
			and(
				eq(officerTrainingRecords.id, input.recordId),
				// Correlated existence check rather than a join: Postgres `DELETE`
				// takes no `USING` clause through drizzle's builder here, and this
				// keeps the club predicate inside the single statement (no
				// read-then-delete race).
				sql`exists (select 1 from ${members} where ${members.id} = ${officerTrainingRecords.membershipId} and ${members.clubId} = ${input.clubId})`,
			),
		)
		.returning({ id: officerTrainingRecords.id });
	return { removed: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Roster / seats
// ---------------------------------------------------------------------------

/**
 * The club's currently-held TI-countable offices, President first — the "who is
 * NOT trained" half of the ask.
 *
 * Open terms only (`term_end IS NULL`) and active members only, matching
 * `currentOfficersForClub`. A member who went inactive or whose term closed
 * drops off this list while their RECORD keeps counting, which is the correct
 * asymmetry: the list is a prompt about who still needs sending, the record is
 * history.
 */
export async function loadOfficerSeats(clubId: string): Promise<OfficerSeat[]> {
	const rows = await db
		.select({
			membershipId: officerTerms.membershipId,
			name: members.name,
			position: officerTerms.position,
		})
		.from(officerTerms)
		.innerJoin(members, eq(members.id, officerTerms.membershipId))
		.where(
			and(
				eq(members.clubId, clubId),
				eq(members.status, "active"),
				isNull(officerTerms.termEnd),
			),
		);
	return rows
		.filter((r) => isTrainablePosition(r.position))
		.sort(
			(a, b) =>
				officerRank(a.position) - officerRank(b.position) ||
				a.name.localeCompare(b.name),
		);
}

/** Active roster (id + name) for the record picker, by name. */
export async function loadTrainingRoster(
	clubId: string,
): Promise<{ membershipId: string; name: string }[]> {
	const rows = await db
		.select({ membershipId: members.id, name: members.name })
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(asc(members.name));
	return rows;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** The scoring inputs the pure helpers read, projected off the view rows. */
function scoringInputs(
	records: readonly TrainingRecordView[],
): TrainingRecordLike[] {
	return records.map((r) => ({
		membershipId: r.membershipId,
		position: r.position,
		period: r.period,
	}));
}

/**
 * The admin panel's whole payload for one club-year.
 *
 * `today` is a parameter so tests are deterministic AND so a caller can pass the
 * viewer's own calendar date. Defaulting to the server's local date accepts a
 * one-day skew for a club far from the server's timezone; the countdown is
 * advisory and the window bounds are club-editable, so the skew cannot change
 * whether a period is MET — only the phase label on its boundary day.
 */
export async function getOfficerTrainingView(
	input: GetOfficerTrainingInput,
	today: IsoDate = todayIso(),
): Promise<OfficerTrainingView> {
	const { clubId, programYear } = input;
	const [windows, records, seats, roster] = await Promise.all([
		loadTrainingWindows(clubId, programYear),
		loadTrainingRecords(clubId, programYear),
		loadOfficerSeats(clubId),
		loadTrainingRoster(clubId),
	]);

	const scoring = scoringInputs(records);
	const periods = windows.map((w) =>
		tallyPeriod(w.window, w.isDefault, scoring, today),
	);

	return {
		programYear,
		today,
		periods,
		focus: focusPeriod(periods),
		records,
		seats,
		roster,
		g9Suggestion: suggestG9(scoring),
		hasRecords: records.length > 0,
	};
}

/**
 * Goal 9's suggested value (0/1) for a club-year, plus whether anything is
 * recorded at all — the two facts the DCP scoreboard needs to show and offer the
 * assist. Kept separate from {@link getOfficerTrainingView} so the scoreboard
 * read does not also fetch the roster, the seats and the windows it never
 * renders.
 */
export async function deriveTrainingSuggestion(
	clubId: string,
	programYear: number,
): Promise<{
	suggestion: number;
	trainedByPeriod: number[];
	hasRecords: boolean;
}> {
	const rows = await db
		.select({
			membershipId: officerTrainingRecords.membershipId,
			position: officerTrainingRecords.position,
			period: officerTrainingRecords.period,
		})
		.from(officerTrainingRecords)
		.innerJoin(members, eq(members.id, officerTrainingRecords.membershipId))
		.where(
			and(
				eq(members.clubId, clubId),
				eq(officerTrainingRecords.programYear, programYear),
			),
		);
	const scoring: TrainingRecordLike[] = rows.map((r) => ({
		membershipId: r.membershipId,
		position: r.position,
		period: r.period as TrainingPeriod,
	}));
	return {
		suggestion: suggestG9(scoring),
		// The SAME pure helper the panel's tallies use — not a second de-dup
		// written here. Re-deriving "distinct people" locally is how the badge on
		// the scoreboard and the numbers in the panel would come to disagree, with
		// every gate green; `countTrainedOfficers` is the one place that rule lives.
		trainedByPeriod: TRAINING_PERIODS.map((p) =>
			countTrainedOfficers(scoring, p),
		),
		hasRecords: rows.length > 0,
	};
}
