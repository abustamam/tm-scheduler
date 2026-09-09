/**
 * The superadmin console's time-zone wiring (#716 / #670).
 *
 * ## Why a source guard and not a render test
 *
 * The zone list and the provisioning schema are both well covered — the list by
 * `club-timezone.test.ts`, the schema by `onboarding-logic.integration.test.ts`.
 * The bug this file exists for lives in NEITHER: it is where the route gets its
 * `<option>` set and what it checks the browser's own zone against.
 *
 * The first version of #716 imported `CLUB_TIMEZONES` into this route and
 * pre-selected the browser zone with `isSupportedClubTimezone`. Both resolve
 * against whichever ICU tables the evaluating process has, so in the browser
 * they answer for the BROWSER — and `CLUB_TIMEZONES`' own docblock names that
 * exact failure first: two ICU builds disagree about which spelling of an alias
 * pair is canonical (`Asia/Kolkata` vs `Asia/Calcutta`), so the picker offers,
 * and pre-selects, an option this server rejects. The rejection is not even
 * legible — the server fn's `.validator` throws a ZodError whose `message` is a
 * JSON issues array, so the toast shows that rather than
 * `INVALID_TIMEZONE_MESSAGE` — and a retry re-picks the same zone.
 *
 * Rendering this route to observe that would mean standing up the router, a
 * superadmin session and the `listConsoleClubs` server fn for one prop
 * expression and one `useEffect` condition. The repo's idiom for a layer vitest
 * cannot otherwise reach is a comment-blind source guard (`club-index-wiring`,
 * #319), and this is one.
 *
 * ## Comment-blind, deliberately — and one assertion that must NOT be
 *
 * The "must BE present" assertions read through `readSource`, which blanks
 * comments: a comment merely MENTIONING `zones.map(` would otherwise produce a
 * false PASS with the real code deleted. The offender assertion below is the
 * opposite form ("this import must be absent"), where a comment can only cause
 * a false FAILURE, so per the note in `src/test/guard-source.ts` it reads the
 * RAW text. That is why the route's own comment about the zone list is worded
 * without the identifiers this file forbids.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/_authed/superadmin/index.tsx";

describe("superadmin console → time-zone wiring (#716)", () => {
	const src = readSource(ROUTE);
	const raw = readFileSync(ROUTE, "utf8");

	/** Vacuity floor: prove `readSource` found a real file before trusting a
	 *  single assertion below. An empty string satisfies every `not.toMatch`. */
	it("reads a non-empty route source", () => {
		expect(src.length).toBeGreaterThan(2000);
		expect(src).toMatch(/createFileRoute\("\/_authed\/superadmin\/"\)/);
	});

	/**
	 * The `<option>` set comes from the LOADER. Anchored inside the `<select>`
	 * element itself, so a `zones.map(` somewhere else in the file cannot
	 * satisfy it, and the slice is asserted non-empty first.
	 */
	it("builds the zone options from the loader's list", () => {
		const select = src.match(/<select[\s\S]*?<\/select>/);
		expect(select, `no <select> element found in ${ROUTE}`).toBeTruthy();
		const el = select?.[0] ?? "";
		expect(el).toMatch(/name="timezone"/);
		expect(
			el,
			"the zone <option>s must come from the loader's `zones`",
		).toMatch(/\{zones\.map\(/);
	});

	/**
	 * The browser's zone is checked against the loader's list. This is the
	 * assertion that would have caught the shipped bug: `isSupportedClubTimezone`
	 * passes here and the server still rejects.
	 */
	it("validates the browser default against the loader's list", () => {
		const effect = src.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/);
		expect(effect, `no useEffect found in ${ROUTE}`).toBeTruthy();
		const body = effect?.[0] ?? "";
		expect(
			body,
			"the browser zone must be read from Intl to be a default at all",
		).toMatch(/resolvedOptions\(\)\.timeZone/);
		expect(
			body,
			"membership must be tested against the loader's `zones`",
		).toMatch(/zones\.includes\(/);
	});

	/** The field has to actually reach the server fn, or the schema's new
	 *  requirement rejects every create the console makes. */
	it("sends the picked zone in the provisionClub payload", () => {
		const payload = src.match(/provisionClub\(\{[\s\S]*?\}\);/);
		expect(payload, `no provisionClub call found in ${ROUTE}`).toBeTruthy();
		expect(payload?.[0]).toMatch(/timezone: String\(form\.get\("timezone"\)/);
	});

	/** The club list shows each club's zone — the read-side half of #716, and the
	 *  only place a wrong pick is visible before the club has meetings. */
	it("renders each club's stored zone in the list", () => {
		expect(src).toMatch(/club\.timezone/);
		expect(src).toMatch(/>Time zone</);
	});

	/**
	 * Raw text on purpose (see the header): an offender assertion must not read
	 * comment-blind. Any of these three in this file means the route is deciding
	 * zone validity from the BROWSER's ICU tables again.
	 */
	it("never derives the zone list or its validity client-side", () => {
		expect(raw, "the route must not import the zone module").not.toMatch(
			/from "#\/lib\/club-timezone"/,
		);
		expect(raw).not.toMatch(/CLUB_TIMEZONES/);
		expect(raw).not.toMatch(/isSupportedClubTimezone/);
	});
});
