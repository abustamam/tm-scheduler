/**
 * The join link is WITHHELD from the in-room artifacts (#731).
 *
 * ## The decision this enforces
 *
 * A video-call join URL is not private data, it is a key to the door: anyone
 * holding it can walk into the meeting, and there is no revocation short of a
 * new room. `/print`, `/present`, `/word` and the `.pptx` export are the four
 * surfaces that get projected onto a wall, printed onto paper and forwarded to
 * whoever asks — and nobody types a URL off a projector anyway, so there the
 * link is risk with no matching benefit.
 *
 * ## Why the guard has to be a SOURCE grep, and why it is the ONLY enforcement
 *
 * `getMeetingByKey` and `getPublicMeetingByKey` both return `loadMeetingDetail`
 * (`server/meetings.ts`), whose own docblock says "ONE loader, shared with the
 * agenda editor". There is exactly one payload shape, and `loadMeetingDetail`
 * reads the meeting with `db.query.meetings.findFirst`, so `join_url` ships to
 * every consumer of that payload the moment the column exists. Nothing can be
 * withheld at the loader without splitting it, which is a refactor with its own
 * blast radius. Two withholdings that were checked and rejected:
 *
 *   - gating on `canManage` would hide the link from ordinary members, who are
 *     the entire audience for it (`public-meeting-contact.guard.test.ts` records
 *     that a signed-in non-admin gets `canManage=false`);
 *   - splitting `loadMeetingDetail` breaks the agenda editor's clock, which is
 *     computed from the same slots for the same reason.
 *
 * So what keeps the URL off those four surfaces is that **their modules do not
 * render it**, and that is a property of source text, not of output. A render
 * test cannot see it: a layout that received `joinUrl` as a prop and chose not
 * to draw it today passes every snapshot and is one careless line from leaking.
 *
 * ## Reading RAW for the negative half
 *
 * The offender sweep below reads the file UNSTRIPPED, deliberately, and
 * `#/test/guard-source` says why in its own header: the stripper is a lexer that
 * does not track string or template literals, so blanking can erase the very
 * text being searched for and turn a real leak into a PASS. For a
 * "must-not-appear" assertion a comment can only cause a false FAILURE, which a
 * human sees and fixes in a minute. The must-BE-present half below is the
 * opposite shape and reads comment-blind through `readSource`, because there a
 * comment mentioning the pattern would satisfy the assertion after the real code
 * was deleted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const root = resolve(__dirname, "..", "..");
const raw = (rel: string) => readFileSync(resolve(root, rel), "utf8");

/** `joinUrl`, `join_url`, `JOIN_URL` — any spelling of the field, anywhere. */
const JOIN_URL = /join[_-]?url/i;

/**
 * Every module that draws, or serialises, one of the four withheld surfaces.
 *
 * The three route files plus the components and builders they delegate to: a
 * route that passed `joinUrl` down would be caught here, and so would a
 * component that reached for it while its route stayed clean.
 *
 * `meeting-agenda-print.tsx` renders all FOUR print layouts (editorial, compact,
 * classic, packet) from one module, which is why one entry covers the "all four
 * layouts" clause of the acceptance criteria.
 */
const WITHHELD = [
	"src/routes/club.$clubId_.meeting.$meetingId.print.tsx",
	"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
	"src/routes/club.$clubId_.meeting.$meetingId.word.tsx",
	"src/components/agenda/meeting-agenda-print.tsx",
	"src/components/agenda/meeting-present.tsx",
	"src/components/agenda/word-of-the-day-poster.tsx",
	"src/lib/agenda-slides.ts",
	"src/lib/agenda-template-slides.ts",
	"src/lib/deck-to-pptx.ts",
] as const;

/** The surface the link IS for. Also the vacuity floor for the sweep above. */
const MEETING_ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

describe("the join link is on the authed meeting page (vacuity floor)", () => {
	// Without this, every assertion below passes on a branch where the feature
	// was never built, or where `JOIN_URL` is a typo that matches nothing.
	it("the pattern fires on a module that DOES render the link", () => {
		expect(JOIN_URL.test(raw(MEETING_ROUTE))).toBe(true);
	});

	it("renders a real anchor, opened safely in a new tab", () => {
		const src = readSource(resolve(root, MEETING_ROUTE));
		expect(src).toMatch(/href=\{joinUrl\}/);
		expect(src).toMatch(/target="_blank"/);
		// `noopener` denies the opened tab a handle on `window.opener`;
		// `noreferrer` keeps the club's meeting URL out of the video vendor's
		// referrer log. Both, not either.
		expect(src).toMatch(/rel="noopener noreferrer"/);
	});

	it("re-normalizes at render rather than trusting the column", () => {
		// Defence in depth for a row written some other way (a hand-run SQL fix, a
		// future importer): `normalizePresentationUrl` returns null for anything
		// that is not http(s) with a dotted host, so no `javascript:` href can
		// reach the page whatever put it in the column.
		const src = readSource(resolve(root, MEETING_ROUTE));
		expect(src).toMatch(/normalizePresentationUrl\(meeting\.joinUrl\)/);
	});

	/**
	 * The bug this one exists for, and the only one here a reviewer would not
	 * spot by eye: an online-only club leaves `location` BLANK, so an anchor
	 * nested inside `{meeting.location ? … : null}` renders for every club
	 * EXCEPT the ones the feature is for. It typechecks, it renders, and a
	 * fixture that sets both fields passes it.
	 */
	it("is a SIBLING of the location chip, not a child of it", () => {
		const src = readSource(resolve(root, MEETING_ROUTE));
		const location = src.indexOf("{meeting.location ?");
		const locationClosed = src.indexOf(") : null}", location);
		const join = src.indexOf("{joinUrl ?");

		expect(location).toBeGreaterThan(-1);
		expect(join).toBeGreaterThan(-1);
		// The location ternary CLOSES before the join link opens.
		expect(locationClosed).toBeGreaterThan(location);
		expect(join).toBeGreaterThan(locationClosed);

		// …and no ELEMENT BOUNDARY sits between them, so they are adjacent chips
		// inside the same meta row rather than the join link having drifted into
		// another section where a club with no location would never look.
		//
		// Asserted structurally rather than as a character distance: a threshold
		// like "within 1500 characters" is a unitless number with no reason behind
		// it, and it breaks on any unrelated edit nearby while still passing if
		// the chip moved somewhere genuinely wrong but close.
		const between = src.slice(locationClosed, join);
		expect(between).not.toContain("<div");
		expect(between).not.toContain("</div");
		expect(between).not.toContain("<span");
	});
});

describe("the join link is on NO in-room artifact (#731)", () => {
	for (const rel of WITHHELD) {
		it(`${rel} contains no join-link reference`, () => {
			const src = raw(rel);
			// Floor: prove a file was actually read. An empty string trivially
			// satisfies "does not match", and a renamed module would otherwise make
			// this test pass by throwing nothing.
			expect(src.length).toBeGreaterThan(200);
			expect(
				JOIN_URL.test(src),
				`${rel} mentions the join link. Those four surfaces are projected, printed and shared onward; the URL is a key to the room with no revocation. If this is deliberate it is a product decision (#731 "Out of Scope"), not a lint fix.`,
			).toBe(false);
		});
	}

	it("still sweeps all nine modules", () => {
		// The cheapest way to "fix" a failure above is to delete the offending
		// entry from WITHHELD, which silences the guard without changing what
		// ships. A count floor makes that a visible edit rather than a quiet one:
		// three routes, three renderers, three deck builders.
		expect(WITHHELD).toHaveLength(9);
	});
});
