/**
 * DB-backed tests for `record_guest_book`, which is PREVIEW-ONLY since #806.
 *
 * The tool now plans, stores what was transcribed as a pending row, and hands
 * back a link. Every case here therefore asserts TWO things: what the caller is
 * told, and that `guests` and `meeting_attendance` are untouched. The apply
 * half of this file moved to `src/server/guest-book-confirm.integration.test.ts`,
 * which drives the same plans through the confirm page's own apply.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/record-guest-book.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	guestBookPendingPlans,
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
	pendingId: string;
	confirmUrl: string;
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

describe.skipIf(!hasTestDb)(
	"record_guest_book (#773, preview-only #806)",
	() => {
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

		async function pendingRows() {
			return testDb
				.select({
					id: guestBookPendingPlans.id,
					meetingDate: guestBookPendingPlans.meetingDate,
					createdByUserId: guestBookPendingPlans.createdByUserId,
					entries: guestBookPendingPlans.entries,
					expiresAt: guestBookPendingPlans.expiresAt,
					appliedAt: guestBookPendingPlans.appliedAt,
				})
				.from(guestBookPendingPlans)
				.where(eq(guestBookPendingPlans.clubId, seed.clubId));
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
			pastMeetingDate = utcToZonedWallTime(past, "America/Chicago").slice(
				0,
				10,
			);
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		// --- AC2: the preview writes ONE pending row and nothing else --------

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
			expect(p.entries?.map((e) => e.outcome)).toEqual([
				"matched",
				"new",
				"new",
			]);
			// Two of the three have an email, so two would receive the minutes.
			expect(p.summary).toMatchObject({
				matched: 1,
				new: 2,
				ambiguous: 0,
				already_present: 0,
				minutesRecipients: 2,
			});

			// The link is what the caller is meant to hand over. Absolute, so a person
			// reading it in a chat client can open it.
			expect(p.confirmUrl).toMatch(
				new RegExp(`^https?://[^/]+/guest-book/${p.pendingId}$`),
			);

			// ONE pending row, carrying the transcription and a stable id per line.
			const pending = await pendingRows();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.id).toBe(p.pendingId);
			expect(pending[0]?.createdByUserId).toBe(seed.adminUserId);
			expect(pending[0]?.meetingDate).toBe(pastMeetingDate);
			expect(pending[0]?.appliedAt).toBeNull();
			expect(pending[0]?.entries).toHaveLength(3);
			const ids = (pending[0]?.entries ?? []).map((e) => e.id);
			expect(new Set(ids).size).toBe(3);

			// And the only club rows are the one that was already there.
			expect(await guestRows()).toHaveLength(1);
			expect(await attendanceRows()).toHaveLength(0);
		});

		it("masks the contact details it returns, and stores them unmasked", async () => {
			const p = (await call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Vera Real", email: "vera@example.com" }],
			})) as Preview;

			// What leaves the server is masked — the result goes into an LLM
			// provider's transcript.
			expect(p.entries?.[0]?.emailMasked).toBe("v•••@example.com");
			expect(JSON.stringify(p.entries)).not.toContain("vera@example.com");

			// What is STORED is the real value: the confirm page's whole job is
			// letting a human check it against the paper page.
			const [pending] = await pendingRows();
			expect(pending?.entries?.[0]?.email).toBe("vera@example.com");
		});

		// --- AC1: the old apply contract is refused --------------------------

		it("refuses a call carrying a planHash, names the web flow, and writes nothing", async () => {
			const p = (await call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Stale Client" }],
			})) as Preview;

			const err = await call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Stale Client" }],
				planHash: p.planHash,
			}).then(
				() => null,
				(e: unknown) => e as { code: string; message: string },
			);

			expect(err?.code).toBe("VALIDATION");
			// The refusal has to say where applying happens now, or a caller written
			// against the old two-call contract has nothing to do next.
			expect(err?.message).toContain("confirmUrl");
			expect(await guestRows()).toHaveLength(0);
			expect(await attendanceRows()).toHaveLength(0);
			// And the refusal came BEFORE anything was stored: still one row, the
			// preview's own.
			expect(await pendingRows()).toHaveLength(1);
		});

		// --- the hash is stable under unrelated writes -----------------------

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

		// --- blocking items ---------------------------------------------------

		it("blocks an email address it cannot parse", async () => {
			// A guest marked present becomes a default recipient of the minutes email,
			// and `resolveMinutesRecipients` only checks the string is non-empty. This
			// path is fed by an LLM reading handwriting, so it is the one most likely
			// to produce a malformed address — and it was the only guest-writing path
			// not validating the format. The refusal to APPLY while it stands is
			// asserted in `guest-book-confirm.integration.test.ts`.
			const p = (await call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Smudged Line", email: "jane at example dot com" }],
			})) as Preview;
			expect(p.blocking[0]).toMatchObject({
				code: "INVALID_EMAIL",
				entryIndex: 0,
			});
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

		it("reports an ambiguous line with MASKED candidates", async () => {
			// A shared number under a name that does not agree: #488 says these are
			// two prospects, and a transcriber gets asked rather than guessed at.
			//
			// The candidates are the one thing in this result the caller did NOT send
			// — they are guests already on file — so masking them is the half of D9
			// that still protects something. `toPublicBlocking` is what does it, and
			// it is a SEPARATE projection from `toPublicPlan` because `blocking` is a
			// sibling of the plan rather than a field inside it.
			await testDb.insert(guests).values({
				clubId: seed.clubId,
				name: "Samir Patel",
				phone: "+15551234567",
				email: "samir@example.com",
				stage: "prospect",
			});

			const p = (await call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Priya Raman", phone: "+1 555 123 4567" }],
			})) as Preview;

			expect(p.entries?.[0]?.outcome).toBe("ambiguous");
			expect(p.blocking[0]).toMatchObject({
				code: "AMBIGUOUS_GUEST",
				entryIndex: 0,
			});
			const serialized = JSON.stringify(p.blocking);
			expect(serialized).not.toContain("5551234567");
			expect(serialized).not.toContain("samir@example.com");
			expect(serialized).toContain("s•••@example.com");
			expect(await guestRows()).toHaveLength(1);
			expect(await attendanceRows()).toHaveLength(0);
		});

		// --- AC13 / AC3: which meeting ---------------------------------------

		it("refuses a FUTURE meeting as NOT_RECORDABLE, and stores no pending row", async () => {
			// Attendance is the RECORD of who was in the room; a future-dated row is
			// a false fact that reaches the minutes PDF and the minutes email.
			//
			// Nothing is stored either: a confirm link whose only possible content is
			// "this meeting has not happened" is a link with nothing to confirm. The
			// page still renders that state, because a meeting can be rescheduled
			// forward AFTER a preview — see the confirm suite.
			const { utcToZonedWallTime } = await import("#/lib/datetime");
			const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
			await expect(
				call({
					clubId: seed.clubId,
					meetingDate: utcToZonedWallTime(future, "America/Chicago").slice(
						0,
						10,
					),
					entries: [{ name: "Too Early" }],
				}),
			).rejects.toMatchObject({ code: "NOT_RECORDABLE" });
			expect(await guestRows()).toHaveLength(0);
			expect(await pendingRows()).toHaveLength(0);
		});

		it("blocks a date with NO meeting, and still stores the page", async () => {
			// AC3. This one DOES get a row and a link: which meeting a page belongs to
			// is a question the maintainer can answer, and the confirm page is where
			// they see it asked. Throwing here would lose the transcription.
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
			expect(p.confirmUrl).toContain(p.pendingId);

			const pending = await pendingRows();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.meetingDate).toBe("2001-01-01");
			expect(await guestRows()).toHaveLength(0);
		});

		it("blocks a date with TWO meetings, and still stores the page", async () => {
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
			expect(await pendingRows()).toHaveLength(1);
			expect(await guestRows()).toHaveLength(0);
		});

		it("carries a caller's resolve answers onto the stored entries", async () => {
			// The positional `resolve` map stops existing the moment the row is
			// written: the confirm page holds answers per ENTRY, because dropping a
			// line renumbers every position after it.
			await testDb.insert(guests).values({
				clubId: seed.clubId,
				name: "Samir Patel",
				phone: "+15551234567",
				stage: "prospect",
			});
			const p = (await call({
				clubId: seed.clubId,
				meetingDate: pastMeetingDate,
				entries: [{ name: "Priya Raman", phone: "+1 555 123 4567" }],
				resolve: { "0": "new" },
			})) as Preview;

			expect(p.blocking).toEqual([]);
			expect(p.entries?.[0]?.outcome).toBe("new");
			const [pending] = await pendingRows();
			expect(pending?.entries?.[0]?.resolve).toEqual({ kind: "new" });
		});
	},
);
