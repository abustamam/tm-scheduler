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
import { Document, Page, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import { clubs, meetings, meetingVoteSessions } from "#/db/schema";
import {
	defaultPacketSelection,
	PACKET_PIECES,
	WORD_POSTER_COPIES,
} from "#/lib/meeting-packet";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { renderPacketPdf, withDuplexBlanks } = await import(
	"#/server/packet-pdf-logic"
);
const { Route: packetRoute } = await import(
	"#/routes/api/meetings.$id.packet.pdf"
);
const { loadPacketContext } = await import("#/server/packet-context-logic");

/** Pages in a rendered PDF, read out of the page tree rather than trusted. */
function pageCount(bytes: Uint8Array): number {
	const m = Buffer.from(bytes)
		.toString("latin1")
		.match(/\/Count\s+(\d+)/);
	if (m == null) throw new Error("no /Count in the PDF page tree");
	return Number(m[1]);
}

/** The MediaBox of every page, in document order, read out of the PDF. */
function mediaBoxes(bytes: Uint8Array): string[] {
	return [
		...Buffer.from(bytes)
			.toString("latin1")
			.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g),
	].map((m) => (m[1] as string).trim().replace(/\s+/g, " "));
}

// No database: this is about the blank's SHAPE. Every packet page is portrait
// today, so the render-level test below cannot tell "copied the previous page's
// orientation" from "always portrait". A landscape page can.
describe("duplex blanks copy the page before them (#1166)", () => {
	it("a blank after a landscape page is landscape, after a portrait page portrait", async () => {
		const pages = withDuplexBlanks([
			h(Page, { key: "a", size: "LETTER", orientation: "landscape" }),
			h(Page, { key: "b", size: "LETTER" }),
			h(Page, { key: "c", size: "LETTER", orientation: "landscape" }),
		]);
		expect(pages).toHaveLength(5);
		const buf = await renderToBuffer(
			h(Document, {}, ...pages) as Parameters<typeof renderToBuffer>[0],
		);
		expect(mediaBoxes(new Uint8Array(buf))).toEqual([
			"0 0 792 612",
			"0 0 792 612",
			"0 0 612 792",
			"0 0 612 792",
			"0 0 792 612",
		]);
	});
});

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

	// EVERY piece, enumerated from the registry rather than listed here — a
	// packet of exactly one piece is a real request, because the picker lets a
	// club untick everything else.
	//
	// This is the shape that shipped broken (#719): the renderer held a SECOND,
	// hand-written copy of the sheet list with `toastmaster` missing from it, so
	// the picker ticked the Toastmaster's script, the route accepted
	// `?piece=toastmaster`, and the packet came back 404 "Meeting not found."
	// Nothing downstream could betray it — `packetPageCount` runs AFTER the drop,
	// so the reported page count agreed with the sheet that was never rendered.
	// A test that restates the list by hand agrees with whichever copy its author
	// was reading, which is why this one cannot.
	it.each(
		PACKET_PIECES.map((p) => p.key),
	)("renders a page for a packet of nothing but %s", async (key) => {
		const out = await renderPacketPdf(seed.meetingId, [key], 1);
		expect(out).not.toBeNull();
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
		// set of six sheets bounds a packet at 18 pages arithmetically, and an
		// explicit ceiling written here first proved unreachable. This pins the
		// arithmetic instead — the number a hostile `?copies=` can actually reach.
		//
		// The selection is ENUMERATED FROM THE REGISTRY, never listed here. This
		// test claimed to pin the MAXIMUM packet while hand-listing five sheets,
		// and was numerically correct only because the renderer was dropping the
		// sixth: both copies of the list were wrong in the same direction, so the
		// gate read green over a 404. A hand-written maximum can only ever be as
		// complete as its author's memory of the registry.
		const everything = PACKET_PIECES.map((p) => p.key);
		const ceiling = ROLE_SHEETS.length + WORD_POSTER_COPIES.max;
		// Stated twice on purpose. The derivation is what makes the assertion
		// below unable to go blind; the literal is the number `packet-pdf-logic.ts`
		// claims in prose, so a seventh sheet fails HERE and sends someone to that
		// docblock rather than letting it quietly go stale.
		expect(ceiling).toBe(18);
		const out = await renderPacketPdf(seed.meetingId, everything, 99999);
		expect(pageCount(out?.bytes as Uint8Array)).toBe(ceiling);
		// Double-sided adds a blank after every page but the last: 2n - 1.
		const duplex = await renderPacketPdf(
			seed.meetingId,
			everything,
			99999,
			true,
		);
		expect(pageCount(duplex?.bytes as Uint8Array)).toBe(2 * ceiling - 1);
	});

	// #1166. A blank after every page but the last, so a duplex printer does not
	// put one sheet on the back of the next.
	describe("duplex (#1166)", () => {
		it("two sheets print as sheet, blank, sheet; without duplex, two pages", async () => {
			const two = ["timer", "grammarian"] as const;
			const plain = await renderPacketPdf(seed.meetingId, [...two], 1);
			expect(pageCount(plain?.bytes as Uint8Array)).toBe(2);
			const duplex = await renderPacketPdf(seed.meetingId, [...two], 1, true);
			expect(pageCount(duplex?.bytes as Uint8Array)).toBe(3);
			expect(duplex?.pages).toBe(3);
		});

		it("poster x3 plus six sheets is 17 pages: blanks between poster copies too", async () => {
			const everything = PACKET_PIECES.map((p) => p.key);
			const out = await renderPacketPdf(seed.meetingId, everything, 3, true);
			expect(pageCount(out?.bytes as Uint8Array)).toBe(17);
			expect(out?.pages).toBe(17);
		});

		it("puts no blank after the last page, and none in a one-page packet", async () => {
			const one = await renderPacketPdf(seed.meetingId, ["timer"], 1, true);
			expect(pageCount(one?.bytes as Uint8Array)).toBe(1);
			// Alternating content, blank, content, … ending on content: with the
			// poster first (landscape or not), every odd-indexed page is a blank.
			const out = await renderPacketPdf(
				seed.meetingId,
				["word-poster", "timer"],
				2,
				true,
			);
			expect(pageCount(out?.bytes as Uint8Array)).toBe(5);
		});

		it("every blank has the size and orientation of the page before it", async () => {
			const everything = PACKET_PIECES.map((p) => p.key);
			const out = await renderPacketPdf(seed.meetingId, everything, 3, true);
			const boxes = mediaBoxes(out?.bytes as Uint8Array);
			expect(boxes).toHaveLength(17);
			// Odd indexes are the blanks (content pages sit at 0, 2, 4, …).
			for (let i = 1; i < boxes.length; i += 2) {
				expect(boxes[i], `blank page ${i}`).toBe(boxes[i - 1]);
			}
			// And the blanks really are there: a box list for a packet with no
			// blanks would pass the loop above vacuously only if it were empty.
			expect(boxes.filter((_, i) => i % 2 === 1)).toHaveLength(8);
		});
	});

	// The endpoint, since `?duplex=1` is parsed there and nowhere else.
	describe("GET /api/meetings/:id/packet/pdf?duplex (#1166)", () => {
		async function get(query: string): Promise<Response> {
			const handlers = (
				packetRoute.options as unknown as {
					server: {
						handlers: {
							GET: (ctx: {
								params: { id: string };
								request: Request;
							}) => Promise<Response>;
						};
					};
				}
			).server.handlers;
			return handlers.GET({
				params: { id: seed.meetingId },
				request: new Request(
					`http://localhost/api/meetings/${seed.meetingId}/packet/pdf?${query}`,
				),
			});
		}
		const pagesOf = async (res: Response) =>
			pageCount(new Uint8Array(await res.arrayBuffer()));

		it("duplex=1 returns sheet, blank, sheet; absent returns two pages", async () => {
			const base = "piece=timer&piece=grammarian";
			expect(await pagesOf(await get(`${base}&duplex=1`))).toBe(3);
			expect(await pagesOf(await get(base))).toBe(2);
		});

		it("only the literal 1 turns it on", async () => {
			const base = "piece=timer&piece=grammarian";
			for (const v of ["true", "0", "", "yes"]) {
				expect(await pagesOf(await get(`${base}&duplex=${v}`)), v).toBe(2);
			}
		});
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

		it("returns the club's default agenda layout (#1166)", async () => {
			expect((await loadPacketContext(seed.meetingId)).defaultPrintLayout).toBe(
				"grid",
			);
			await testDb
				.update(clubs)
				.set({ defaultPrintLayout: "timing" })
				.where(eq(clubs.id, seed.clubId));
			expect((await loadPacketContext(seed.meetingId)).defaultPrintLayout).toBe(
				"timing",
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
			defaultPrintLayout: "grid",
		});
		// …and the rule over it therefore ticks nothing, so the dialog cannot
		// offer a download of a club that has been taken down.
		expect(defaultPacketSelection(ctx)).toEqual([]);
	});
});
