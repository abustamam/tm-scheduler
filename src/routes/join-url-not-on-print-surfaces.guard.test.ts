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
 * ## Two halves, because a source grep alone was NOT the enforcement (#754)
 *
 * `getMeetingByKey` and `getPublicMeetingByKey` both return `loadMeetingDetail`
 * (`server/meetings.ts`), whose own docblock says "ONE loader, shared with the
 * agenda editor". There is exactly one payload shape, and `loadMeetingDetail`
 * reads the meeting with `db.query.meetings.findFirst`, so `join_url` is on the
 * payload of every consumer the moment the column exists. Narrowing it THERE
 * takes the link off the page it is for: gating on `canManage` hides it from
 * ordinary members, who are its entire audience
 * (`public-meeting-contact.guard.test.ts` records that a signed-in non-admin
 * gets `canManage=false`), and splitting the loader breaks the agenda editor's
 * clock, computed from the same slots for the same reason.
 *
 * #731 concluded from that that the withholding had to be RENDER-side, and that
 * this source sweep was therefore the only enforcement available. The first
 * half is right; the second does not follow, and the gap between them was a
 * live leak for the whole life of the feature. A render-side rule governs what
 * is PAINTED. The three route loaders returned `{ ...data, logoUrl }`, and
 * TanStack Start dehydrates loader data into the served document — so the URL
 * was in `view-source` on `/print?chrome=none`, `/present` and `/word` whether
 * or not a component drew it, measured at exactly one occurrence each. A grep
 * for the identifier cannot, by construction, see a field riding a spread.
 *
 * So there are two halves here and each sees what the other cannot:
 *
 *   - **the PAYLOAD half** runs each public artifact route's real loader and
 *     asserts over what it returns — the object that gets serialised into the
 *     page. That is the enforcement. It is field-agnostic, so it also catches
 *     the next column nobody thought about.
 *   - **the SOURCE half** stays, because a payload test cannot see a component
 *     that reaches for the field some other way. A layout handed `joinUrl` as a
 *     prop and choosing not to draw it today passes every snapshot and is one
 *     careless line from leaking.
 *
 * The withholding itself lives in `#/lib/in-room-meeting-payload`, which names
 * the meeting columns an artifact may carry. Its docblock says why that is an
 * allowlist rather than a `delete`.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSource } from "#/test/guard-source";

// The payload half runs the four public artifact route loaders for real, which
// means importing the route modules — and every one of them reaches `#/db` →
// `pg` through a server fn at module load. Mock the union of what the four
// pull in; the loaders under test only ever call the first three.
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
// `getVoteParticipation` rides in through `MeetingPresent` (the projector's
// participation badge); the other three through the ballot the vote route
// renders.
vi.mock("#/server/voting", () => ({
	getVoteParticipation: vi.fn(),
	joinBallot: vi.fn(),
	getBallot: vi.fn(),
	submitVote: vi.fn(),
}));
// Reached transitively through `PickNameForm`, which the vote route renders.
vi.mock("#/server/members", () => ({ listMembers: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { Route as PresentRoute } from "./club.$clubId_.meeting.$meetingId.present";
import { Route as PrintRoute } from "./club.$clubId_.meeting.$meetingId.print";
import { Route as VoteRoute } from "./club.$clubId_.meeting.$meetingId.vote";
import { Route as WordRoute } from "./club.$clubId_.meeting.$meetingId.word";

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

/**
 * The PAYLOAD half (#754) — the enforcement.
 *
 * Runs each public artifact route's real loader and asserts over what it
 * returns, because that object is what TanStack Start serialises into the
 * served document. The source sweep above is blind to it: the leak was
 * `{ ...data, logoUrl }`, and no grep for an identifier can see a field riding
 * a spread.
 *
 * Deliberately FIELD-AGNOSTIC. It does not check that one named column was
 * removed, it checks that nothing outside `IN_ROOM_MEETING_FIELDS` survives —
 * so the column added next year is covered by the same assertion, which is
 * precisely what neither the grep nor a "did we delete joinUrl" test can do.
 */
const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
/** Distinctive on purpose: a value that could not appear for another reason. */
const SECRET = "https://zoom.example/j/guard-754-secret";
/** Stands in for the column nobody has added yet. */
const FUTURE_COLUMN_VALUE = "guard-754-not-yet-invented";

/**
 * A payload shaped like `loadMeetingDetail`'s return, with the whole meeting
 * row on it — which is what the real one ships (`server/meetings.ts` selects no
 * columns, deliberately, so the member-facing meeting page keeps its link).
 */
function detail() {
	return {
		meeting: {
			id: MEETING_ID,
			clubId: CLUB_ID,
			scheduledAt: "2026-07-31T18:45:00Z",
			lengthMinutes: 60,
			location: "Room 4",
			// The column under test.
			joinUrl: SECRET,
			theme: "Beginnings",
			wordOfTheDay: "Ephemeral",
			wodDefinition: "Lasting for a very short time.",
			wodExample: "The applause was ephemeral.",
			status: "scheduled",
			meetingNumber: 56,
			templateId: null,
			// The organizer's PRIVATE scratch (distinct from `reminders`), which
			// rode the same spread onto the same three public documents.
			notes: "Ask Dana whether the projector bulb was replaced",
			reminders: "Dues are due Friday",
			createdAt: "2026-07-01T00:00:00Z",
			// The next column, whatever it turns out to be.
			someFutureColumn: FUTURE_COLUMN_VALUE,
		},
		meetingNumber: 56,
		slots: [],
		canManage: false,
		roleRecency: {},
		nextMeetingAt: null,
		timezone: "UTC",
		clubName: "Downtown Toastmasters",
		clubNumber: "1234567",
		clubSlug: "downtown",
		urlKey: "2026-07-31",
		clubDistrict: null,
		clubMission: null,
		clubMeetingSchedule: null,
		geIntroducesFunctionaries: false,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
		template: null,
		templateKey: null,
		officers: [],
		unavailableMembers: [],
		plan: [],
		answeredRungs: [],
		roster: [],
		clubGuests: [],
		clubRoles: [],
	};
}

const ARTIFACT_ROUTES = [
	["/print", PrintRoute],
	["/present", PresentRoute],
	["/word", WordRoute],
	// Already compliant before #754 — it projects four named fields and was the
	// pattern copied into `in-room-meeting-payload`. Enrolled so it stays that
	// way: nothing else asserts it, and a `{ ...detail }` here would be the same
	// bug on the most-shared URL in the room.
	["/vote", VoteRoute],
] as const;

const ctx = {
	params: { clubId: "downtown", meetingId: "2026-07-31" },
	location: {
		href: "/club/downtown/meeting/2026-07-31/print",
		pathname: "/club/downtown/meeting/2026-07-31/print",
		searchStr: "",
	},
};

// biome-ignore lint/suspicious/noExplicitAny: the loader union has no call sig
const runLoader = (route: { options: { loader?: any } }) =>
	route.options.loader(ctx) as Promise<unknown>;

/** What gets serialised into the page — the thing the acceptance criterion is
 *  about, not the thing a component chose to render. */
const shipped = (payload: unknown) => JSON.stringify(payload);

beforeEach(() => {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		name: "Downtown Toastmasters",
		clubNumber: "1234567",
		// biome-ignore lint/suspicious/noExplicitAny: a partial club is enough
	} as any);
	vi.mocked(getClubLogoMeta).mockResolvedValue(null);
	// biome-ignore lint/suspicious/noExplicitAny: a partial payload is enough
	vi.mocked(getPublicMeetingByKey).mockResolvedValue(detail() as any);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("no in-room artifact SHIPS the join link (#754)", () => {
	/**
	 * The pre-fix control, and the reason the four assertions below can fail.
	 *
	 * `{ ...data, logoUrl }` is what all three artifact loaders returned until
	 * #754. Without this, a `detail()` fixture that quietly stopped setting
	 * `joinUrl` would turn the whole block green while proving nothing.
	 */
	it("the pre-fix return shape DOES ship it (control)", () => {
		const preFix = { ...detail(), logoUrl: null };
		expect(shipped(preFix)).toContain(SECRET);
		expect(shipped(preFix)).toMatch(JOIN_URL);
	});

	for (const [label, route] of ARTIFACT_ROUTES) {
		it(`${label} ships no join link`, async () => {
			const payload = shipped(await runLoader(route));
			expect(payload).not.toContain(SECRET);
			expect(payload).not.toMatch(JOIN_URL);
		});

		/**
		 * Allowlist, not denylist. A fix that deleted the one named field would
		 * pass the assertion above and fail this one, and the next column added to
		 * `meetings` would leak exactly the way `join_url` did.
		 */
		it(`${label} ships no column outside the allowlist`, async () => {
			const payload = shipped(await runLoader(route));
			expect(payload).not.toContain(FUTURE_COLUMN_VALUE);
			// The organizer's private scratch rode the same spread.
			expect(payload).not.toContain("projector bulb");
		});

		/**
		 * Vacuity floor. Every assertion above is "must not appear", which an
		 * empty object, a thrown redirect swallowed into `undefined`, or a loader
		 * that stopped calling the meeting read would all satisfy.
		 */
		it(`${label} still ships what the surface needs`, async () => {
			const payload = shipped(await runLoader(route));
			expect(payload).toContain("Downtown Toastmasters");
			expect(payload).toContain(MEETING_ID);
		});
	}

	/**
	 * The three artifact routes specifically — `/vote` deliberately drops all of
	 * this. Their sheets and slides are built from these fields, so a projection
	 * that took the URL by taking the row with it would pass everything above.
	 */
	for (const [label, route] of ARTIFACT_ROUTES.slice(0, 3)) {
		it(`${label} still ships the meeting the sheet is drawn from`, async () => {
			const payload = shipped(await runLoader(route));
			for (const kept of [
				"Beginnings", // theme
				"Ephemeral", // word of the day
				"Room 4", // location
				"Dues are due Friday", // announcements
				"2026-07-31T18:45:00Z", // scheduledAt
			]) {
				expect(payload).toContain(kept);
			}
		});
	}
});
