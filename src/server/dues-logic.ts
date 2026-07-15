// Treasurer membership-dues DB logic (#206), split out from the `createServerFn`
// wrappers in `dues.ts`. These are plain, directly integration-testable
// functions; they MUST live here (not in the server-fn module) because `dues.ts`
// is imported by a client route — the Start compiler strips the createServerFn
// handler bodies (and their `db` imports) from the client bundle, but a plain
// db-touching export sitting in that same module is NOT stripped and drags `pg`
// → `Buffer` into the browser. See `members-logic.ts` / the server-modules guard.
//
// Every read here is DERIVED, not stored: per-member status for a period and the
// overdue set are computed from active `members` LEFT JOINed to the sparse
// `member_dues` table where a row exists only for paid/waived. No dues action
// ever writes `members.status` — dues and roster renewal stay decoupled.
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { duesPeriods, memberDues, members } from "#/db/schema";
import { selectActivePeriodId } from "#/lib/dues";

export type DuesStatus = "paid" | "waived";

export interface DuesPeriod {
	id: string;
	clubId: string;
	label: string;
	dueDate: Date;
	defaultAmountCents: number | null;
}

/** One active member's dues status for a selected period; `status: null` = the
 *  member has no row for the period, i.e. unpaid. */
export interface MemberDuesRow {
	membershipId: string;
	name: string;
	joinedAt: Date | null;
	status: DuesStatus | null;
	amountCents: number | null;
	paidAt: Date | null;
}

export interface DuesTotals {
	paid: number;
	waived: number;
	unpaid: number;
	/** Summed `amount_cents` across paid rows (waivers collect nothing). */
	collectedCents: number;
}

export interface OverduePeriodRef {
	periodId: string;
	label: string;
	dueDate: Date;
}

/** An active member who owes at least one past-due period (no paid/waived row). */
export interface OverdueDuesRow {
	membershipId: string;
	name: string;
	joinedAt: Date | null;
	owedPeriods: OverduePeriodRef[];
}

/** A drizzle transaction handle (the arg the `db.transaction` callback gets). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All dues periods for a club, oldest due-date first. */
export async function listDuesPeriods(clubId: string): Promise<DuesPeriod[]> {
	return db
		.select({
			id: duesPeriods.id,
			clubId: duesPeriods.clubId,
			label: duesPeriods.label,
			dueDate: duesPeriods.dueDate,
			defaultAmountCents: duesPeriods.defaultAmountCents,
		})
		.from(duesPeriods)
		.where(eq(duesPeriods.clubId, clubId))
		.orderBy(asc(duesPeriods.dueDate));
}

/** The loader-friendly overview: every period, the default-selected (active)
 *  period, and the overdue set (all derived; no writes). */
export async function getDuesOverview(clubId: string): Promise<{
	periods: DuesPeriod[];
	activePeriodId: string | null;
	overdue: OverdueDuesRow[];
}> {
	const periods = await listDuesPeriods(clubId);
	const activePeriodId = selectActivePeriodId(periods);
	const overdue = await getOverdueDues(clubId);
	return { periods, activePeriodId, overdue };
}

/** Per-member status for one period plus the period totals. Active members only
 *  (inactive members are out of scope for the dues report). */
export async function getDuesForPeriod(
	clubId: string,
	periodId: string,
): Promise<{ rows: MemberDuesRow[]; totals: DuesTotals }> {
	await assertPeriodInClub(clubId, periodId);

	const rows = await db
		.select({
			membershipId: members.id,
			name: members.name,
			joinedAt: members.joinedAt,
			status: memberDues.status,
			amountCents: memberDues.amountCents,
			paidAt: memberDues.paidAt,
		})
		.from(members)
		// LEFT JOIN keyed on BOTH the member and the selected period so a member
		// with no row for this period yields status = null (unpaid).
		.leftJoin(
			memberDues,
			and(
				eq(memberDues.membershipId, members.id),
				eq(memberDues.duesPeriodId, periodId),
			),
		)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(asc(members.name));

	const totals: DuesTotals = {
		paid: 0,
		waived: 0,
		unpaid: 0,
		collectedCents: 0,
	};
	for (const r of rows) {
		if (r.status === "paid") {
			totals.paid += 1;
			totals.collectedCents += r.amountCents ?? 0;
		} else if (r.status === "waived") {
			totals.waived += 1;
		} else {
			totals.unpaid += 1;
		}
	}
	return { rows, totals };
}

/**
 * Overdue = every active member who has NO paid/waived row for at least one
 * period whose `due_date` has already passed. Full-year payers are excluded for
 * free: their up-front payment writes a `paid` row for BOTH the current and the
 * next period, so both are "covered" and never counted as owed. Returns one row
 * per overdue member with the specific past-due periods they still owe.
 */
export async function getOverdueDues(
	clubId: string,
	now: Date = new Date(),
): Promise<OverdueDuesRow[]> {
	const pastDue = await db
		.select({
			id: duesPeriods.id,
			label: duesPeriods.label,
			dueDate: duesPeriods.dueDate,
		})
		.from(duesPeriods)
		.where(and(eq(duesPeriods.clubId, clubId), lt(duesPeriods.dueDate, now)))
		.orderBy(asc(duesPeriods.dueDate));
	if (pastDue.length === 0) return [];

	const activeMembers = await db
		.select({
			id: members.id,
			name: members.name,
			joinedAt: members.joinedAt,
		})
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(asc(members.name));
	if (activeMembers.length === 0) return [];

	// Every (member, period) pair that is covered by a paid OR waived row.
	const covered = await db
		.select({
			membershipId: memberDues.membershipId,
			duesPeriodId: memberDues.duesPeriodId,
		})
		.from(memberDues)
		.where(
			inArray(
				memberDues.duesPeriodId,
				pastDue.map((p) => p.id),
			),
		);
	const coveredSet = new Set(
		covered.map((c) => `${c.membershipId}:${c.duesPeriodId}`),
	);

	const result: OverdueDuesRow[] = [];
	for (const m of activeMembers) {
		const owedPeriods = pastDue
			.filter((p) => !coveredSet.has(`${m.id}:${p.id}`))
			.map((p) => ({ periodId: p.id, label: p.label, dueDate: p.dueDate }));
		if (owedPeriods.length > 0) {
			result.push({
				membershipId: m.id,
				name: m.name,
				joinedAt: m.joinedAt,
				owedPeriods,
			});
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Guards (club-scoping — defense in depth; wrappers also require club admin)
// ---------------------------------------------------------------------------

async function assertPeriodInClub(
	clubId: string,
	periodId: string,
): Promise<{ id: string; dueDate: Date }> {
	const [period] = await db
		.select({ id: duesPeriods.id, dueDate: duesPeriods.dueDate })
		.from(duesPeriods)
		.where(and(eq(duesPeriods.id, periodId), eq(duesPeriods.clubId, clubId)))
		.limit(1);
	if (!period) throw new Error("Dues period not found in this club.");
	return period;
}

async function assertMemberInClub(
	clubId: string,
	membershipId: string,
): Promise<void> {
	const [row] = await db
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.id, membershipId), eq(members.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error("Member not found in this club.");
}

/** The next period after `periodId` by due-date (same club), or null. */
async function findNextPeriod(
	clubId: string,
	current: { dueDate: Date },
): Promise<{ id: string } | null> {
	const [next] = await db
		.select({ id: duesPeriods.id })
		.from(duesPeriods)
		.where(
			and(
				eq(duesPeriods.clubId, clubId),
				gt(duesPeriods.dueDate, current.dueDate),
			),
		)
		.orderBy(asc(duesPeriods.dueDate))
		.limit(1);
	return next ?? null;
}

/** Insert-or-update the single member_dues row for a (member, period) pair. */
async function upsertDuesRow(
	values: {
		membershipId: string;
		duesPeriodId: string;
		status: DuesStatus;
		amountCents: number | null;
		paidAt: Date | null;
	},
	conn: typeof db | Tx = db,
): Promise<void> {
	await conn
		.insert(memberDues)
		.values(values)
		.onConflictDoUpdate({
			target: [memberDues.membershipId, memberDues.duesPeriodId],
			set: {
				status: values.status,
				amountCents: values.amountCents,
				paidAt: values.paidAt,
			},
		});
}

// ---------------------------------------------------------------------------
// Period CRUD
// ---------------------------------------------------------------------------

export const createDuesPeriodSchema = z.object({
	clubId: z.string().uuid(),
	label: z.string().trim().min(1),
	dueDate: z.coerce.date(),
	defaultAmountCents: z.number().int().nonnegative().nullable().optional(),
});
export type CreateDuesPeriodInput = z.infer<typeof createDuesPeriodSchema>;

export async function createDuesPeriod(
	input: CreateDuesPeriodInput,
): Promise<{ id: string }> {
	const [row] = await db
		.insert(duesPeriods)
		.values({
			clubId: input.clubId,
			label: input.label,
			dueDate: input.dueDate,
			defaultAmountCents: input.defaultAmountCents ?? null,
		})
		.returning({ id: duesPeriods.id });
	if (!row) throw new Error("Failed to create dues period.");
	return { id: row.id };
}

export const updateDuesPeriodSchema = z.object({
	clubId: z.string().uuid(),
	periodId: z.string().uuid(),
	label: z.string().trim().min(1),
	dueDate: z.coerce.date(),
	defaultAmountCents: z.number().int().nonnegative().nullable().optional(),
});
export type UpdateDuesPeriodInput = z.infer<typeof updateDuesPeriodSchema>;

export async function updateDuesPeriod(
	input: UpdateDuesPeriodInput,
): Promise<{ ok: true }> {
	await assertPeriodInClub(input.clubId, input.periodId);
	await db
		.update(duesPeriods)
		.set({
			label: input.label,
			dueDate: input.dueDate,
			defaultAmountCents: input.defaultAmountCents ?? null,
		})
		.where(eq(duesPeriods.id, input.periodId));
	return { ok: true };
}

export const deleteDuesPeriodSchema = z.object({
	clubId: z.string().uuid(),
	periodId: z.string().uuid(),
});
export type DeleteDuesPeriodInput = z.infer<typeof deleteDuesPeriodSchema>;

export async function deleteDuesPeriod(
	input: DeleteDuesPeriodInput,
): Promise<{ ok: true }> {
	await assertPeriodInClub(input.clubId, input.periodId);
	// member_dues rows cascade on the FK.
	await db.delete(duesPeriods).where(eq(duesPeriods.id, input.periodId));
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Dues actions (record / waive / undo)
// ---------------------------------------------------------------------------

export const recordPaymentSchema = z.object({
	clubId: z.string().uuid(),
	periodId: z.string().uuid(),
	membershipId: z.string().uuid(),
	amountCents: z.number().int().nonnegative().nullable().optional(),
	// Full-year pre-payment: also write a `paid` row for the NEXT period, sharing
	// one paid_at. `nextAmountCents` optionally splits the amount onto that row.
	fullYear: z.boolean().optional(),
	nextAmountCents: z.number().int().nonnegative().nullable().optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * Record a payment for a member. A single-period payment writes one `paid` row.
 * A full-year pre-payment writes TWO `paid` rows — this period AND the next
 * period by due-date — sharing one `paid_at`, in a single transaction. Throws if
 * there is no next period to pre-pay (periods are Treasurer-managed data — create
 * the following period first).
 */
export async function recordDuesPayment(
	input: RecordPaymentInput,
): Promise<{ ok: true; rowsWritten: number; nextPeriodId?: string }> {
	const period = await assertPeriodInClub(input.clubId, input.periodId);
	await assertMemberInClub(input.clubId, input.membershipId);
	const paidAt = new Date();

	if (!input.fullYear) {
		await upsertDuesRow({
			membershipId: input.membershipId,
			duesPeriodId: input.periodId,
			status: "paid",
			amountCents: input.amountCents ?? null,
			paidAt,
		});
		return { ok: true, rowsWritten: 1 };
	}

	const next = await findNextPeriod(input.clubId, period);
	if (!next) {
		throw new Error(
			"There's no next dues period to pre-pay — create the following period first.",
		);
	}
	await db.transaction(async (tx) => {
		await upsertDuesRow(
			{
				membershipId: input.membershipId,
				duesPeriodId: input.periodId,
				status: "paid",
				amountCents: input.amountCents ?? null,
				paidAt,
			},
			tx,
		);
		await upsertDuesRow(
			{
				membershipId: input.membershipId,
				duesPeriodId: next.id,
				status: "paid",
				amountCents: input.nextAmountCents ?? null,
				paidAt,
			},
			tx,
		);
	});
	return { ok: true, rowsWritten: 2, nextPeriodId: next.id };
}

export const waiveSchema = z.object({
	clubId: z.string().uuid(),
	periodId: z.string().uuid(),
	membershipId: z.string().uuid(),
});
export type WaiveInput = z.infer<typeof waiveSchema>;

/** Waive a member's dues for a period (writes/overwrites a `waived` row). */
export async function waiveDues(input: WaiveInput): Promise<{ ok: true }> {
	await assertPeriodInClub(input.clubId, input.periodId);
	await assertMemberInClub(input.clubId, input.membershipId);
	await upsertDuesRow({
		membershipId: input.membershipId,
		duesPeriodId: input.periodId,
		status: "waived",
		amountCents: null,
		paidAt: null,
	});
	return { ok: true };
}

export const undoSchema = z.object({
	clubId: z.string().uuid(),
	periodId: z.string().uuid(),
	membershipId: z.string().uuid(),
});
export type UndoInput = z.infer<typeof undoSchema>;

/** Remove a member's dues row for a period → they revert to unpaid (no row). */
export async function undoDues(input: UndoInput): Promise<{ ok: true }> {
	await assertPeriodInClub(input.clubId, input.periodId);
	await db
		.delete(memberDues)
		.where(
			and(
				eq(memberDues.membershipId, input.membershipId),
				eq(memberDues.duesPeriodId, input.periodId),
			),
		);
	return { ok: true };
}
