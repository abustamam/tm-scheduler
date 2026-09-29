// The charter dashboard (#943): a CHARTERING club's paid members against its
// target, its charter checklist, and its sponsors and club mentors. Split out
// from the `createServerFn` wrappers in `charter.ts` so it is directly
// integration-testable and its `db` import never reaches the client bundle
// (see the header of `members-logic.ts`).
//
// The callers enforce authorization: reads need admin view of the club, every
// write needs the admin club role. Nothing here encodes Toastmasters
// International's charter rules — the target and the checklist are the club's
// own, and every write is refused once the club has chartered (the rows are
// kept; the dashboard is hidden).
//
// READS NEVER WRITE. A read admits a read-only impersonation session and runs
// on every officer-home load, so a club with no charter row is answered from
// defaults in memory (`started: false`). The row and the seeded checklist are
// created by the first WRITE (`beginWrite`), which only an admin-gated server
// fn reaches.
import { and, asc, count, eq, max } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	clubCharter,
	clubCharterHelpers,
	clubCharterSteps,
	clubs,
	duesPeriods,
	members,
	people,
} from "#/db/schema";
import {
	CHARTER_HELPER_FIELD_MAX,
	CHARTER_HELPER_ROLES,
	CHARTER_HELPERS_MAX,
	CHARTER_STEP_LABEL_MAX,
	CHARTER_STEPS_MAX,
	type CharterHelperRole,
	DEFAULT_MEMBERS_NEEDED,
	MEMBERS_NEEDED_MAX,
	MEMBERS_NEEDED_MIN,
	SEEDED_CHARTER_STEPS,
} from "#/lib/charter-dashboard";
import { isCalendarDate, latestCharterDate } from "#/lib/club-charter";
import { getDuesForPeriod } from "./dues-logic";

export interface CharterStep {
	id: string;
	label: string;
	position: number;
	/** `YYYY-MM-DD`, or null while the step is not done. */
	doneAt: string | null;
}

export interface CharterHelper {
	id: string;
	role: CharterHelperRole;
	/** The linked Person, or null for a free-text contact. */
	personId: string | null;
	/** The linked Person's name when there is one, else the free-text name. */
	name: string;
	email: string | null;
	phone: string | null;
	homeClub: string | null;
}

export interface CharterDuesPeriodOption {
	id: string;
	label: string;
}

/** Someone on this club's active roster, offered as a helper to link. */
export interface CharterPersonOption {
	personId: string;
	name: string;
}

export interface CharterDashboard {
	/**
	 * False until the club's first charter write: the target, period and steps
	 * are then DEFAULTS, not rows, and the steps' ids are placeholders no write
	 * accepts. The checklist is started by `startCharterChecklist` (or by any
	 * other write), which seeds the same steps for real.
	 */
	started: boolean;
	membersNeeded: number;
	/** The dues period whose paid members count, or null when none is picked. */
	duesPeriodId: string | null;
	/** Members marked PAID in `duesPeriodId`; 0 when no period is picked. */
	paidCount: number;
	periods: CharterDuesPeriodOption[];
	steps: CharterStep[];
	helpers: CharterHelper[];
	people: CharterPersonOption[];
}

/** The officer home's card: the dashboard in four numbers. */
export interface CharterSummary {
	membersNeeded: number;
	paidCount: number;
	periodPicked: boolean;
	stepsDone: number;
	stepsTotal: number;
}

export const CLUB_CHARTERED_MESSAGE =
	"This club has chartered, so its charter dashboard is closed.";
export const DUES_PERIOD_NOT_IN_CLUB_MESSAGE =
	"That dues period isn't one of this club's.";
export const STEP_NOT_FOUND_MESSAGE = "That checklist step no longer exists.";
export const HELPER_NOT_FOUND_MESSAGE = "That helper no longer exists.";
export const REORDER_MISMATCH_MESSAGE =
	"The checklist changed while you were reordering it. Reload and try again.";
export const PERSON_NOT_IN_CLUB_MESSAGE =
	"Only someone on this club's roster can be linked. Enter an outside helper's name instead.";
export const HELPER_IDENTITY_MESSAGE =
	"Pick someone from the roster or enter a name.";
export const DONE_DATE_INVALID_MESSAGE =
	"Enter the done date as a real calendar date.";
export const DONE_DATE_FUTURE_MESSAGE = "The done date can't be in the future.";
export const STEPS_FULL_MESSAGE = `A checklist holds at most ${CHARTER_STEPS_MAX} steps. Remove one first.`;
export const HELPERS_FULL_MESSAGE = `You can record at most ${CHARTER_HELPERS_MAX} sponsors and club mentors. Remove one first.`;
export const LINKED_NAME_BLANK_MESSAGE =
	"That roster entry has no name. Add one on the roster, or enter the helper as an outside contact.";
export const TARGET_EMPTY_MESSAGE = "Nothing to save.";

/** Whether the club is chartering. Throws when the club does not exist. */
async function isChartering(clubId: string): Promise<boolean> {
	const [row] = await db
		.select({ charterStatus: clubs.charterStatus })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!row) throw new Error("Club not found.");
	return row.charterStatus === "chartering";
}

/**
 * The first line of every write: refuse a chartered club, then make sure the
 * charter row and the seeded checklist exist. Writes are the only place rows
 * are created (see the header).
 */
async function beginWrite(clubId: string): Promise<void> {
	if (!(await isChartering(clubId))) throw new Error(CLUB_CHARTERED_MESSAGE);
	await ensureCharter(clubId);
}

/**
 * Create the club's charter row, and seed its checklist, the first time a
 * write needs it. Never called on a read path. The seed runs only when THIS call inserted the row, so two first
 * visits at once seed one checklist, not two.
 */
export async function ensureCharter(clubId: string): Promise<void> {
	await db.transaction(async (tx) => {
		const inserted = await tx
			.insert(clubCharter)
			.values({ clubId })
			.onConflictDoNothing()
			.returning({ clubId: clubCharter.clubId });
		if (inserted.length === 0) return;
		await tx.insert(clubCharterSteps).values(
			SEEDED_CHARTER_STEPS.map((label, position) => ({
				clubId,
				label,
				position,
			})),
		);
	});
}

/**
 * The club's charter dashboard, or null once the club has chartered (the rows
 * are kept, the dashboard is hidden). Side-effect free: a club with no charter
 * row yet gets the defaults, unpersisted.
 */
export async function getCharterDashboard(
	clubId: string,
): Promise<CharterDashboard | null> {
	if (!(await isChartering(clubId))) return null;

	const [row] = await db
		.select({
			membersNeeded: clubCharter.membersNeeded,
			duesPeriodId: clubCharter.duesPeriodId,
		})
		.from(clubCharter)
		.where(eq(clubCharter.clubId, clubId))
		.limit(1);
	const started = row !== undefined;
	const charter = row ?? {
		membersNeeded: DEFAULT_MEMBERS_NEEDED,
		duesPeriodId: null,
	};

	// "Paid" is the dues tracker's own count for the period, not a restatement.
	const paidCount = charter.duesPeriodId
		? (await getDuesForPeriod(clubId, charter.duesPeriodId)).totals.paid
		: 0;

	const periods = await db
		.select({ id: duesPeriods.id, label: duesPeriods.label })
		.from(duesPeriods)
		.where(eq(duesPeriods.clubId, clubId))
		.orderBy(asc(duesPeriods.dueDate));

	const persistedSteps = await db
		.select({
			id: clubCharterSteps.id,
			label: clubCharterSteps.label,
			position: clubCharterSteps.position,
			doneAt: clubCharterSteps.doneAt,
		})
		.from(clubCharterSteps)
		.where(eq(clubCharterSteps.clubId, clubId))
		.orderBy(
			asc(clubCharterSteps.position),
			asc(clubCharterSteps.createdAt),
			asc(clubCharterSteps.id),
		);
	const steps: CharterStep[] = started
		? persistedSteps
		: SEEDED_CHARTER_STEPS.map((label, position) => ({
				id: `default-${position}`,
				label,
				position,
				doneAt: null,
			}));

	const helperRows = await db
		.select({
			id: clubCharterHelpers.id,
			role: clubCharterHelpers.role,
			personId: clubCharterHelpers.personId,
			personName: people.name,
			name: clubCharterHelpers.name,
			email: clubCharterHelpers.email,
			phone: clubCharterHelpers.phone,
			homeClub: clubCharterHelpers.homeClub,
		})
		.from(clubCharterHelpers)
		.leftJoin(people, eq(people.id, clubCharterHelpers.personId))
		.where(eq(clubCharterHelpers.clubId, clubId))
		.orderBy(asc(clubCharterHelpers.role), asc(clubCharterHelpers.createdAt));
	const helpers: CharterHelper[] = helperRows.map((h) => ({
		id: h.id,
		role: h.role,
		personId: h.personId,
		// The club's own snapshot first: a membership's name is authoritative for
		// its club (#486), and `people.name` is only the fallback.
		name: h.name ?? h.personName ?? "",
		email: h.email,
		phone: h.phone,
		homeClub: h.homeClub,
	}));

	return {
		started,
		membersNeeded: charter.membersNeeded,
		duesPeriodId: charter.duesPeriodId,
		paidCount,
		periods,
		steps,
		helpers,
		people: await listRosterPeople(clubId),
	};
}

/** The officer home card's numbers, or null once the club has chartered. */
export async function getCharterSummary(
	clubId: string,
): Promise<CharterSummary | null> {
	const dashboard = await getCharterDashboard(clubId);
	if (!dashboard) return null;
	return {
		membersNeeded: dashboard.membersNeeded,
		paidCount: dashboard.paidCount,
		periodPicked: dashboard.duesPeriodId !== null,
		stepsDone: dashboard.steps.filter((s) => s.doneAt !== null).length,
		stepsTotal: dashboard.steps.length,
	};
}

/** The club's active roster, one row per Person, by name. */
async function listRosterPeople(
	clubId: string,
): Promise<CharterPersonOption[]> {
	const rows = await db
		.select({ personId: members.personId, name: members.name })
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(asc(members.name));
	const seen = new Set<string>();
	return rows.filter((r) =>
		seen.has(r.personId) ? false : (seen.add(r.personId), true),
	);
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/** Each field is optional and only a field that is SENT is written, so a tab
 *  saving one field cannot revert the other to what it loaded. */
export const updateCharterTargetSchema = z
	.object({
		clubId: z.string().uuid(),
		membersNeeded: z
			.number()
			.int()
			.min(MEMBERS_NEEDED_MIN)
			.max(MEMBERS_NEEDED_MAX)
			.optional(),
		/** A period id, null to clear the pick, or absent to leave it alone. */
		duesPeriodId: z.string().uuid().nullable().optional(),
	})
	.refine(
		(v) => v.membersNeeded !== undefined || v.duesPeriodId !== undefined,
		{
			message: TARGET_EMPTY_MESSAGE,
		},
	);
export type UpdateCharterTargetInput = z.output<
	typeof updateCharterTargetSchema
>;

/** Set the members target and the dues period whose paid members count. */
export async function updateCharterTarget(
	input: UpdateCharterTargetInput,
): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	if (input.duesPeriodId) {
		const [period] = await db
			.select({ id: duesPeriods.id })
			.from(duesPeriods)
			.where(
				and(
					eq(duesPeriods.id, input.duesPeriodId),
					eq(duesPeriods.clubId, input.clubId),
				),
			)
			.limit(1);
		if (!period) throw new Error(DUES_PERIOD_NOT_IN_CLUB_MESSAGE);
	}
	await db
		.update(clubCharter)
		.set({
			...(input.membersNeeded !== undefined
				? { membersNeeded: input.membersNeeded }
				: {}),
			...(input.duesPeriodId !== undefined
				? { duesPeriodId: input.duesPeriodId }
				: {}),
			updatedAt: new Date(),
		})
		.where(eq(clubCharter.clubId, input.clubId));
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export const startCharterChecklistSchema = z.object({
	clubId: z.string().uuid(),
});

/** Persist the default target and the seeded checklist, so its steps can be
 *  edited. Idempotent: a club already started is left as it is. */
export async function startCharterChecklist(input: {
	clubId: string;
}): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	return { ok: true };
}

const stepLabel = z
	.string()
	.trim()
	.min(1, "A step needs a name.")
	.max(CHARTER_STEP_LABEL_MAX);

export const addCharterStepSchema = z.object({
	clubId: z.string().uuid(),
	label: stepLabel,
});
export type AddCharterStepInput = z.output<typeof addCharterStepSchema>;

/** Add a step at the end of the checklist. */
export async function addCharterStep(
	input: AddCharterStepInput,
): Promise<{ id: string }> {
	await beginWrite(input.clubId);
	const [{ steps } = { steps: 0 }] = await db
		.select({ steps: count() })
		.from(clubCharterSteps)
		.where(eq(clubCharterSteps.clubId, input.clubId));
	if (steps >= CHARTER_STEPS_MAX) throw new Error(STEPS_FULL_MESSAGE);
	const [last] = await db
		.select({ position: max(clubCharterSteps.position) })
		.from(clubCharterSteps)
		.where(eq(clubCharterSteps.clubId, input.clubId));
	const [row] = await db
		.insert(clubCharterSteps)
		.values({
			clubId: input.clubId,
			label: input.label,
			position: (last?.position ?? -1) + 1,
		})
		.returning({ id: clubCharterSteps.id });
	if (!row) throw new Error("The step could not be added.");
	return { id: row.id };
}

export const renameCharterStepSchema = z.object({
	clubId: z.string().uuid(),
	stepId: z.string().uuid(),
	label: stepLabel,
});
export type RenameCharterStepInput = z.output<typeof renameCharterStepSchema>;

export async function renameCharterStep(
	input: RenameCharterStepInput,
): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	const updated = await db
		.update(clubCharterSteps)
		.set({ label: input.label })
		.where(
			and(
				eq(clubCharterSteps.id, input.stepId),
				eq(clubCharterSteps.clubId, input.clubId),
			),
		)
		.returning({ id: clubCharterSteps.id });
	if (updated.length === 0) throw new Error(STEP_NOT_FOUND_MESSAGE);
	return { ok: true };
}

export const setCharterStepDoneSchema = z.object({
	clubId: z.string().uuid(),
	stepId: z.string().uuid(),
	/** `YYYY-MM-DD` to mark the step done on that day; null to un-mark it. */
	doneAt: z
		.string()
		.trim()
		.refine(isCalendarDate, { message: DONE_DATE_INVALID_MESSAGE })
		.refine((v) => v <= latestCharterDate(), {
			message: DONE_DATE_FUTURE_MESSAGE,
		})
		.nullable(),
});
export type SetCharterStepDoneInput = z.output<typeof setCharterStepDoneSchema>;

export async function setCharterStepDone(
	input: SetCharterStepDoneInput,
): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	const updated = await db
		.update(clubCharterSteps)
		.set({ doneAt: input.doneAt })
		.where(
			and(
				eq(clubCharterSteps.id, input.stepId),
				eq(clubCharterSteps.clubId, input.clubId),
			),
		)
		.returning({ id: clubCharterSteps.id });
	if (updated.length === 0) throw new Error(STEP_NOT_FOUND_MESSAGE);
	return { ok: true };
}

export const removeCharterStepSchema = z.object({
	clubId: z.string().uuid(),
	stepId: z.string().uuid(),
});
export type RemoveCharterStepInput = z.output<typeof removeCharterStepSchema>;

export async function removeCharterStep(
	input: RemoveCharterStepInput,
): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	const deleted = await db
		.delete(clubCharterSteps)
		.where(
			and(
				eq(clubCharterSteps.id, input.stepId),
				eq(clubCharterSteps.clubId, input.clubId),
			),
		)
		.returning({ id: clubCharterSteps.id });
	if (deleted.length === 0) throw new Error(STEP_NOT_FOUND_MESSAGE);
	return { ok: true };
}

export const reorderCharterStepsSchema = z.object({
	clubId: z.string().uuid(),
	/** Every one of the club's step ids, in the new order. */
	stepIds: z.array(z.string().uuid()).max(CHARTER_STEPS_MAX),
});
export type ReorderCharterStepsInput = z.output<
	typeof reorderCharterStepsSchema
>;

/**
 * Put the checklist in the order given. Accepted only as an exact permutation
 * of the club's steps: a step added or removed in another tab since this one
 * loaded is refused rather than silently dropped or left out of order.
 */
export async function reorderCharterSteps(
	input: ReorderCharterStepsInput,
): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	await db.transaction(async (tx) => {
		const current = await tx
			.select({ id: clubCharterSteps.id })
			.from(clubCharterSteps)
			.where(eq(clubCharterSteps.clubId, input.clubId))
			.for("update");
		const wanted = new Set(input.stepIds);
		if (
			wanted.size !== input.stepIds.length ||
			wanted.size !== current.length ||
			current.some((s) => !wanted.has(s.id))
		) {
			throw new Error(REORDER_MISMATCH_MESSAGE);
		}
		for (const [position, id] of input.stepIds.entries()) {
			await tx
				.update(clubCharterSteps)
				.set({ position })
				.where(
					and(
						eq(clubCharterSteps.id, id),
						eq(clubCharterSteps.clubId, input.clubId),
					),
				);
		}
	});
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Sponsors and club mentors
// ---------------------------------------------------------------------------

const helperText = z
	.string()
	.trim()
	.max(CHARTER_HELPER_FIELD_MAX)
	.nullish()
	.transform((v) => (v ? v : null));

export const addCharterHelperSchema = z
	.object({
		clubId: z.string().uuid(),
		role: z.enum(CHARTER_HELPER_ROLES),
		/** A Person on this club's roster, or null for an outside helper. */
		personId: z.string().uuid().nullish().default(null),
		name: helperText,
		email: helperText.pipe(z.email("Enter a valid email address.").nullable()),
		phone: helperText,
		homeClub: helperText,
	})
	.superRefine((v, ctx) => {
		if (!v.personId && !v.name) {
			ctx.addIssue({
				code: "custom",
				path: ["name"],
				message: HELPER_IDENTITY_MESSAGE,
			});
		}
	});
export type AddCharterHelperInput = z.output<typeof addCharterHelperSchema>;

/**
 * Record a sponsor or club mentor: a Person on this club's roster (who may
 * also be a member or officer here), or a free-text outside contact.
 *
 * A linked Person must hold a membership in THIS club, so an admin cannot
 * link — and so read the name of — an arbitrary Person by id. The name is
 * snapshotted onto the row either way, so a Person later merged away or
 * deleted (`ON DELETE SET NULL`) leaves a named contact, not a nameless one.
 */
export async function addCharterHelper(
	input: AddCharterHelperInput,
): Promise<{ id: string }> {
	await beginWrite(input.clubId);
	const [{ helpers } = { helpers: 0 }] = await db
		.select({ helpers: count() })
		.from(clubCharterHelpers)
		.where(eq(clubCharterHelpers.clubId, input.clubId));
	if (helpers >= CHARTER_HELPERS_MAX) throw new Error(HELPERS_FULL_MESSAGE);
	let name = input.name;
	if (input.personId) {
		const [membership] = await db
			.select({ name: members.name })
			.from(members)
			.where(
				and(
					eq(members.clubId, input.clubId),
					eq(members.personId, input.personId),
				),
			)
			.limit(1);
		if (!membership) throw new Error(PERSON_NOT_IN_CLUB_MESSAGE);
		// Trimmed, and refused when blank: the snapshot is what survives the
		// Person (ON DELETE SET NULL), and a blank one would fail the identity
		// CHECK there — turning a Person delete or merge into an error.
		name = name ?? membership.name.trim();
		if (!name) throw new Error(LINKED_NAME_BLANK_MESSAGE);
	}
	const [row] = await db
		.insert(clubCharterHelpers)
		.values({
			clubId: input.clubId,
			role: input.role,
			personId: input.personId ?? null,
			name,
			email: input.email,
			phone: input.phone,
			homeClub: input.homeClub,
		})
		.returning({ id: clubCharterHelpers.id });
	if (!row) throw new Error("The helper could not be added.");
	return { id: row.id };
}

export const removeCharterHelperSchema = z.object({
	clubId: z.string().uuid(),
	helperId: z.string().uuid(),
});
export type RemoveCharterHelperInput = z.output<
	typeof removeCharterHelperSchema
>;

export async function removeCharterHelper(
	input: RemoveCharterHelperInput,
): Promise<{ ok: true }> {
	await beginWrite(input.clubId);
	const deleted = await db
		.delete(clubCharterHelpers)
		.where(
			and(
				eq(clubCharterHelpers.id, input.helperId),
				eq(clubCharterHelpers.clubId, input.clubId),
			),
		)
		.returning({ id: clubCharterHelpers.id });
	if (deleted.length === 0) throw new Error(HELPER_NOT_FOUND_MESSAGE);
	return { ok: true };
}
