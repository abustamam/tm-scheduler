/**
 * DB-backed tests for the meeting write policy as SQL (#1134).
 *
 * `meetingAcceptsWrite` and `meetingRowAccepts` put `MEETING_WRITE_POLICY` in a
 * write's own WHERE. Every case here runs a real UPDATE and counts the rows it
 * touched, because a predicate that has lost its correlation, or its status
 * test, still renders valid SQL and still returns a row for the meeting a test
 * happened to look at. Two things keep that from reading green: the club holds
 * a meeting in EACH status at once, so only a predicate keyed to the write's
 * OWN meeting gives all three answers, and the rendered SQL is pinned below.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-write-gate.integration.test.ts
 */

import { and, eq, type SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meetings, roleSlots } from "#/db/schema";
import type { MeetingStatus } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { meetingAcceptsWrite, meetingRowAccepts } from "./meeting-write-gate";

const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
	meetingId: string;
	slotId: string;
}

/** A meeting in `status` with one open slot, in the seeded club. */
async function seedMeeting(
	club: SeededClub,
	status: MeetingStatus,
	daysOut: number,
): Promise<Fixture> {
	const [meeting] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: new Date(Date.now() + daysOut * DAY),
			status,
		})
		.returning({ id: meetings.id });
	if (!meeting) throw new Error("fixture insert failed");
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: meeting.id,
			roleDefinitionId: club.roleDefinitionId,
			status: "open",
		})
		.returning({ id: roleSlots.id });
	if (!slot) throw new Error("fixture insert failed");
	return { meetingId: meeting.id, slotId: slot.id };
}

/** The write under test: a claim on one slot, guarded by `predicate`. Returns
 *  how many rows it touched. */
async function claimGuarded(slotId: string, predicate: SQL): Promise<number> {
	const rows = await testDb
		.update(roleSlots)
		.set({ status: "claimed" })
		.where(and(eq(roleSlots.id, slotId), predicate))
		.returning({ id: roleSlots.id });
	return rows.length;
}

/** The write under test on `meetings` itself. */
async function editGuarded(meetingId: string, predicate: SQL): Promise<number> {
	const rows = await testDb
		.update(meetings)
		.set({ lengthMinutes: 45 })
		.where(and(eq(meetings.id, meetingId), predicate))
		.returning({ id: meetings.id });
	return rows.length;
}

describe.skipIf(!hasTestDb)("meeting write gate (#1134)", () => {
	let club: SeededClub;
	let scheduled: Fixture;
	let cancelled: Fixture;
	let completed: Fixture;

	beforeEach(async () => {
		club = await seedClub();
		// The seeded meeting is scheduled and already has a slot; a cancelled and a
		// completed meeting sit beside it in the same club.
		scheduled = { meetingId: club.meetingId, slotId: club.slotId };
		cancelled = await seedMeeting(club, "cancelled", 14);
		completed = await seedMeeting(club, "completed", 21);
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	describe("meetingAcceptsWrite on a child table", () => {
		it("plan refuses a cancelled and a completed meeting and accepts a scheduled one", async () => {
			const gate = () =>
				meetingAcceptsWrite(testDb, "plan", roleSlots.meetingId);
			expect(await claimGuarded(cancelled.slotId, gate())).toBe(0);
			expect(await claimGuarded(completed.slotId, gate())).toBe(0);
			expect(await claimGuarded(scheduled.slotId, gate())).toBe(1);
		});

		it("record refuses a cancelled meeting and accepts a completed and a scheduled one", async () => {
			const gate = () =>
				meetingAcceptsWrite(testDb, "record", roleSlots.meetingId);
			expect(await claimGuarded(cancelled.slotId, gate())).toBe(0);
			expect(await claimGuarded(completed.slotId, gate())).toBe(1);
			expect(await claimGuarded(scheduled.slotId, gate())).toBe(1);
		});

		it("leaves the status unchanged on the refused rows", async () => {
			await claimGuarded(
				cancelled.slotId,
				meetingAcceptsWrite(testDb, "plan", roleSlots.meetingId),
			);
			const [row] = await testDb
				.select({ status: roleSlots.status })
				.from(roleSlots)
				.where(eq(roleSlots.id, cancelled.slotId));
			expect(row?.status).toBe("open");
		});

		it("is decided by the slot's OWN meeting, not by its siblings in the club", async () => {
			// A second scheduled meeting beside the cancelled one: a predicate that
			// lost its correlation (any non-cancelled meeting will do) would admit the
			// cancelled meeting's slot because a scheduled one exists, and one widened
			// to the club would refuse the scheduled meeting's slot because a
			// cancelled one does.
			const secondScheduled = await seedMeeting(club, "scheduled", 28);
			for (const writeClass of ["plan", "record"] as const) {
				const gate = () =>
					meetingAcceptsWrite(testDb, writeClass, roleSlots.meetingId);
				expect(await claimGuarded(cancelled.slotId, gate())).toBe(0);
				expect(await claimGuarded(scheduled.slotId, gate())).toBe(1);
				expect(await claimGuarded(secondScheduled.slotId, gate())).toBe(1);
			}
		});

		it("lets a writer accept cancelled under plan while completed stays refused", async () => {
			const gate = () =>
				meetingAcceptsWrite(testDb, "plan", roleSlots.meetingId, {
					accept: ["cancelled"],
				});
			expect(await claimGuarded(cancelled.slotId, gate())).toBe(1);
			expect(await claimGuarded(completed.slotId, gate())).toBe(0);
			expect(await claimGuarded(scheduled.slotId, gate())).toBe(1);
		});

		it("refuses nothing when the writer accepts every status its class refuses", async () => {
			// Accepting everything the class refuses leaves only the correlation: all
			// three meetings' slots match, and the predicate is not always false.
			const gate = () =>
				meetingAcceptsWrite(testDb, "record", roleSlots.meetingId, {
					accept: ["cancelled"],
				});
			expect(await claimGuarded(cancelled.slotId, gate())).toBe(1);
			expect(await claimGuarded(completed.slotId, gate())).toBe(1);
			expect(await claimGuarded(scheduled.slotId, gate())).toBe(1);
		});
	});

	describe("meetingRowAccepts on meetings itself", () => {
		it("plan accepts a scheduled row and refuses a cancelled and a completed one", async () => {
			const gate = () => meetingRowAccepts("plan");
			expect(await editGuarded(scheduled.meetingId, gate())).toBe(1);
			expect(await editGuarded(cancelled.meetingId, gate())).toBe(0);
			expect(await editGuarded(completed.meetingId, gate())).toBe(0);
		});

		it("record refuses a cancelled row and accepts a completed one", async () => {
			const gate = () => meetingRowAccepts("record");
			expect(await editGuarded(scheduled.meetingId, gate())).toBe(1);
			expect(await editGuarded(cancelled.meetingId, gate())).toBe(0);
			expect(await editGuarded(completed.meetingId, gate())).toBe(1);
		});

		it("lets a writer accept a status its class refuses, and only that one", async () => {
			const gate = () => meetingRowAccepts("plan", { accept: ["completed"] });
			expect(await editGuarded(completed.meetingId, gate())).toBe(1);
			expect(await editGuarded(cancelled.meetingId, gate())).toBe(0);
		});

		it("refuses nothing when the writer accepts every status its class refuses", async () => {
			const gate = () =>
				meetingRowAccepts("plan", { accept: ["cancelled", "completed"] });
			expect(await editGuarded(cancelled.meetingId, gate())).toBe(1);
			expect(await editGuarded(completed.meetingId, gate())).toBe(1);
		});
	});
});

// The rendered SQL the helpers produce, and the one refusal that needs no
// query. A hand-written correlated subquery can come out unqualified and
// resolve both sides against its OWN table, matching every row
// (`drizzle-sql-subquery-drops-qualifiers`), so the rendered statement is
// pinned. No database: `toSQL()` renders, so these run with or without one.
describe("meeting write gate renders qualified SQL", () => {
	it("meetingAcceptsWrite names role_slots on one side and meetings on the other", () => {
		const { sql: rendered } = testDb
			.update(roleSlots)
			.set({ status: "claimed" })
			.where(
				and(
					eq(roleSlots.id, "x"),
					meetingAcceptsWrite(testDb, "plan", roleSlots.meetingId),
				),
			)
			.toSQL();
		expect(rendered).toContain(
			'exists (select 1 from "meetings" where ("meetings"."id" = "role_slots"."meeting_id" and "meetings"."status" in ($',
		);
	});

	it("meetingRowAccepts names the meetings status and no subquery", () => {
		const { sql: rendered } = testDb
			.update(meetings)
			.set({ lengthMinutes: 45 })
			.where(and(eq(meetings.id, "x"), meetingRowAccepts("plan")))
			.toSQL();
		expect(rendered).toContain('"meetings"."status" in ($');
		expect(rendered).not.toContain("exists");
	});

	// An allow-list, so a status the policy has never heard of is not in it. The
	// bound parameters ARE the list: a deny-list (`not in`) would carry the
	// refused statuses instead, and an unknown enum value would pass it.
	it("filters on the accepted statuses, never the refused ones", () => {
		const accepted = (
			writeClass: "plan" | "record",
			accept?: readonly ("cancelled" | "completed")[],
		) =>
			testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(meetingRowAccepts(writeClass, { accept }))
				.toSQL();
		expect(accepted("plan").sql).not.toContain("not in");
		expect(accepted("plan").params).toEqual(["scheduled"]);
		expect(accepted("record").params).toEqual(["scheduled", "completed"]);
		expect(accepted("plan", ["cancelled"]).params).toEqual([
			"scheduled",
			"cancelled",
		]);
	});

	it("meetingAcceptsWrite refuses a self-correlation on meetings, which would match every row", () => {
		expect(() => meetingAcceptsWrite(testDb, "plan", meetings.id)).toThrow(
			"meetingRowAccepts",
		);
	});
});
