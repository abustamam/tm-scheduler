/**
 * DB-backed tests for `record_guest_book`'s preview→apply loop (#773, D5/D7).
 *
 * This is the mechanism every later write tool inherits, so the cases that
 * matter are the refusals: a stale plan, an unresolved ambiguity, a second run
 * of the same page. Each asserts on the ROWS afterwards, not on a tool result
 * that says ok — "nothing was written" is the actual claim.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/record-guest-book.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	guests,
	meetingAttendance,
	meetings,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { recordGuestBookTool } = await import(
	"#/server/mcp/tools/record-guest-book"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");

/** Shape of a preview result, narrowed for the assertions below. */
interface Preview {
	applied: false;
	plan?: null;
	planHash: string | null;
	blocking: { code: string; entryIndex?: number; detail?: unknown }[];
	meeting?: {
		meetingId: string;
		meetingNumber: number | null;
		date: string;
		theme: string | null;
	};
	summary?: {
		matched: number;
		new: number;
		ambiguous: number;
		already_present: number;
		minutesRecipients: number;
		probablyAlreadyTranscribed: boolean;
	};
	entries?: {
		index: number;
		name: string;
		outcome: string;
		guestId: string | null;
		emailMasked: string | null;
	}[];
}

describe.skipIf(!hasTestDb)("record_guest_book (#773)", () => {
	let seed: SeededClub;
	let token: string;
	/** A meeting whose club-local date has arrived, so attendance is recordable. */
	let pastMeetingId: string;
	let pastMeetingDate: string;

	/** Call the tool the way the transport does. */
	function call(args: Record<string, unknown>) {
		return recordGuestBookTool.handler(args, { rawToken: token });
	}

	async function guestRows() {
		return testDb
			.select({ id: guests.id, name: guests.name, email: guests.email })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
	}

	async function attendanceRows(meetingId = pastMeetingId) {
		return testDb
			.select({ guestId: meetingAttendance.guestId })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, meetingId));
	}

	beforeEach(async () => {
		seed = await seedClub();
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;

		// `seedClub`'s meeting is in the FUTURE, which is deliberately not
		// recordable. Add one a week back for the recordable cases.
		//
		// Anchored at MIDDAY club-local rather than at whatever time of day the
		// suite happens to run. "Blocks a date with TWO meetings" seeds its second
		// meeting an hour after this one, and a bare `Date.now() - 7 days` put
		// this at the current wall-clock time: between 23:00 and 23:59
		// America/Chicago the second meeting landed on the NEXT club-local day, the
		// date named one meeting rather than two, and `AMBIGUOUS_DATE` never fired.
		// MEASURED at 23:08 CDT — `p.plan` came back as a real plan, not null. One
		// hour in twenty-four, so it reads as a flake rather than as the wall-clock
		// time bomb `seedClub` warns about in the same words.
		const { utcToZonedWallTime, zonedWallTimeToUtc } = await import(
			"#/lib/datetime"
		);
		const weekAgo = utcToZonedWallTime(
			new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			"America/Chicago",
		).slice(0, 10);
		const past = zonedWallTimeToUtc(`${weekAgo}T12:00`, "America/Chicago");
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: past,
				status: "completed",
				theme: "Harvest",
			})
			.returning({ id: meetings.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		pastMeetingId = row!.id;
		// The seeded club's timezone is the schema default (America/Chicago), so
		// derive the club-local day rather than assuming it matches UTC.
		pastMeetingDate = utcToZonedWallTime(past, "America/Chicago").slice(0, 10);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// --- AC5: the preview writes nothing and says what it would do -------

	it("previews without writing, naming the meeting and classifying each line", async () => {
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Rita Vance",
			email: "rita@example.com",
			stage: "prospect",
		});

		const p = (await call({
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [
				{ name: "Rita Vance", email: "rita@example.com" },
				{ name: "Newcomer One", email: "new1@example.com" },
				{ name: "Newcomer Two" },
			],
		})) as Preview;

		expect(p.applied).toBe(false);
		expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(p.blocking).toEqual([]);
		// The header names the meeting back, so a wrong date is visible BEFORE
		// anything reaches the minutes email.
		expect(p.meeting).toMatchObject({
			meetingId: pastMeetingId,
			date: pastMeetingDate,
			theme: "Harvest",
		});
		expect(p.entries?.map((e) => e.outcome)).toEqual(["matched", "new", "new"]);
		// Two of the three have an email, so two would receive the minutes.
		expect(p.summary).toMatchObject({
			matched: 1,
			new: 2,
			ambiguous: 0,
			already_present: 0,
			minutesRecipients: 2,
		});

		// Nothing written.
		expect(await guestRows()).toHaveLength(1);
		expect(await attendanceRows()).toHaveLength(0);
	});

	// --- The happy path --------------------------------------------------

	it("applies a page: creates new guests, reuses matched ones, records attendance", async () => {
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Rita Vance",
			email: "rita@example.com",
			stage: "prospect",
		});

		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [
				{ name: "Rita Vance", email: "rita@example.com" },
				{ name: "Newcomer One", email: "new1@example.com" },
			],
		};
		const preview = (await call(args)) as Preview;
		const applied = (await call({
			...args,
			planHash: preview.planHash,
		})) as {
			applied: true;
			newGuestIds: string[];
			matchedGuestIds: string[];
			attendanceRecorded: number;
		};

		expect(applied.applied).toBe(true);
		expect(applied.newGuestIds).toHaveLength(1);
		expect(applied.matchedGuestIds).toHaveLength(1);
		expect(applied.attendanceRecorded).toBe(2);
		expect(await guestRows()).toHaveLength(2);
		expect(await attendanceRows()).toHaveLength(2);

		// One activity row per apply, carrying ids and no names or contact —
		// every member of the club can read the feed.
		const log = await testDb
			.select({
				action: activityLog.action,
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "guest_visits_record"),
				),
			);
		expect(log).toHaveLength(1);
		expect(log[0]?.actorMemberId).toBe(seed.adminMemberId);
		expect(JSON.stringify(log[0]?.detail)).not.toContain("Rita");
		expect(JSON.stringify(log[0]?.detail)).not.toContain("@example.com");
		expect(log[0]?.detail).toMatchObject({ via: "mcp" });
	});

	// --- AC6: a stale plan ------------------------------------------------

	it("refuses a stale planHash, returns a fresh plan, and writes nothing", async () => {
		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Rita Vance", email: "rita@example.com" }],
		};
		const preview = (await call(args)) as Preview;

		// Someone else records that same guest between preview and apply — the
		// line is now `already_present`, so the plan the human approved is no
		// longer the plan that would run.
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Rita Vance",
				email: "rita@example.com",
				stage: "prospect",
			})
			.returning({ id: guests.id });
		await testDb.insert(meetingAttendance).values({
			meetingId: pastMeetingId,
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			guestId: g!.id,
			status: "present",
		});

		await expect(
			call({ ...args, planHash: preview.planHash }),
		).rejects.toMatchObject({
			code: "PLAN_STALE",
			detail: expect.objectContaining({ planHash: expect.any(String) }),
		});

		// Exactly the rows the interloper wrote — the apply added none.
		expect(await guestRows()).toHaveLength(1);
		expect(await attendanceRows()).toHaveLength(1);
	});

	it("leaves the hash unchanged when an unrelated row elsewhere in the club changes", async () => {
		// A plan contains only the rows it would touch, so ordinary activity in
		// the club must not make an approved plan un-appliable. Without this, the
		// mechanism would be too brittle to use on a busy club.
		//
		// The inserted meeting is EARLIER than the one being transcribed, and
		// carries a meeting NUMBER. That combination is the one that matters and
		// an earlier version of this test could not see it: it inserted a FUTURE
		// meeting, which is the one case that cannot move anything, so it passed
		// while the hash was in fact unstable. `deriveMeetingNumber` counts
		// forward from the club's most recent numbered meeting, so backfilling a
		// number onto an earlier one renumbers every meeting after it — and with
		// the derived number inside the hashed plan that renumber failed every
		// outstanding apply as PLAN_STALE. MEASURED before the fix: the header
		// moved from null to 41 and the hash changed.
		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Solo Visitor", email: "solo@example.com" }],
		};
		const first = (await call(args)) as Preview;

		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
			status: "completed",
			theme: "Backfilled",
			meetingNumber: 40,
		});

		const second = (await call(args)) as Preview;
		expect(second.planHash).toBe(first.planHash);
		// The number itself is still REPORTED — it just is not hashed. Without
		// this the test would also pass if the header silently stopped carrying
		// it, which is the other way to make the hash stable and the wrong one.
		expect(second.meeting?.meetingNumber).toBe(41);
		expect(first.meeting?.meetingNumber).toBeNull();
	});

	it("blocks an email address it cannot parse, and never lets one reach the mailer", async () => {
		// A guest marked present becomes a default recipient of the minutes email,
		// and `resolveMinutesRecipients` only checks the string is non-empty. This
		// path is fed by an LLM reading handwriting, so it is the one most likely
		// to produce a malformed address — and it was the only guest-writing path
		// not validating the format.
		const p = (await call({
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Smudged Line", email: "jane at example dot com" }],
		})) as Preview;
		expect(p.blocking[0]).toMatchObject({
			code: "INVALID_EMAIL",
			entryIndex: 0,
		});

		// And apply refuses while it stands, so nothing is written.
		await expect(
			call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Smudged Line", email: "jane at example dot com" }],
				planHash: p.planHash,
			}),
		).rejects.toMatchObject({ code: "BLOCKED" });
		expect(await guestRows()).toHaveLength(0);
	});

	// --- AC7: an unresolved ambiguity ------------------------------------

	it("BLOCKs an apply while a line is ambiguous, and writes nothing", async () => {
		// A shared number under a name that does not agree: #488 says these are
		// two prospects, and a transcriber gets asked rather than guessed at.
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Samir Patel",
			phone: "+15551234567",
			stage: "prospect",
		});

		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Priya Raman", phone: "+1 555 123 4567" }],
		};
		const preview = (await call(args)) as Preview;

		expect(preview.entries?.[0]?.outcome).toBe("ambiguous");
		expect(preview.blocking[0]).toMatchObject({
			code: "AMBIGUOUS_GUEST",
			entryIndex: 0,
		});
		// The candidates it offers are masked, like everything else that leaves.
		expect(JSON.stringify(preview.blocking)).not.toContain("5551234567");

		await expect(
			call({ ...args, planHash: preview.planHash }),
		).rejects.toMatchObject({ code: "BLOCKED" });
		expect(await guestRows()).toHaveLength(1);
		expect(await attendanceRows()).toHaveLength(0);
	});

	it("applies once the ambiguity is resolved as a new person", async () => {
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Samir Patel",
			phone: "+15551234567",
			stage: "prospect",
		});
		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Priya Raman", phone: "+1 555 123 4567" }],
			resolve: { "0": "new" },
		};
		const preview = (await call(args)) as Preview;
		expect(preview.blocking).toEqual([]);
		expect(preview.entries?.[0]?.outcome).toBe("new");

		await call({ ...args, planHash: preview.planHash });
		expect(await guestRows()).toHaveLength(2);
		expect(await attendanceRows()).toHaveLength(1);
	});

	it("applies once the ambiguity is resolved onto an existing guest", async () => {
		const [existing] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Samir Patel",
				phone: "+15551234567",
				stage: "prospect",
			})
			.returning({ id: guests.id });
		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "S. Patel", phone: "+1 555 123 4567" }],
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			resolve: { "0": existing!.id },
		};
		const preview = (await call(args)) as Preview;
		expect(preview.entries?.[0]?.outcome).toBe("matched");

		await call({ ...args, planHash: preview.planHash });
		// Resolved onto the existing row: no second guest.
		expect(await guestRows()).toHaveLength(1);
		expect(await attendanceRows()).toHaveLength(1);
	});

	// --- AC8: the same page twice ----------------------------------------

	it("is a no-op on a second run of the same page", async () => {
		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [
				{ name: "First Timer", email: "first@example.com" },
				{ name: "Second Timer", email: "second@example.com" },
			],
		};
		const preview = (await call(args)) as Preview;
		await call({ ...args, planHash: preview.planHash });
		expect(await guestRows()).toHaveLength(2);

		// Re-transcribing the same page: every line is already present, and the
		// plan says so rather than silently succeeding while writing nothing.
		const second = (await call(args)) as Preview;
		expect(second.entries?.every((e) => e.outcome === "already_present")).toBe(
			true,
		);
		expect(second.summary).toMatchObject({
			already_present: 2,
			minutesRecipients: 0,
			probablyAlreadyTranscribed: true,
		});

		await call({ ...args, planHash: second.planHash });
		expect(await guestRows()).toHaveLength(2);
		expect(await attendanceRows()).toHaveLength(2);
	});

	it("creates ONE guest when a page names the same visitor twice", async () => {
		const args = {
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [
				{ name: "Dup Visitor", email: "dup@example.com" },
				{ name: "Dup Visitor", email: "dup@example.com" },
			],
		};
		const preview = (await call(args)) as Preview;
		expect(preview.entries?.map((e) => e.outcome)).toEqual([
			"new",
			"already_present",
		]);
		await call({ ...args, planHash: preview.planHash });
		expect(await guestRows()).toHaveLength(1);
		expect(await attendanceRows()).toHaveLength(1);
	});

	// --- AC13: which meeting -----------------------------------------------

	it("refuses a FUTURE meeting as NOT_RECORDABLE", async () => {
		// Attendance is the RECORD of who was in the room; a future-dated row is
		// a false fact that reaches the minutes PDF and the minutes email.
		const { utcToZonedWallTime } = await import("#/lib/datetime");
		const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await expect(
			call({
				clubId: seed.clubId,
				meetingDate: utcToZonedWallTime(future, "America/Chicago").slice(0, 10),
				entries: [{ name: "Too Early" }],
			}),
		).rejects.toMatchObject({ code: "NOT_RECORDABLE" });
		expect(await guestRows()).toHaveLength(0);
	});

	it("blocks a date with NO meeting", async () => {
		const p = (await call({
			clubId: seed.clubId,
			meetingDate: "2001-01-01",
			entries: [{ name: "Nowhere" }],
		})) as Preview;
		expect(p.plan).toBeNull();
		expect(p.planHash).toBeNull();
		expect(p.blocking[0]).toMatchObject({ code: "NO_MEETING_ON_DATE" });
		// No entry index: the problem is the call, not a line.
		expect(p.blocking[0]?.entryIndex).toBeUndefined();
		expect(await guestRows()).toHaveLength(0);
	});

	it("blocks a date with TWO meetings", async () => {
		// The unique index covers the exact instant, not the date, so a club can
		// legitimately hold two meetings in one day.
		const [same] = await testDb
			.select({ scheduledAt: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, pastMeetingId));
		// biome-ignore lint/style/noNonNullAssertion: the meeting was just seeded
		const later = new Date(same!.scheduledAt.getTime() + 60 * 60 * 1000);
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: later,
			status: "completed",
			theme: "Second sitting",
		});

		const p = (await call({
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Which One" }],
		})) as Preview;
		expect(p.plan).toBeNull();
		expect(p.blocking[0]).toMatchObject({ code: "AMBIGUOUS_DATE" });
		expect(await guestRows()).toHaveLength(0);
	});

	it("blocks a phone number it cannot read", async () => {
		const p = (await call({
			clubId: seed.clubId,
			meetingDate: pastMeetingDate,
			entries: [{ name: "Bad Number", phone: "not a phone" }],
		})) as Preview;
		expect(p.blocking[0]).toMatchObject({
			code: "INVALID_PHONE",
			entryIndex: 0,
		});
	});
});
