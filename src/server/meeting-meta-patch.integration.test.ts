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
import { and, desc, eq } from "drizzle-orm";
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

	/**
	 * Each field stores ITS OWN input. The two clear cases above are satisfied by
	 * writing null from any source, and the trim case below covers `theme` alone —
	 * so without this, mutating the writer's loop body to
	 * `next[field] = input.theme?.trim() || null` (every column takes the theme's
	 * value) left all eight meeting-meta suites green. MEASURED. That mutation is
	 * exactly what the refactor made possible: seven hand-written lines naming
	 * their own field became one loop over a list.
	 *
	 * The per-field distinct value is what makes a crossed field fail.
	 */
	it.each(FIELDS)("stores %s from its own input", async (field) => {
		// `joinUrl` is normalized, so give it a value that survives the URL
		// validator rather than the prose the other seven take.
		const value =
			field === "joinUrl"
				? "https://meet.google.com/abc-defg-hij"
				: `fresh ${field}`;
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			[field]: value,
		});
		expect((await metaOf())[field]).toBe(value);
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

		/**
		 * The two NUMERIC fields are waived from the guard sweep, and they disagree
		 * with each other on what `null` means — so nothing pinned either half
		 * until now. `meetingNumber: null` CLEARS (back to derived numbering,
		 * #358); `lengthMinutes: null` is UNCHANGED, because `length_minutes` is
		 * `notNull().default(90)` and there is nothing to clear to. A future author
		 * tidying `!= null` into `!== undefined` for consistency with the seven
		 * text fields would write NULL into a NOT NULL column; this is what fails.
		 */
		it("clears the meeting number when passed null", async () => {
			await testDb
				.update(meetings)
				.set({ meetingNumber: 56 })
				.where(eq(meetings.id, club.meetingId));
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				meetingNumber: null,
			});
			const [m] = await testDb
				.select({ n: meetings.meetingNumber })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			expect(m.n).toBeNull();
		});

		it("treats an explicit null length as UNCHANGED, not as a clear", async () => {
			await testDb
				.update(meetings)
				.set({ lengthMinutes: 45 })
				.where(eq(meetings.id, club.meetingId));
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				// CAST, and the cast is the point. `lengthMinutes?: number` makes this
				// state unrepresentable in TypeScript and `updateMeetingSchema` has no
				// `.nullable()` on it either, so a typed caller cannot reach here —
				// but a JSON caller can (the MCP tool surface, #771, parses untyped
				// input), and `length_minutes` is `notNull()`. This pins the third
				// layer: the writer's own `!= null` must drop it rather than write
				// NULL into a NOT NULL column. Tidying that to `!== undefined` for
				// consistency with the seven text fields is what fails here.
				lengthMinutes: null as unknown as number,
			});
			expect((await timeOf()).lengthMinutes).toBe(45);
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
	 * The meeting number is ADMIN-ONLY, and until #792 it was admin-only in the
	 * DIALOG only — `applyMeetingMetaPatch` applied it with no privilege check at
	 * all, and the `canReschedule` arm above covered `scheduledAt` and
	 * `lengthMinutes` and nothing else.
	 *
	 * Why it is worse than a one-row edit. `deriveMeetingNumber` treats a stored
	 * number as the ANCHOR later meetings count forward from, so one write
	 * renumbers every later un-numbered meeting in the club, and `null`
	 * un-anchors a number an admin had frozen. And the grant it rode is the
	 * widest one here: `resolveMeetingAgendaAuthz`'s `tmod-self-assert` arm needs
	 * NO SESSION — it matches a self-asserted `selfMemberId` against the
	 * meeting's Toastmaster slot, and the #317 identity gate hands an anonymous
	 * link-holder the roster to pick that id from. So the club's numbering was
	 * writable by anyone holding a meeting's public link.
	 *
	 * These assert the STORED column after each refusal, not just the throw: a
	 * guard placed after the UPDATE would satisfy `rejects.toThrow` and still
	 * have renumbered the club.
	 */
	describe("the meeting number is admin-only", () => {
		async function numberOf() {
			const [m] = await testDb
				.select({ n: meetings.meetingNumber })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			return m.n;
		}
		async function storeNumber(n: number | null) {
			await testDb
				.update(meetings)
				.set({ meetingNumber: n })
				.where(eq(meetings.id, club.meetingId));
		}

		it("refuses a self-serve TMOD who sets one", async () => {
			await expect(
				applyMeetingMetaPatch({
					meetingId: club.meetingId,
					actorMemberId: club.memberId,
					canReschedule: false,
					meetingNumber: 56,
				}),
			).rejects.toThrow();
			expect(await numberOf()).toBeNull();
		});

		/**
		 * The other direction, and the one a "can't set a number" fix written from
		 * the title alone would miss: passing `null` CLEARS the anchor. A club
		 * whose VPE had frozen #56 onto a completed meeting loses it, and every
		 * meeting after it falls back to the previous anchor — or to no number at
		 * all when there is none.
		 */
		it("refuses a self-serve TMOD who clears one", async () => {
			await storeNumber(56);
			await expect(
				applyMeetingMetaPatch({
					meetingId: club.meetingId,
					actorMemberId: club.memberId,
					canReschedule: false,
					meetingNumber: null,
				}),
			).rejects.toThrow();
			expect(await numberOf()).toBe(56);
		});

		/**
		 * PRESENCE, not change — deliberately stricter than the reschedule check
		 * beside it, which forgives a resubmitted time because the dialog sends one
		 * on every save. No non-admin surface sends a number at all (the input
		 * lives inside the dialog's `canReschedule` branch, and
		 * `meetingUpdateFromForm` maps an unrendered input to `undefined`), so
		 * there is no resubmit to forgive.
		 *
		 * It also pins WHERE the check sits: before the unchanged-key drop, which
		 * is what makes it read what the caller SENT. Moving it after that drop
		 * would let this case through — harmless on its own, but the same move
		 * makes the guard depend on a normalization step rather than on the input.
		 */
		it("refuses a TMOD resubmitting the number already stored", async () => {
			await storeNumber(56);
			await expect(
				applyMeetingMetaPatch({
					meetingId: club.meetingId,
					actorMemberId: club.memberId,
					canReschedule: false,
					meetingNumber: 56,
				}),
			).rejects.toThrow();
			expect(await numberOf()).toBe(56);
		});

		/** A refused number takes the whole patch with it. The realistic payload is
		 *  mixed — a forged save would carry the theme the TMOD may edit alongside
		 *  the number they may not — and a guard that ran after the UPDATE would
		 *  leave the legal half written and report failure. */
		it("writes nothing when a refused number rides along with a legal edit", async () => {
			await expect(
				applyMeetingMetaPatch({
					meetingId: club.meetingId,
					actorMemberId: club.memberId,
					canReschedule: false,
					theme: "New beginnings",
					meetingNumber: 56,
				}),
			).rejects.toThrow();
			expect(await numberOf()).toBeNull();
			expect((await metaOf()).theme).toBe(STORED.theme);
		});

		/** Says what was refused. An officer told they may not "reschedule" after
		 *  touching a number would go looking for a date they never typed, so the
		 *  number gets its own message rather than reusing the one below it. */
		it("names the number, not a reschedule", async () => {
			const err = await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				canReschedule: false,
				meetingNumber: 56,
			}).then(
				() => null,
				(e: Error) => e,
			);
			expect(err, "the patch resolved instead of refusing").not.toBeNull();
			expect(err?.message).toMatch(/number/i);
			expect(err?.message).not.toMatch(/reschedule/i);
		});

		/**
		 * The positive control, and it is not decoration: a writer that refused
		 * `meetingNumber` unconditionally satisfies every assertion above while
		 * breaking the #358 workflow the field exists for (the VPE types the club's
		 * last real number and the meetings after it renumber themselves).
		 */
		it("still lets an admin set one", async () => {
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
				meetingNumber: 56,
			});
			expect(await numberOf()).toBe(56);
		});

		/** The over-broad control: the gate is on the FIELD, not on the meeting. A
		 *  TMOD's ordinary meta save must still land on a numbered meeting. */
		it("still lets a TMOD edit meta on a numbered meeting", async () => {
			await storeNumber(56);
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				canReschedule: false,
				theme: "New beginnings",
			});
			expect((await metaOf()).theme).toBe("New beginnings");
			expect(await numberOf()).toBe(56);
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
			// SCOPED to this run's club and meeting, and ordered. vitest runs test
			// FILES in parallel against one shared `tm_test` and three other suites
			// write `meeting_edit`, so an unscoped read here returns another file's
			// row — measured: it picked up a `notes`-only patch from
			// `personal-duty-edit` and failed. Worse for the absence assertion
			// below, which any concurrent entry satisfies.
			const [entry] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.action, "meeting_edit"),
						eq(activityLog.clubId, club.clubId),
						eq(activityLog.targetId, club.meetingId),
					),
				)
				.orderBy(desc(activityLog.createdAt))
				.limit(1);
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

		/**
		 * The case the one-field assertion above cannot reach. The Edit-meeting
		 * dialog prefills every input from the row and resubmits the lot, so the
		 * writer receives all eleven keys on a save that changed one — and before
		 * the unchanged-key drop, the entry named all eleven. That is the pre-#772
		 * full-row snapshot by another route, and it is what stops an officer
		 * reading the activity log from telling which entry moved the location.
		 */
		it("names one field for a DIALOG-shaped save that changed one", async () => {
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				// Every stored value resubmitted unchanged, exactly as the dialog
				// does, with one field altered.
				theme: "New beginnings",
				location: STORED.location,
				joinUrl: STORED.joinUrl,
				wordOfTheDay: STORED.wordOfTheDay,
				wodDefinition: STORED.wodDefinition,
				wodExample: STORED.wodExample,
				notes: STORED.notes,
				reminders: STORED.reminders,
			});
			const detail = await detailOf();
			expect(Object.keys(detail?.after ?? {})).toEqual(["theme"]);
			expect(detail?.before).toEqual({ theme: STORED.theme });
		});

		it("is not written at all for a patch that changes nothing", async () => {
			// Every field resubmitted at its stored value — the dialog save where the
			// officer opened it and pressed Save without typing.
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				theme: STORED.theme,
				location: STORED.location,
				notes: STORED.notes,
			});
			expect(await detailOf()).toBeUndefined();
			expect((await metaOf()).theme).toBe(STORED.theme);
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
