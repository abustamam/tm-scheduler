/**
 * DB-backed integration tests for Club Officer Training — the record behind DCP
 * goal 9 (#531): the sparse window override, the distinct-PEOPLE count, the
 * seat list, both write paths' club scoping, and the goal-9 suggestion the
 * President applies.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; skipped when
 * unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test_531 \
 *     bunx vitest run src/server/officer-training.integration.test.ts
 *
 * ## The fixture matrix, and why it is shaped this way
 *
 * CLAUDE.md's trap: a fixture spanning ONE axis is not a guarantee. The counting
 * rule here is "distinct people", so the cases where that DIVERGES from the
 * obvious reading are the ones worth building, and each of the three below is a
 * separate mechanism rather than a variation:
 *
 * 1. **A member holding two offices.** Distinct-offices says 4, distinct-people
 *    says 3. Every all-single-office fixture passes under either rule.
 * 2. **An officer whose term ended mid-window.** Their record must keep
 *    counting (the club WAS credited) while their seat leaves the "who still
 *    needs sending" list. A fixture with only open terms cannot tell a correct
 *    read from one that joins on `term_end IS NULL`.
 * 3. **A record dated outside both windows.** It must be FLAGGED and still
 *    COUNT. A fixture with only in-window dates passes whether the flag exists,
 *    is inverted, or silently voids the row.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	members,
	officerTerms,
	officerTrainingPeriods,
	officerTrainingRecords,
} from "#/db/schema";
import type { OfficerPosition } from "#/lib/officers";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import {
	applyTrainingSuggestion,
	getScoreboard,
	startScoreboard,
	updateGoal,
} from "./dcp-logic";
import {
	addTrainingRecord,
	getOfficerTrainingView,
	loadOfficerSeats,
	loadTrainingRecords,
	loadTrainingWindows,
	removeTrainingRecord,
	resetTrainingWindow,
	setTrainingWindow,
} from "./officer-training-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const PY = 2026;
/** Inside period 1 of program year 2026 (Jun 1 – Aug 31 2026). */
const IN_P1 = "2026-07-14";
/** Inside period 2 of program year 2026 (Nov 1 2026 – Feb 28 2027). */
const IN_P2 = "2026-12-03";
/** Inside NEITHER window — the September gap between the two. */
const IN_NEITHER = "2026-09-20";

async function addMember(
	clubId: string,
	name: string,
	opts: { status?: "active" | "inactive" } = {},
): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name,
			clubRole: "member",
			status: opts.status ?? "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

/**
 * The name of the Postgres constraint a failing write violated, or null when it
 * succeeded. node-postgres puts the name on `error.constraint`; drizzle wraps
 * the error and its own `message` is the failing SQL, so the name is only
 * reachable through the cause chain — which is why every CHECK assertion here
 * goes through this rather than matching the message.
 */
async function violatedConstraint(
	work: Promise<unknown>,
): Promise<string | null> {
	try {
		await work;
		return null;
	} catch (err) {
		for (
			let e: unknown = err;
			e != null;
			e = (e as { cause?: unknown }).cause
		) {
			const name = (e as { constraint?: unknown }).constraint;
			if (typeof name === "string") return name;
		}
		throw err;
	}
}

async function openTerm(
	membershipId: string,
	position: OfficerPosition,
	termEnd: Date | null = null,
): Promise<void> {
	await testDb.insert(officerTerms).values({
		membershipId,
		position,
		termStart: new Date(2026, 5, 1),
		termEnd,
	});
}

describe.skipIf(!hasTestDb)("officer training (integration)", () => {
	let seeded: SeededClub;

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	// -----------------------------------------------------------------------
	// Windows: absent row = TI's dates
	// -----------------------------------------------------------------------

	describe("training windows", () => {
		it("returns TI's own dates when the club has stored nothing", async () => {
			// Absolute literals, not `defaultTrainingWindow(...)` — deriving the
			// expectation from the function under test passes for whatever dates it
			// happens to return, including a period 2 a whole year late.
			const windows = await loadTrainingWindows(seeded.clubId, PY);
			expect(windows).toEqual([
				{
					window: { period: 1, startsOn: "2026-06-01", endsOn: "2026-08-31" },
					isDefault: true,
				},
				{
					window: { period: 2, startsOn: "2026-11-01", endsOn: "2027-02-28" },
					isDefault: true,
				},
			]);
		});

		it("stores nothing on a plain read — the table stays sparse", async () => {
			await loadTrainingWindows(seeded.clubId, PY);
			const rows = await testDb
				.select({ id: officerTrainingPeriods.id })
				.from(officerTrainingPeriods)
				.where(eq(officerTrainingPeriods.clubId, seeded.clubId));
			expect(rows).toHaveLength(0);
		});

		it("overrides one period and leaves the other on TI's dates", async () => {
			const windows = await setTrainingWindow({
				clubId: seeded.clubId,
				programYear: PY,
				period: 1,
				startsOn: "2026-06-15",
				endsOn: "2026-09-15",
			});
			expect(windows[0]).toEqual({
				window: { period: 1, startsOn: "2026-06-15", endsOn: "2026-09-15" },
				isDefault: false,
			});
			// Untouched, and still flagged as a default rather than inheriting the
			// override's `isDefault: false`.
			expect(windows[1]?.isDefault).toBe(true);
			expect(windows[1]?.window.startsOn).toBe("2026-11-01");
		});

		it("upserts rather than duplicating on a second edit", async () => {
			for (const startsOn of ["2026-06-15", "2026-06-20"]) {
				await setTrainingWindow({
					clubId: seeded.clubId,
					programYear: PY,
					period: 1,
					startsOn,
					endsOn: "2026-09-15",
				});
			}
			const rows = await testDb
				.select({ startsOn: officerTrainingPeriods.startsOn })
				.from(officerTrainingPeriods)
				.where(
					and(
						eq(officerTrainingPeriods.clubId, seeded.clubId),
						eq(officerTrainingPeriods.period, 1),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.startsOn).toBe("2026-06-20");
		});

		it("scopes an override to its own program year", async () => {
			await setTrainingWindow({
				clubId: seeded.clubId,
				programYear: PY,
				period: 1,
				startsOn: "2026-06-15",
				endsOn: "2026-09-15",
			});
			const next = await loadTrainingWindows(seeded.clubId, PY + 1);
			expect(next[0]?.isDefault).toBe(true);
			expect(next[0]?.window.startsOn).toBe("2027-06-01");
		});

		it("resets an override back to TI's dates", async () => {
			await setTrainingWindow({
				clubId: seeded.clubId,
				programYear: PY,
				period: 2,
				startsOn: "2026-12-01",
				endsOn: "2027-01-31",
			});
			const windows = await resetTrainingWindow({
				clubId: seeded.clubId,
				programYear: PY,
				period: 2,
			});
			expect(windows[1]).toEqual({
				window: { period: 2, startsOn: "2026-11-01", endsOn: "2027-02-28" },
				isDefault: true,
			});
			const rows = await testDb
				.select({ id: officerTrainingPeriods.id })
				.from(officerTrainingPeriods)
				.where(eq(officerTrainingPeriods.clubId, seeded.clubId));
			expect(rows).toHaveLength(0);
		});

		it("refuses a window that ends before it starts", async () => {
			// The db CHECK is the copy a raw `sql` write cannot bypass; assert it
			// directly, because the zod refinement in front of it is not what
			// protects the table. Asserted on the CONSTRAINT NAME rather than on the
			// message text: drizzle's wrapper prints the failing SQL and hides the
			// name in its cause, so a `toThrow(/check/)` here would pass for a
			// not-null violation, a FK violation, or a typo in the column list —
			// every insert failure looks alike from the outside.
			expect(
				await violatedConstraint(
					testDb.insert(officerTrainingPeriods).values({
						clubId: seeded.clubId,
						programYear: PY,
						period: 1,
						startsOn: "2026-08-31",
						endsOn: "2026-06-01",
					}),
				),
			).toBe("officer_training_periods_order_check");
		});

		it("refuses a third training period at the database level", async () => {
			expect(
				await violatedConstraint(
					testDb.insert(officerTrainingPeriods).values({
						clubId: seeded.clubId,
						programYear: PY,
						period: 3,
						startsOn: "2026-06-01",
						endsOn: "2026-08-31",
					}),
				),
			).toBe("officer_training_periods_period_check");
		});
	});

	// -----------------------------------------------------------------------
	// Records + the distinct-PEOPLE count
	// -----------------------------------------------------------------------

	describe("records and the four-officer bar", () => {
		it("counts a dual-office holder ONCE, so four records over three people fall short", async () => {
			// Fixture axis 1. Distinct-offices reads 4 here and clears the bar;
			// distinct-people reads 3 and does not.
			const alice = await addMember(seeded.clubId, "Alice Dual");
			const bob = await addMember(seeded.clubId, "Bob");
			const cara = await addMember(seeded.clubId, "Cara");
			for (const [membershipId, position] of [
				[alice, "secretary"],
				[alice, "treasurer"],
				[bob, "president"],
				[cara, "vp_education"],
			] as const) {
				await addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId,
						position,
						period: 1,
						trainedOn: IN_P1,
					},
					seeded.adminUserId,
				);
			}

			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.records).toHaveLength(4);
			expect(view.periods[0]?.trained).toBe(3);
			expect(view.periods[0]?.required).toBe(4);
			expect(view.periods[0]?.shortfall).toBe(1);
			expect(view.periods[0]?.met).toBe(false);
			expect(view.g9Suggestion).toBe(0);
		});

		it("clears a period at four distinct people", async () => {
			const ids = await Promise.all([
				addMember(seeded.clubId, "One"),
				addMember(seeded.clubId, "Two"),
				addMember(seeded.clubId, "Three"),
				addMember(seeded.clubId, "Four"),
			]);
			const offices = [
				"president",
				"vp_education",
				"secretary",
				"treasurer",
			] as const;
			for (const [i, membershipId] of ids.entries()) {
				await addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId,
						// biome-ignore lint/style/noNonNullAssertion: index is bounded by ids.length === offices.length
						position: offices[i]!,
						period: 1,
						trainedOn: IN_P1,
					},
					null,
				);
			}
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.periods[0]?.trained).toBe(4);
			expect(view.periods[0]?.met).toBe(true);
			// Only ONE period is met, so goal 9 is not.
			expect(view.periods[1]?.trained).toBe(0);
			expect(view.g9Suggestion).toBe(0);
		});

		it("keeps a record counting after its officer's term ended mid-window", async () => {
			// Fixture axis 2. The club WAS credited for the session that happened;
			// dropping the credit when the person leaves the office would silently
			// push the club under the bar. The seat, by contrast, must disappear.
			const gone = await addMember(seeded.clubId, "Zeno Departed");
			await openTerm(gone, "secretary", new Date(2026, 6, 20)); // closed mid-window
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: gone,
					position: "secretary",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);

			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.periods[0]?.trained).toBe(1);
			expect(view.records[0]?.memberName).toBe("Zeno Departed");
			// The closed term is not a current seat.
			expect(view.seats.map((s) => s.membershipId)).not.toContain(gone);
		});

		it("keeps a record counting after its member went inactive", async () => {
			const left = await addMember(seeded.clubId, "Yara Inactive", {
				status: "inactive",
			});
			await openTerm(left, "treasurer");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: left,
					position: "treasurer",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.periods[0]?.trained).toBe(1);
			// Off the seat list and off the picker roster, both of which are prompts
			// about who still needs sending.
			expect(view.seats.map((s) => s.membershipId)).not.toContain(left);
			expect(view.roster.map((r) => r.membershipId)).not.toContain(left);
		});

		it("flags a record dated outside its period's window WITHOUT voiding it", async () => {
			// Fixture axis 3. September falls in neither window.
			const mia = await addMember(seeded.clubId, "Mia Late");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: mia,
					position: "president",
					period: 1,
					trainedOn: IN_NEITHER,
				},
				null,
			);
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.records[0]?.outsideWindow).toBe(true);
			// Still counts — TI is the arbiter of whether the session was credited.
			expect(view.periods[0]?.trained).toBe(1);
		});

		it("re-flags an existing record when the club widens its window", async () => {
			// The flag is derived on read, so the override has to move it. A stored
			// boolean would have gone stale here, silently.
			const mia = await addMember(seeded.clubId, "Mia Late");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: mia,
					position: "president",
					period: 1,
					trainedOn: IN_NEITHER,
				},
				null,
			);
			await setTrainingWindow({
				clubId: seeded.clubId,
				programYear: PY,
				period: 1,
				startsOn: "2026-06-01",
				endsOn: "2026-09-30",
			});
			const after = await loadTrainingRecords(seeded.clubId, PY);
			expect(after[0]?.outsideWindow).toBe(false);
		});

		it("does not flag a record with no date recorded", async () => {
			const noDate = await addMember(seeded.clubId, "Nora Undated");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: noDate,
					position: "president",
					period: 1,
				},
				null,
			);
			const rows = await loadTrainingRecords(seeded.clubId, PY);
			expect(rows[0]?.trainedOn).toBeNull();
			expect(rows[0]?.outsideWindow).toBe(false);
			// A nullable column, not a sentinel: "unknown" must not be a real date
			// that some other predicate later reads as a real one.
			expect(rows[0]?.counts).toBe(true);
		});

		it("scopes records to their program year", async () => {
			const dan = await addMember(seeded.clubId, "Dan");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: dan,
					position: "president",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);
			expect(await loadTrainingRecords(seeded.clubId, PY)).toHaveLength(1);
			expect(await loadTrainingRecords(seeded.clubId, PY + 1)).toHaveLength(0);
		});

		it("updates rather than duplicating the same (member, office, year, period)", async () => {
			const dan = await addMember(seeded.clubId, "Dan");
			for (const trainedOn of [IN_P1, "2026-08-02"]) {
				await addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId: dan,
						position: "president",
						period: 1,
						trainedOn,
					},
					null,
				);
			}
			const rows = await loadTrainingRecords(seeded.clubId, PY);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.trainedOn).toBe("2026-08-02");
		});

		it("keeps the same person's two periods as separate rows", async () => {
			const dan = await addMember(seeded.clubId, "Dan");
			for (const period of [1, 2] as const) {
				await addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId: dan,
						position: "president",
						period,
						trainedOn: period === 1 ? IN_P1 : IN_P2,
					},
					null,
				);
			}
			expect(await loadTrainingRecords(seeded.clubId, PY)).toHaveLength(2);
		});
	});

	// -----------------------------------------------------------------------
	// Immediate Past President
	// -----------------------------------------------------------------------

	describe("Immediate Past President", () => {
		it("refuses to record training for it", async () => {
			// TI lists seven elected offices and IPP is not among them. Storing a row
			// the club can SEE but the count ignores is worse than refusing it.
			const ipp = await addMember(seeded.clubId, "Ivy Past");
			await expect(
				addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId: ipp,
						position: "immediate_past_president",
						period: 1,
						trainedOn: IN_P1,
					},
					null,
				),
			).rejects.toThrow(/not one of the seven offices/);
			expect(await loadTrainingRecords(seeded.clubId, PY)).toHaveLength(0);
		});

		it("does not count an IPP row that reached the table another way", async () => {
			// Defence in depth: the count filters the office rather than trusting the
			// write path, so a row inserted by an import or a raw statement is inert.
			const ipp = await addMember(seeded.clubId, "Ivy Past");
			await testDb.insert(officerTrainingRecords).values({
				membershipId: ipp,
				position: "immediate_past_president",
				programYear: PY,
				period: 1,
				trainedOn: IN_P1,
			});
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.records).toHaveLength(1);
			expect(view.records[0]?.counts).toBe(false);
			expect(view.periods[0]?.trained).toBe(0);
		});

		it("leaves it off the current-seat list", async () => {
			const ipp = await addMember(seeded.clubId, "Ivy Past");
			await openTerm(ipp, "immediate_past_president");
			const seats = await loadOfficerSeats(seeded.clubId);
			expect(seats.map((s) => s.position)).not.toContain(
				"immediate_past_president",
			);
		});
	});

	// -----------------------------------------------------------------------
	// Club scoping on the ids the CLIENT supplies
	// -----------------------------------------------------------------------

	describe("club scoping", () => {
		let other: SeededClub;

		beforeEach(async () => {
			other = await seedClub();
		});

		afterEach(async () => {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		});

		it("refuses to record training for a member of another club", async () => {
			// `requireClubRole` proves the caller administers THIS club; it says
			// nothing about whether the membership id they posted belongs to it.
			const outsider = await addMember(other.clubId, "Outsider");
			await expect(
				addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId: outsider,
						position: "president",
						period: 1,
						trainedOn: IN_P1,
					},
					null,
				),
			).rejects.toThrow(/not on this club's roster/);
			expect(await loadTrainingRecords(other.clubId, PY)).toHaveLength(0);
		});

		it("refuses to record training for a membership id that does not exist", async () => {
			await expect(
				addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId: "00000000-0000-0000-0000-000000000000",
						position: "president",
						period: 1,
					},
					null,
				),
			).rejects.toThrow(/not on this club's roster/);
		});

		it("refuses to delete another club's record", async () => {
			const outsider = await addMember(other.clubId, "Outsider");
			await addTrainingRecord(
				{
					clubId: other.clubId,
					programYear: PY,
					membershipId: outsider,
					position: "president",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);
			const theirs = await loadTrainingRecords(other.clubId, PY);
			// biome-ignore lint/style/noNonNullAssertion: asserted non-empty on the next line
			const recordId = theirs[0]!.id;
			expect(theirs).toHaveLength(1);

			const result = await removeTrainingRecord({
				clubId: seeded.clubId,
				recordId,
			});
			expect(result.removed).toBe(false);
			// Still there — the id alone carries no ownership.
			expect(await loadTrainingRecords(other.clubId, PY)).toHaveLength(1);
		});

		it("deletes its own record", async () => {
			const dan = await addMember(seeded.clubId, "Dan");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: dan,
					position: "president",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);
			const mine = await loadTrainingRecords(seeded.clubId, PY);
			const result = await removeTrainingRecord({
				clubId: seeded.clubId,
				// biome-ignore lint/style/noNonNullAssertion: seeded one row immediately above
				recordId: mine[0]!.id,
			});
			expect(result.removed).toBe(true);
			expect(await loadTrainingRecords(seeded.clubId, PY)).toHaveLength(0);
		});

		it("reports removed:false for an id that never existed", async () => {
			const result = await removeTrainingRecord({
				clubId: seeded.clubId,
				recordId: "00000000-0000-0000-0000-000000000000",
			});
			expect(result.removed).toBe(false);
		});

		it("does not read another club's records or windows", async () => {
			const outsider = await addMember(other.clubId, "Outsider");
			await addTrainingRecord(
				{
					clubId: other.clubId,
					programYear: PY,
					membershipId: outsider,
					position: "president",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);
			await setTrainingWindow({
				clubId: other.clubId,
				programYear: PY,
				period: 1,
				startsOn: "2026-06-15",
				endsOn: "2026-09-15",
			});
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.records).toHaveLength(0);
			expect(view.periods[0]?.windowIsDefault).toBe(true);
			expect(view.periods[0]?.window.endsOn).toBe("2026-08-31");
		});

		it("cascades records away with the club", async () => {
			const outsider = await addMember(other.clubId, "Outsider");
			await addTrainingRecord(
				{
					clubId: other.clubId,
					programYear: PY,
					membershipId: outsider,
					position: "president",
					period: 1,
				},
				null,
			);
			await setTrainingWindow({
				clubId: other.clubId,
				programYear: PY,
				period: 1,
				startsOn: "2026-06-15",
				endsOn: "2026-09-15",
			});
			// The takedown lever (ADR-0024) reaches these rows through
			// clubs → members → records, and clubs → periods.
			await testDb.delete(clubs).where(eq(clubs.id, other.clubId));
			expect(
				await testDb
					.select({ id: officerTrainingRecords.id })
					.from(officerTrainingRecords)
					.where(eq(officerTrainingRecords.membershipId, outsider)),
			).toHaveLength(0);
			expect(
				await testDb
					.select({ id: officerTrainingPeriods.id })
					.from(officerTrainingPeriods)
					.where(eq(officerTrainingPeriods.clubId, other.clubId)),
			).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// Seats and the countdown
	// -----------------------------------------------------------------------

	describe("the view", () => {
		it("lists current TI-countable seats President-first, one row per office", async () => {
			const alice = await addMember(seeded.clubId, "Alice Dual");
			const bob = await addMember(seeded.clubId, "Bob");
			await openTerm(alice, "secretary");
			await openTerm(alice, "treasurer");
			await openTerm(bob, "president");
			const seats = await loadOfficerSeats(seeded.clubId);
			expect(seats.map((s) => s.position)).toEqual([
				"president",
				"secretary",
				"treasurer",
			]);
			expect(seats.filter((s) => s.membershipId === alice)).toHaveLength(2);
		});

		it("reports the window countdown against the date it was given", async () => {
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				"2026-08-11",
			);
			expect(view.today).toBe("2026-08-11");
			expect(view.periods[0]?.phase).toBe("open");
			// 2026-08-11 → 2026-08-31 inclusive of the last day.
			expect(view.periods[0]?.daysUntilClose).toBe(20);
			expect(view.periods[1]?.phase).toBe("upcoming");
			expect(view.focus).toBe(1);
		});

		it("reports the closed-window shortfall the issue exists to surface", async () => {
			// "A club discovers in March that only three officers got trained in the
			// second window, the window is shut, and a DCP point is gone."
			const ids = await Promise.all([
				addMember(seeded.clubId, "One"),
				addMember(seeded.clubId, "Two"),
				addMember(seeded.clubId, "Three"),
			]);
			const offices = ["president", "vp_education", "secretary"] as const;
			for (const [i, membershipId] of ids.entries()) {
				await addTrainingRecord(
					{
						clubId: seeded.clubId,
						programYear: PY,
						membershipId,
						// biome-ignore lint/style/noNonNullAssertion: index bounded by offices.length
						position: offices[i]!,
						period: 2,
						trainedOn: IN_P2,
					},
					null,
				);
			}
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				"2027-03-10",
			);
			expect(view.periods[1]?.phase).toBe("closed");
			expect(view.periods[1]?.daysUntilClose).toBeNull();
			expect(view.periods[1]?.trained).toBe(3);
			expect(view.periods[1]?.shortfall).toBe(1);
			expect(view.g9Suggestion).toBe(0);
		});

		it("reports hasRecords:false for a club that has recorded nothing", async () => {
			const view = await getOfficerTrainingView(
				{ clubId: seeded.clubId, programYear: PY },
				IN_P1,
			);
			expect(view.hasRecords).toBe(false);
			expect(view.g9Suggestion).toBe(0);
			expect(view.records).toEqual([]);
		});

		it("defaults `today` to the real clock rather than throwing", async () => {
			// The parameter exists for determinism; the default has to work, since
			// the server fn passes nothing.
			const view = await getOfficerTrainingView({
				clubId: seeded.clubId,
				programYear: PY,
			});
			expect(view.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});

	// -----------------------------------------------------------------------
	// The goal-9 assist on the scoreboard
	// -----------------------------------------------------------------------

	describe("the goal 9 suggestion", () => {
		/** Four distinct people trained in BOTH periods — the only shape that clears g9. */
		async function trainBothPeriods(): Promise<void> {
			const ids = await Promise.all([
				addMember(seeded.clubId, "One"),
				addMember(seeded.clubId, "Two"),
				addMember(seeded.clubId, "Three"),
				addMember(seeded.clubId, "Four"),
			]);
			const offices = [
				"president",
				"vp_education",
				"secretary",
				"treasurer",
			] as const;
			for (const period of [1, 2] as const) {
				for (const [i, membershipId] of ids.entries()) {
					await addTrainingRecord(
						{
							clubId: seeded.clubId,
							programYear: PY,
							membershipId,
							// biome-ignore lint/style/noNonNullAssertion: index bounded by offices.length
							position: offices[i]!,
							period,
							trainedOn: period === 1 ? IN_P1 : IN_P2,
						},
						null,
					);
				}
			}
		}

		it("does NOT write goal 9 when the records already clear the bar", async () => {
			// The whole point of the assist pattern (ADR-0019): the derivation is a
			// suggestion, and TI is the system of record. If recording training could
			// tick the box on its own, a club could be told it had a point it did not.
			await startScoreboard({ clubId: seeded.clubId, programYear: PY });
			await trainBothPeriods();
			const board = await getScoreboard({
				clubId: seeded.clubId,
				programYear: PY,
			});
			expect(board.derivedTraining.suggestion).toBe(1);
			expect(board.derivedTraining.trainedByPeriod).toEqual([4, 4]);
			expect(board.derivedTraining.hasRecords).toBe(true);
			// Stored value untouched, and the goal is therefore not met.
			expect(board.progress.g9).toBe(0);
			expect(board.summary.goalsMet).toBe(0);
		});

		it("suggests 0 with three of four in the second period", async () => {
			await startScoreboard({ clubId: seeded.clubId, programYear: PY });
			await trainBothPeriods();
			// Remove one second-period record, leaving three distinct people there.
			const rows = await loadTrainingRecords(seeded.clubId, PY);
			const second = rows.filter((r) => r.period === 2);
			await removeTrainingRecord({
				clubId: seeded.clubId,
				// biome-ignore lint/style/noNonNullAssertion: trainBothPeriods seeds four second-period rows
				recordId: second[0]!.id,
			});
			const board = await getScoreboard({
				clubId: seeded.clubId,
				programYear: PY,
			});
			expect(board.derivedTraining.trainedByPeriod).toEqual([4, 3]);
			expect(board.derivedTraining.suggestion).toBe(0);
		});

		it("reports hasRecords:false and suggestion 0 before anything is recorded", async () => {
			await startScoreboard({ clubId: seeded.clubId, programYear: PY });
			const board = await getScoreboard({
				clubId: seeded.clubId,
				programYear: PY,
			});
			expect(board.derivedTraining).toEqual({
				suggestion: 0,
				trainedByPeriod: [0, 0],
				hasRecords: false,
			});
		});

		it("computes the suggestion even with no scoreboard started", async () => {
			// The panel is usable before the President starts the year's scoreboard,
			// which is exactly when the deadline reading is worth having.
			await trainBothPeriods();
			const board = await getScoreboard({
				clubId: seeded.clubId,
				programYear: PY,
			});
			expect(board.exists).toBe(false);
			expect(board.derivedTraining.suggestion).toBe(1);
		});

		it("writes goal 9 only when explicitly applied, and nothing else", async () => {
			await startScoreboard({ clubId: seeded.clubId, programYear: PY });
			await trainBothPeriods();
			const applied = await applyTrainingSuggestion(
				{ clubId: seeded.clubId, programYear: PY },
				seeded.adminUserId,
			);
			expect(applied.progress.g9).toBe(1);
			expect(applied.summary.goalsMet).toBe(1);
			// Scoped to g9: the other composite goal and the education goals are
			// untouched, so the apply cannot quietly move the rest of the scoreboard.
			expect(applied.progress.g10).toBe(0);
			expect(applied.progress.g1).toBe(0);
			expect(applied.progress.g7).toBe(0);
		});

		it("applies a 0 that clears a hand-entered Met", async () => {
			// Deliberate: the President is accepting what the records say, and an
			// apply that silently refused to lower a value would leave the scoreboard
			// disagreeing with the panel beside it. The guard is upstream — the UI
			// only offers this once records exist, and names the value it will write.
			await startScoreboard({ clubId: seeded.clubId, programYear: PY });
			const dan = await addMember(seeded.clubId, "Dan");
			await addTrainingRecord(
				{
					clubId: seeded.clubId,
					programYear: PY,
					membershipId: dan,
					position: "president",
					period: 1,
					trainedOn: IN_P1,
				},
				null,
			);
			await updateGoal(
				{ clubId: seeded.clubId, programYear: PY, goalKey: "g9", achieved: 1 },
				seeded.adminUserId,
			);
			const applied = await applyTrainingSuggestion(
				{ clubId: seeded.clubId, programYear: PY },
				seeded.adminUserId,
			);
			expect(applied.progress.g9).toBe(0);
		});

		it("refuses to apply before the year's scoreboard is started", async () => {
			await trainBothPeriods();
			await expect(
				applyTrainingSuggestion(
					{ clubId: seeded.clubId, programYear: PY },
					seeded.adminUserId,
				),
			).rejects.toThrow(/No DCP scoreboard/);
		});

		it("clamps the applied value to the composite 0/1", async () => {
			// `updateGoal` owns the clamp; routing the apply through it rather than
			// upserting `dcp_goal_progress` directly is what keeps one copy of it.
			await startScoreboard({ clubId: seeded.clubId, programYear: PY });
			await trainBothPeriods();
			const applied = await applyTrainingSuggestion(
				{ clubId: seeded.clubId, programYear: PY },
				seeded.adminUserId,
			);
			expect(applied.progress.g9).toBe(1);
			expect(applied.progress.g9).not.toBeGreaterThan(1);
		});
	});
});
