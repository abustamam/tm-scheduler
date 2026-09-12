/**
 * The focused duty editors' CALL-SITE wiring (#666).
 *
 * ## Why a source guard and not a render test
 *
 * The editor BODIES live in `components/club/personal-meeting-editors.tsx` and
 * are render-tested there; the Timer's stopwatch body (#729) lives in
 * `components/club/meeting-timer.tsx` and is render-tested there. What stays
 * here is what vitest cannot reach: the three route modules, which import
 * `#/server/meetings` → `#/db` and throw `DATABASE_URL is not set` on import.
 * Everything asserted below is an EXPRESSION on one of those routes —
 * CODING_STANDARDS' "a component tested through its props cannot see a WRONG
 * prop", where the props are computed.
 *
 * ## The one assertion that could not be written any other way
 *
 * The duty registry hands out `/club/:clubId/meeting/:key/me/theme` as a plain
 * STRING. Nothing type-checks it against the router: `role-duties.ts` is
 * db-free by construction and knows nothing about `routeTree.gen.ts`, and the
 * checklist renders it through `<Link to={duty.href(target)}>`, which accepts
 * any string. So a rename of either route file — or a file named
 * `…me.theme.tsx` instead of `…me_.theme.tsx`, which resolves as a CHILD of a
 * personal page that renders no `<Outlet />` and therefore renders nothing —
 * leaves every other gate in this repo green while the club's Grammarian taps a
 * checklist row and lands on a 404. The first describe closes that by matching
 * each href against the generated route tree's own `fullPath` list.
 *
 * ## Which reader
 *
 * `readSource` blanks comments, which is correct for "this pattern must BE
 * present" — a route file whose header MENTIONS `themeOnlyUpdate` would
 * otherwise satisfy the assertion after the call was deleted, and both of these
 * route files carry long headers naming most of what follows. The negatives
 * read RAW, per `guard-source.ts`: the stripper is a lexer that does not track
 * string literals, so blanking can erase the offending code from the text being
 * searched — a false PASS on exactly the half that exists to catch a regression.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	dutiesForRole,
	personalMeetingHref,
	ROLE_CONFIRM_PROMPT,
} from "#/lib/role-duties";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const THEME_ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.me_.theme.tsx";
const WORD_ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.me_.word.tsx";
const TIMER_ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.me_.timer.tsx";
const EDITORS = "src/components/club/personal-meeting-editors.tsx";
const PERSONAL_BODY = "src/components/club/personal-meeting-body.tsx";

/** Comment-blind — for "this pattern must BE present". */
const theme = readSource(resolve(ROOT, THEME_ROUTE));
const word = readSource(resolve(ROOT, WORD_ROUTE));
const timer = readSource(resolve(ROOT, TIMER_ROUTE));
const editors = readSource(resolve(ROOT, EDITORS));
/** Verbatim — for "this offender must be ABSENT". Never `readSource`. */
const rawEditors = readFileSync(resolve(ROOT, EDITORS), "utf8");
const rawTheme = readFileSync(resolve(ROOT, THEME_ROUTE), "utf8");

describe("every duty href is a route that exists", () => {
	// The generated tree is the only place the router's real URL set is written
	// down. Matching against it rather than against a FILE NAME is deliberate:
	// the two trailing underscores that keep these routes out of the personal
	// page's (absent) `<Outlet />` do not appear in the URL at all, so a
	// filename-shaped assertion would pass for a file that serves nothing.
	const tree = readSource(resolve(ROOT, "src/routeTree.gen.ts"));
	const fullPaths = new Set(
		[...tree.matchAll(/fullPath: '([^']+)'/g)].map((m) => m[1]),
	);
	/** The router's own param spellings, handed to the registry — so what a duty
	 *  emits IS a route path, directly comparable to `fullPath`. */
	const TARGET = { clubId: "$clubId", meetingId: "$meetingId" };

	it("finds the route tree (vacuity floor)", () => {
		// Counts routes, which is the STRUCTURE this guard is about, rather than a
		// lexical proxy. ~50 routes today; a tree that collapsed below 20 has not
		// been generated properly and every assertion below would pass vacuously
		// only if the set were empty — which this makes impossible.
		expect(fullPaths.size).toBeGreaterThanOrEqual(20);
	});

	for (const role of ROLE_TEMPLATE) {
		for (const duty of dutiesForRole({
			roleName: role.name,
			roleKey: role.key,
		})) {
			it(`${duty.id} → a real route`, () => {
				expect(
					fullPaths.has(duty.href(TARGET)),
					`${duty.id}'s href ${duty.href(TARGET)} matches no route in routeTree.gen.ts — the checklist row 404s`,
				).toBe(true);
			});
		}
	}

	it("the personal page itself is a real route", () => {
		expect(fullPaths.has(personalMeetingHref(TARGET))).toBe(true);
	});

	it("the confirm-only prompt's roles guide is a real route", () => {
		expect(fullPaths.has(ROLE_CONFIRM_PROMPT.href(TARGET))).toBe(true);
	});

	it("the Timer's stopwatch is a real route (#729)", () => {
		// Asserted DIRECTLY, not through the registry sweep above, and that is
		// the point rather than belt-and-braces. #729 deliberately ships no
		// `DutyId` — `RoleDuty` requires a truthful `done` and nothing was stored
		// to derive one from until #730 — so the sweep, which only walks
		// registered duties, could not see this route at all. It is reached from
		// one hardcoded `<Link>` on the personal meeting page, and a rename of the
		// route file would leave every other gate in this repo green while the
		// club's Timer taps it and lands on a 404.
		expect(
			fullPaths.has(
				`/club/${TARGET.clubId}/meeting/${TARGET.meetingId}/me/timer`,
			),
		).toBe(true);
	});

	// A matching URL is NOT proof the page renders, and this is the case that
	// makes the distinction real rather than theoretical. Verified by mutation:
	// renaming the theme route to `…$meetingId_.me.theme.tsx` — the obvious
	// spelling, and the one #666's own file list uses — regenerates a tree whose
	// `fullPath` is byte-identical while `parentRoute` becomes the PERSONAL PAGE
	// and `me` becomes `…MeRouteWithChildren`. That page renders no `<Outlet />`,
	// so the editor mounts nowhere: the URL resolves, the loader runs, and the
	// visitor is shown the personal page again with no error anywhere. Every
	// assertion above stays green. The `me_` segment is what prevents it.
	it("the editors hang off the club shell, not off the outlet-less personal page", () => {
		for (const leaf of ["theme", "word", "timer"]) {
			expect(
				tree,
				`${leaf} editor must be a child of the /club/$clubId shell`,
			).toMatch(
				new RegExp(
					`'/club/\\$clubId/meeting/\\$meetingId_/me_/${leaf}': \\{[\\s\\S]{0,240}parentRoute: typeof ClubClubIdRoute\\b`,
				),
			);
		}
	});

	it("no route file is given children unless it renders an <Outlet />", () => {
		// The general form of the rule above, stated over the one route that would
		// silently absorb these two. Read comment-blind: `me.tsx`'s header explains
		// at length that it renders no `<Outlet />`, and a raw read would match
		// that sentence and pass while the element was still absent.
		const me = readSource(
			resolve(ROOT, "src/routes/club.$clubId.meeting.$meetingId_.me.tsx"),
		);
		const hasOutlet = me.includes("<Outlet");
		const hasChildren = tree.includes(
			"ClubClubIdMeetingMeetingIdMeRouteChildren",
		);
		expect(
			hasOutlet || !hasChildren,
			"the personal meeting page has child routes but renders no <Outlet /> — those children resolve and render nothing",
		).toBe(true);
	});
});

describe("the routes hand the editors RAW loader fields", () => {
	// The #319 shape: had the route computed `canEdit` and passed a boolean, the
	// single expression deciding who may edit a meeting from a forwarded chat
	// link would be untested by construction. The editors derive it themselves.
	for (const [name, src] of [
		["theme", theme],
		["word", word],
	] as const) {
		it(`${name}: passes meeting/slots/canManage straight through`, () => {
			expect(src).toContain("meeting={meeting}");
			expect(src).toContain("slots={slots}");
			expect(src).toContain("canManage={canManage}");
			expect(src).toContain("memberId={myId}");
		});

		it(`${name}: passes no precomputed capability`, () => {
			const raw = readFileSync(
				resolve(ROOT, name === "theme" ? THEME_ROUTE : WORD_ROUTE),
				"utf8",
			);
			expect(raw).not.toMatch(/canEdit=\{/);
			expect(raw).not.toMatch(/resolveMeetingViewer/);
		});

		it(`${name}: keys the identity on the RAW clubId param`, () => {
			// The identity gate stores under the raw `$clubId` segment. Reading it
			// with `clubUuid` would resolve an identity nothing ever wrote.
			expect(src).toContain("useEffectiveMember(clubId, session)");
		});
	}
});

describe("the personal page's link INTO the stopwatch (#729)", () => {
	// The one entrance to `/me/timer`. It is not a `duty.href`, so the registry
	// sweep at the top of this file cannot reach it, and the personal page's own
	// render tests cannot see the EXPRESSION that decides who is offered it —
	// CODING_STANDARDS' "a component tested through its props cannot see a WRONG
	// prop", where the prop is computed. Both halves below have a live failure
	// behind them, so both are asserted here.
	const body = readSource(resolve(ROOT, PERSONAL_BODY));
	const rawBody = readFileSync(resolve(ROOT, PERSONAL_BODY), "utf8");

	it("resolves the Timer through findTimerSlot, not a roleKey comparison", () => {
		// KEY FIRST, then the exact canonical name. `findTimerSlot` is the shipped
		// resolver and its whole point is that ORDER: a name-first check hands the
		// Timer's surface to a club-invented "Timer Assistant" whenever the real
		// Timer has been renamed, and nothing fails (#464/#732).
		expect(body).toContain("findTimerSlot(view.roles)");
	});

	it("never re-derives the Timer by comparing the key inline", () => {
		// RAW negative: `role.roleKey === "timer"` type-checks, reads fine, and
		// silently denies the link to a standard Timer slot whose key is NULL.
		expect(rawBody).not.toMatch(/roleKey\s*===\s*["']timer["']/);
	});

	it("offers the link only on the slot the Timer actually holds", () => {
		// Per-SLOT, never per-member: `view.roles` can carry several roles, and a
		// member-wide flag would hang a stopwatch off their Evaluator card too.
		expect(body).toContain("role.slotId === timerSlotId");
	});

	it("closes the link when the meeting's write window has", () => {
		// A month-old link still sits in the chat scrollback. Without this a
		// meeting that already happened sprouts a stopwatch.
		expect(body).toMatch(/role\.slotId === timerSlotId && !writesClosed/);
	});

	it("uses the router's own typed path", () => {
		// A `to={string}` form 404s at the Timer's thumb when the route file is
		// renamed; the typed path fails `typecheck` instead.
		expect(body).toContain('to="/club/$clubId/meeting/$meetingId/me/timer"');
	});
});

describe("the Timer's stopwatch route (#729)", () => {
	it("keys the identity on the RAW clubId param", () => {
		// Same rule as the two editors, and the same failure: the identity gate
		// stores under the raw `$clubId` segment, so reading it with `clubUuid`
		// resolves an identity nothing ever wrote and the Timer is asked to pick
		// their name again on a page they were sent to by name.
		expect(timer).toContain("useEffectiveMember(clubId, session)");
	});

	it("derives the run sheet through resolveAgendaRows, never its own marks", () => {
		// The clock's green/yellow/red must be the PRINTED agenda's, character for
		// character. `resolveAgendaRows` is the one seam all three run-sheet
		// surfaces go through; a route that re-derived marks from `slots` would
		// put the Timer's phone and the Timer's paper card in disagreement, which
		// is the whole failure #443 closed for the deck.
		expect(timer).toContain("resolveAgendaRows({");
		expect(timer).toMatch(
			/resolveAgendaRows\(\{[\s\S]{0,400}tableTopicsLimits: \{/,
		);
	});

	it("takes the back link from the duty registry, not a second literal", () => {
		// `personalMeetingHref` owns the path back out — the registry hands out the
		// links IN, so a second spelling here is the drift `TMOD_ROLE_KEY`'s
		// docblock describes.
		expect(timer).toContain("personalMeetingHref({ clubId, meetingId })");
	});

	it("writes nothing — #729 is an ephemeral stopwatch", () => {
		// RAW negative. #730 adds the record through its own server fn; until then
		// a write reaching this route would be a store nobody reviewed.
		const raw = readFileSync(resolve(ROOT, TIMER_ROUTE), "utf8");
		expect(raw).not.toMatch(/#\/server\/timings/);
		expect(raw).not.toMatch(/recordTiming\(/);
	});
});

describe("saving hands back to the personal page", () => {
	// "On save, return there so the checklist visibly ticks — the tick is the
	// receipt" (#666). Two halves, and only the pair works: the personal page
	// reads its checklist from a `useQuery`, so a navigation without the
	// invalidation lands on a cached, still-unticked row.
	for (const [name, src] of [
		["theme", theme],
		["word", word],
	] as const) {
		it(`${name}: invalidates the personal-meeting query`, () => {
			expect(src).toContain(
				'queryKey: ["personal-meeting", clubUuid, meetingId]',
			);
		});

		it(`${name}: navigates to the personal page, dropping ?as=`, () => {
			expect(src).toMatch(
				/navigate\(\{[\s\S]{0,200}to: "\/club\/\$clubId\/meeting\/\$meetingId\/me"/,
			);
			// A re-share of the landed URL must not re-point another device.
			expect(src).toMatch(
				/navigate\(\{[\s\S]{0,320}search: \{ as: undefined \}/,
			);
		});
	}
});

describe("the writes go through the tested payload builders", () => {
	it("the theme editor builds its payload with themeOnlyUpdate", () => {
		expect(editors).toContain("themeOnlyUpdate({");
		expect(editors).toMatch(
			/updateMeeting\(\{[\s\S]{0,80}data: themeOnlyUpdate\(\{/,
		);
		// Every field the writer would otherwise NULL reaches the builder in one
		// object, so a partial `current` cannot be assembled by hand at the call
		// site and drift from `MeetingMetaEcho`.
		expect(editors).toContain("current: props.meeting");
	});

	it("no hand-rolled updateMeeting payload survives beside it", () => {
		// RAW. `updateMeeting({ data: { meetingId: …, theme } })` type-checks, saves
		// successfully, and erases the club's location, Word of the Day,
		// announcements and notes on the same request.
		expect(rawEditors).not.toMatch(/updateMeeting\(\{\s*data:\s*\{/);
	});

	it("the word editor sends all three WOD fields on every save", () => {
		// `applyWordOfTheDayUpdate` nulls what it is not given, so a payload
		// missing the definition clears a definition nobody edited.
		expect(editors).toMatch(
			/updateWordOfTheDay\(\{[\s\S]{0,400}wordOfTheDay:[\s\S]{0,200}wodDefinition:[\s\S]{0,200}wodExample:/,
		);
	});

	it("both editors write against the RESOLVED meeting uuid", () => {
		// The `$meetingId` URL segment is a club-local date key and both writers
		// validate `z.string().uuid()` — passing it rejects the save AFTER the
		// page rendered fine.
		//
		// Asserted AT each payload rather than as a blanket "`props.meetingId`
		// never appears": the back link legitimately passes that segment to
		// `personalMeetingHref`, which wants the URL spelling the visitor arrived
		// with, so a file-wide negative fails on correct code.
		expect(editors).toMatch(
			/themeOnlyUpdate\(\{[\s\S]{0,120}meetingId: props\.meeting\.id/,
		);
		expect(editors).toMatch(
			/updateWordOfTheDay\(\{[\s\S]{0,200}meetingId: props\.meeting\.id/,
		);
		expect([...editors.matchAll(/meetingId: props\.meeting\.id/g)].length).toBe(
			2,
		);
	});

	it("the route never reaches past the editor to write", () => {
		// RAW negative: the whole point of the component split is that the write
		// and its round trip are testable. A route that called the writer itself
		// would be invisible to vitest again.
		expect(rawTheme).not.toContain("updateMeeting(");
	});
});
