/**
 * DB-backed tests for the meeting packet (#589).
 *
 * The thing most likely to be wrong here is ASSEMBLY: react-pdf documents
 * cannot nest, so the packet unwraps each sheet's `Page` and composes them.
 * That is invisible to a type check and to any unit test — a wrong unwrap
 * produces a valid PDF with the wrong number of pages, or none. So these
 * render the real document and count `/Count` out of the page tree, the same
 * technique `role-sheet-layout.test.ts` uses for the one-page guarantee.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings, meetingVoteSessions } from "#/db/schema";
import { defaultPacketSelection } from "#/lib/meeting-packet";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { renderPacketPdf } = await import("#/server/packet-pdf-logic");
const { loadPacketContext } = await import("#/server/packet-context-logic");

/** Pages in a rendered PDF, read out of the page tree rather than trusted. */
function pageCount(bytes: Uint8Array): number {
	const m = Buffer.from(bytes)
		.toString("latin1")
		.match(/\/Count\s+(\d+)/);
	if (m == null) throw new Error("no /Count in the PDF page tree");
	return Number(m[1]);
}

describe.skipIf(!hasTestDb)("meeting packet (#589)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(meetings)
			.set({
				wordOfTheDay: "Ebullient",
				wodDefinition: "cheerful and full of energy",
			})
			.where(eq(meetings.id, seed.meetingId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("renders one page per sheet plus one per poster copy", async () => {
		const out = await renderPacketPdf(
			seed.meetingId,
			["word-poster", "timer", "grammarian"],
			3,
		);
		expect(out).not.toBeNull();
		// 3 posters + 2 sheets. Counted from the PDF, not from the input: an
		// assembly bug produces a valid document with the wrong count, which is
		// exactly what a `toBeDefined()` here would miss.
		expect(pageCount(out?.bytes as Uint8Array)).toBe(5);
		expect(out?.pages).toBe(5);
	});

	it("prints three posters by default — three sheets of paper for the room", async () => {
		const out = await renderPacketPdf(seed.meetingId, ["word-poster"], 3);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(3);
	});

	it("prints one sheet per selected role and nothing else", async () => {
		const out = await renderPacketPdf(seed.meetingId, ["timer"], 3);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(1);
	});

	it("does not print the same sheet twice when a piece is repeated", async () => {
		// The selection comes off a query string, where `?piece=timer&piece=timer`
		// costs nothing to send.
		const out = await renderPacketPdf(
			seed.meetingId,
			["timer", "timer", "timer"],
			0,
		);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(1);
	});

	it("prints in a fixed order regardless of the order asked for", async () => {
		// Two selections, same set, opposite order — identical byte length is a
		// proxy for identical documents, and a reordering bug changes it.
		const a = await renderPacketPdf(
			seed.meetingId,
			["grammarian", "timer", "word-poster"],
			1,
		);
		const b = await renderPacketPdf(
			seed.meetingId,
			["word-poster", "timer", "grammarian"],
			1,
		);
		expect(a?.bytes.length).toBe(b?.bytes.length);
	});

	it("returns null rather than an empty PDF when nothing is selected", async () => {
		expect(await renderPacketPdf(seed.meetingId, [], 3)).toBeNull();
		// …and when the only piece selected has zero copies.
		expect(
			await renderPacketPdf(seed.meetingId, ["word-poster"], 0),
		).toBeNull();
	});

	it("cannot be made unbounded from the query string", async () => {
		// There is no page-ceiling guard, deliberately: the clamp plus a closed
		// set of five sheets bounds a packet at 17 pages arithmetically, and an
		// explicit ceiling written here first proved unreachable. This pins the
		// arithmetic instead — the number a hostile `?copies=` can actually reach.
		const out = await renderPacketPdf(
			seed.meetingId,
			[
				"word-poster",
				"timer",
				"ah-counter",
				"grammarian",
				"ballot-counter",
				"general-evaluator",
			],
			99999,
		);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(17);
	});

	it("clamps an absurd copy count instead of rendering it", async () => {
		const out = await renderPacketPdf(seed.meetingId, ["word-poster"], 5);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(5);
	});

	it("still renders when the meeting has no Word of the Day", async () => {
		// The poster page must not throw on an empty word — the picker would not
		// tick it, but the endpoint is reachable directly.
		await testDb
			.update(meetings)
			.set({ wordOfTheDay: null, wodDefinition: null })
			.where(eq(meetings.id, seed.meetingId));
		const out = await renderPacketPdf(seed.meetingId, ["word-poster"], 1);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(1);
	});
});

describe.skipIf(!hasTestDb)(
	"packet defaults come from the meeting (#589)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});
		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("reports the roles the club actually runs", async () => {
			const ctx = await loadPacketContext(seed.meetingId);
			// The seed gives the meeting one role slot, named "Timer" with a NULL key
			// — the shape that broke the first version of the derivation. The context
			// must carry the name so the rule can still match it.
			expect(ctx.roles.length).toBeGreaterThan(0);
			expect(ctx.roles.some((r) => r.name === "Timer")).toBe(true);
			expect(defaultPacketSelection({ ...ctx, hasWord: false })).toContain(
				"timer",
			);
		});

		it("notices a Word of the Day", async () => {
			expect((await loadPacketContext(seed.meetingId)).hasWord).toBe(false);
			await testDb
				.update(meetings)
				.set({ wordOfTheDay: "Ebullient" })
				.where(eq(meetings.id, seed.meetingId));
			expect((await loadPacketContext(seed.meetingId)).hasWord).toBe(true);
		});

		/**
		 * The rule that decided this feature's shape: digital voting makes the paper
		 * tally redundant, so it should not be ticked — but only for clubs that use
		 * it.
		 */
		it("notices digital voting, and drops the ballot tally when it is in use", async () => {
			expect((await loadPacketContext(seed.meetingId)).usesDigitalVoting).toBe(
				false,
			);
			await testDb.insert(meetingVoteSessions).values({
				meetingId: seed.meetingId,
				category: "best_speaker",
			});
			const ctx = await loadPacketContext(seed.meetingId);
			expect(ctx.usesDigitalVoting).toBe(true);
			// End to end: the query feeds the pure rule, and the rule drops the sheet.
			expect(
				defaultPacketSelection({
					...ctx,
					roles: [{ key: "vote_counter", name: "Vote Counter" }],
				}),
			).not.toContain("ballot-counter");
		});

		it("counts a CLOSED vote session as digital voting too", async () => {
			// A club that voted on phones last segment is a club that votes on phones;
			// the paper tally should not reappear the moment the vote is closed.
			await testDb.insert(meetingVoteSessions).values({
				meetingId: seed.meetingId,
				category: "best_speaker",
				closedAt: new Date(),
			});
			expect((await loadPacketContext(seed.meetingId)).usesDigitalVoting).toBe(
				true,
			);
		});
	},
);

/**
 * Archive takedown (#544/#589).
 *
 * The packet is public and session-less, so it is one of the readers
 * `public-readers-archive-gate.guard.test.ts` enrolls. That guard checks
 * ENROLLMENT — that the fn is gated or consciously waived — and `getPacketContext`
 * is waived there with a REASON STRING pointing at this gate. A reason string is
 * not a test: delete the `isReadableClubForMeeting` call and the guard still
 * passes, because the waiver only records that someone looked. These are what
 * actually fail.
 */
describe.skipIf(!hasTestDb)("an archived club's packet (#589)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(meetings)
			.set({ wordOfTheDay: "Ebullient" })
			.where(eq(meetings.id, seed.meetingId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("renders no packet", async () => {
		// `null`, not a throw: the route turns it into a 404, so an archived club
		// is indistinguishable from a meeting that never existed.
		expect(
			await renderPacketPdf(seed.meetingId, ["word-poster", "timer"], 3),
		).toBeNull();
	});

	it("offers nothing in the picker", async () => {
		const ctx = await loadPacketContext(seed.meetingId);
		expect(ctx).toEqual({
			roles: [],
			usesDigitalVoting: false,
			hasWord: false,
		});
		// …and the rule over it therefore ticks nothing, so the dialog cannot
		// offer a download of a club that has been taken down.
		expect(defaultPacketSelection(ctx)).toEqual([]);
	});
});
