/**
 * The meeting-meta PATCH writer (#772).
 *
 * `applyMeetingUpdate` was a full REPLACE: it wrote `theme: input.theme?.trim()
 * || null` and the identical line for six more free-text fields, so an OMITTED
 * field was not "leave it alone", it was *null it*. Every partial editor had to
 * echo six values back (`themeOnlyUpdate`) or silently erase them, and because
 * that echo was a page-load SNAPSHOT it also made a theme save a LOST UPDATE
 * over a Word of the Day another officer had saved in the meantime.
 *
 * `applyMeetingMetaPatch` replaces it with three states per field:
 *
 *   undefined / absent  → unchanged
 *   null or blank       → cleared
 *   a value             → stored, trimmed
 *
 * These assert against the stored COLUMN, never against a payload: a writer
 * that ignored its input would satisfy any payload-shaped assertion.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-meta-patch.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMeetingMetaPatch, applyWordOfTheDayUpdate } = await import(
	"./meetings-logic"
);

/** Every free-text column the patch writer owns, with a stored value to protect. */
const STORED = {
	theme: "Stored theme",
	location: "The Old Library, Room 5",
	joinUrl: "https://zoom.us/j/1234567890",
	wordOfTheDay: "ineffable",
	wodDefinition: "too great to be expressed in words",
	wodExample: "the ineffable joy of a clean build",
	notes: "Bring the timing cards.",
	reminders: "Dues are due Friday.",
} as const;

type MetaField = keyof typeof STORED;
const FIELDS = Object.keys(STORED) as MetaField[];

describe.skipIf(!hasTestDb)("applyMeetingMetaPatch", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		await testDb
			.update(meetings)
			.set(STORED)
			.where(eq(meetings.id, club.meetingId));
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function metaOf() {
		const [m] = await testDb
			.select({
				theme: meetings.theme,
				location: meetings.location,
				joinUrl: meetings.joinUrl,
				wordOfTheDay: meetings.wordOfTheDay,
				wodDefinition: meetings.wodDefinition,
				wodExample: meetings.wodExample,
				notes: meetings.notes,
				reminders: meetings.reminders,
			})
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		return m;
	}

	/**
	 * THE point of the issue. A one-field editor posts `{ meetingId, theme }` and
	 * nothing else; every other column must still be there afterwards. Under the
	 * old writer all seven were null and the save reported success.
	 */
	it("leaves every omitted field exactly as it was", async () => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			theme: "New beginnings",
		});
		const after = await metaOf();
		expect(after.theme).toBe("New beginnings");
		for (const field of FIELDS.filter((f) => f !== "theme")) {
			expect(after[field], `${field} must survive a theme-only patch`).toBe(
				STORED[field],
			);
		}
	});
	/** The other two states, per field. `null` is the contract the issue names;
	 *  blank is what an officer clearing an input actually sends, and the two must
	 *  agree or the dialog's clear button becomes a no-op. */
	it.each(FIELDS)("clears %s when passed null", async (field) => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			[field]: null,
		});
		expect((await metaOf())[field]).toBeNull();
	});

	it.each(FIELDS)("clears %s when passed a blank string", async (field) => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			[field]: "   ",
		});
		expect((await metaOf())[field]).toBeNull();
	});

	it("trims a stored value", async () => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			theme: "  New beginnings  ",
		});
		expect((await metaOf()).theme).toBe("New beginnings");
	});

	/**
	 * `scheduledAt` was REQUIRED, and that was the trap with teeth: a partial
	 * editor had to resubmit the meeting's current wall time to the MINUTE or the
	 * `canReschedule` comparison rejected the save as an attempted reschedule.
	 * Omitting it is now the ordinary case, and reaches that check as "no move".
	 */
	describe("the time", () => {
		async function timeOf() {
			const [m] = await testDb
				.select({
					scheduledAt: meetings.scheduledAt,
					lengthMinutes: meetings.lengthMinutes,
				})
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			return m;
		}

		it("stays put when the patch omits it", async () => {
			const before = await timeOf();
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				theme: "New beginnings",
			});
			expect((await timeOf()).scheduledAt).toEqual(before.scheduledAt);
		});

		it("lets a self-serve TMOD save meta without resubmitting it", async () => {
			// The whole shape of the old bug: `canReschedule: false` plus a
			// `scheduledAt` that was off by a second threw "Only an admin or VP
			// Education can reschedule this meeting." on a theme save.
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				canReschedule: false,
				theme: "New beginnings",
			});
			expect((await metaOf()).theme).toBe("New beginnings");
		});

		it("still refuses a TMOD who actually moves it", async () => {
			await expect(
				applyMeetingMetaPatch({
					meetingId: club.meetingId,
					actorMemberId: club.memberId,
					canReschedule: false,
					scheduledAt: "2031-01-02T09:15",
				}),
			).rejects.toThrow(/reschedule/i);
		});

		it("still refuses a TMOD who changes the length", async () => {
			await expect(
				applyMeetingMetaPatch({
					meetingId: club.meetingId,
					actorMemberId: club.memberId,
					canReschedule: false,
					lengthMinutes: 45,
				}),
			).rejects.toThrow(/reschedule/i);
		});
	});
	/**
	 * THE lost update, recorded in `TODOS/theme-word-subroutes-666.md` before it
	 * was fixable. The old echo carried six values captured ONCE at page load and
	 * the route never revalidated, so:
	 *
	 *   1. the Toastmaster opens `…/me/theme`; the loader snapshots an empty WOD
	 *   2. the Grammarian opens `…/me/word` and saves "ineffable"
	 *   3. the Toastmaster types a theme and saves
	 *   4. the snapshot is written back and the Word of the Day is GONE
	 *
	 * Both are pre-meeting duties usually done the same evening from one shared
	 * link, so the interleave is ordinary. The patch cannot reproduce it: a
	 * column the caller did not send is absent from the SQL, not rewritten with
	 * what the caller believed was current.
	 */
	it("does not revert a field another officer saved after the page loaded", async () => {
		await testDb
			.update(meetings)
			.set({ wordOfTheDay: null, wodDefinition: null })
			.where(eq(meetings.id, club.meetingId));

		// (2) the Grammarian's save, through its own narrow writer.
		await applyWordOfTheDayUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			wordOfTheDay: "ineffable",
			wodDefinition: "too great to be expressed in words",
		});

		// (3) the Toastmaster's save, built from the STALE page — which now means
		// "the fields I am editing", and nothing else.
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			theme: "New beginnings",
		});

		const after = await metaOf();
		expect(after.theme).toBe("New beginnings");
		expect(after.wordOfTheDay).toBe("ineffable");
		expect(after.wodDefinition).toBe("too great to be expressed in words");
	});

	/**
	 * The audit entry is the diff, not the row. A `before`/`after` pair naming
	 * nine columns of which one moved cannot be read, and — now that untouched
	 * columns are absent from the write — would claim the writer touched them.
	 */
	describe("the meeting_edit entry", () => {
		async function detailOf() {
			const [entry] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(eq(activityLog.action, "meeting_edit"));
			return entry?.detail as
				| { before: Record<string, unknown>; after: Record<string, unknown> }
				| undefined;
		}

		it("names only the fields the patch changed, with their prior values", async () => {
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				theme: "New beginnings",
			});
			const detail = await detailOf();
			expect(Object.keys(detail?.after ?? {})).toEqual(["theme"]);
			expect(detail?.before).toEqual({ theme: STORED.theme });
			expect(detail?.after).toEqual({ theme: "New beginnings" });
		});

		it("is not written at all for a patch with no fields in it", async () => {
			// A save with nothing in it is not an edit, and drizzle rejects a `set`
			// with no keys — so the guard has to exist either way.
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			});
			expect(await detailOf()).toBeUndefined();
			expect((await metaOf()).theme).toBe(STORED.theme);
		});
	});
});
