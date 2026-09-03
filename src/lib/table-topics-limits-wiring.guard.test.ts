/**
 * Every call site that must forward a club's Table Topics window (#443).
 *
 * ## Why this file exists, stated plainly
 *
 * The first cut of #443 wired ONE of the five surfaces. `buildSlideDeck` got the
 * club's window; `resolveAgendaRows` — the seam the printed run sheet, the
 * on-screen agenda and the present page all share — did not, and neither did
 * `materialiseRunOfShow`, which FREEZES the marks it builds into the template
 * row. So a club setting 1:00/2:30 got a projector saying "2:30 maximum" beside
 * a printed Timer row still saying red at 2:00: the exact contradiction the
 * issue exists to close, inverted rather than fixed.
 *
 * Worse, a comment on `RunOfShowConfig.tableTopicsLimits` justified making that
 * field optional by claiming the risk was "covered by
 * table-topics-limits-wiring.guard.test.ts" — this file, which did not exist.
 * Three independent review passes each found the gap, and all three found it by
 * reading the wiring rather than by running anything, because nothing failed.
 *
 * ## What is enforced where, and why it is split
 *
 * `resolveAgendaRows` takes the limits as a REQUIRED field, so typecheck names
 * every route that forgets — that is the real gate for the three run-sheet
 * surfaces, and it is why this file does not need to police them.
 *
 * `RunOfShowConfig.tableTopicsLimits` stays OPTIONAL, because requiring it would
 * mean editing 51 `buildRunOfShow` fixtures (74 counting `buildSlideDeck`) to
 * say "no opinion". That figure was written as "~200" until it was counted, and
 * the wrong number was the whole justification for the asymmetry. That is the
 * hole this file actually covers: the production callers of `buildRunOfShow`
 * that hold club data and could silently take the default.
 *
 * ## What a mutation pass found this file could NOT see
 *
 * Three unwires passed every assertion here, typecheck, and the whole suite.
 * Each is now pinned below, and the shape they share is worth naming: the guard
 * policed the FUNCTION that receives the window and not the ARGUMENT at the call
 * site one frame up, which is where a `null` typechecks quietly.
 *
 * · `loadAgendaDraft` handing `materialiseForMeeting` two nulls — the worst of
 *   the three, since materialisation FREEZES the marks permanently.
 * · The loader returning `tableTopicsMaxSeconds: null`, which makes
 *   `hasTableTopicsLimits` false and reverts all five surfaces silently.
 * · The two routes nulling the deck's own `ClubForDeck` window.
 *
 * Comment-blind via `readSource` for the must-be-present assertions, since this
 * header names several of the very patterns below.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

describe("table topics limits wiring (#443)", () => {
	it("resolveAgendaRows accepts the window and forwards it", () => {
		const src = readSource("src/lib/agenda-runsheet.ts");
		// Required, not optional — the field being required is what makes
		// typecheck the gate for the three routes below. Asserted as two facts
		// rather than one span: `readSource` blanks comments while PRESERVING
		// offsets, so a docblock between them inflates any distance window and
		// makes a span regex fail for a reason unrelated to the wiring.
		expect(src).toContain("export function resolveAgendaRows(input: {");
		expect(src).toContain("tableTopicsLimits: TableTopicsLimits | null;");
		expect(src, "must be required, not optional").not.toContain(
			"tableTopicsLimits?: TableTopicsLimits | null;\n\ttemplate",
		);
		// And it must actually reach the builder, not merely be accepted.
		expect(src).toMatch(
			/buildRunOfShow\(\{[\s\S]{0,160}tableTopicsLimits: input\.tableTopicsLimits/,
		);
	});

	it("every route that resolves agenda rows passes the club window", () => {
		// The three run-sheet surfaces. Typecheck already refuses an omission, so
		// this pins that what they pass is the CLUB's value rather than a literal
		// null someone added to silence the compiler.
		for (const path of [
			"src/routes/club.$clubId.meeting.$meetingId.tsx",
			"src/routes/club.$clubId_.meeting.$meetingId.print.tsx",
			"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
		]) {
			const src = readSource(path);
			expect(src, `${path} calls resolveAgendaRows`).toContain(
				"resolveAgendaRows({",
			);
			// Independent facts, no distance window — for the reason this file's
			// own header states about the assertion above it. The span form used
			// to be here and was already spending 277 of its 400 characters on one
			// route's comment, so three more lines of house style at that call site
			// would have failed the guard as if the wiring had regressed.
			expect(src, `${path} forwards the club window`).toMatch(
				/minSeconds: (data\.)?tableTopicsMinSeconds/,
			);
			expect(src, `${path} must not hardcode`).not.toContain(
				"tableTopicsLimits: null",
			);
		}
	});

	it("every route that builds a deck passes the club window too", () => {
		// `ClubForDeck` requires both fields, so typecheck sees an OMISSION and
		// nothing sees a wrong VALUE — CLAUDE.md's "a component tested through its
		// props cannot see a WRONG prop", with a route that cannot be mounted in
		// vitest on the other side. Mutating these two literals to `null` passed
		// the entire suite.
		// Counted, because `club.$clubId.meeting.$meetingId.tsx` builds the club
		// literal TWICE — once for the deck and once for the `.pptx` export — and
		// a single `toContain` would pass with either one reverted.
		for (const [path, occurrences] of [
			["src/routes/club.$clubId.meeting.$meetingId.tsx", 4],
			["src/routes/club.$clubId_.meeting.$meetingId.present.tsx", 2],
		] as const) {
			const src = readSource(path);
			for (const field of [
				"tableTopicsMinSeconds",
				"tableTopicsMaxSeconds",
			] as const) {
				expect(
					src.match(new RegExp(field, "g"))?.length ?? 0,
					`${path} reads ${field} at every call site`,
				).toBeGreaterThanOrEqual(occurrences);
				expect(src, `${path} must not hardcode ${field}`).not.toContain(
					`${field}: null`,
				);
			}
		}
	});

	it("the deck builder passes the club window too", () => {
		const src = readSource("src/lib/agenda-slides.ts");
		expect(src).toMatch(/buildRunOfShow\(\{[\s\S]{0,160}tableTopicsLimits/);
		expect(src).toContain("formatTableTopicsTiming(tableTopicsLimits)");
	});

	it("materialisation snapshots the CLUB's marks, not ours", () => {
		// `beatSeed` persists `beat.marks` into mark_green/mark_yellow/mark_red,
		// and `resolveMarks` makes the stored copy what renders — so omitting the
		// limits here freezes the standard window into the club's own rows
		// permanently, on every surface including the templated deck.
		const src = readSource("src/lib/agenda-materialise.ts");
		expect(src).toContain("export function materialiseRunOfShow(");
		expect(src).toContain("tableTopicsLimits: TableTopicsLimits | null,");
		expect(src).toMatch(/buildRunOfShow\(\{[\s\S]{0,120}tableTopicsLimits,/);

		const caller = readSource("src/server/meeting-agenda-edit-logic.ts");
		expect(caller).toContain("materialiseRunOfShow(");
		// Whitespace-tolerant on purpose: Biome wraps this call across lines once
		// the second argument makes it long enough, and a guard that breaks when
		// the FORMATTER runs fails for a reason that has nothing to do with the
		// wiring it exists to police.
		expect(caller).toMatch(
			/materialiseRunOfShow\(\s*geIntroducesFunctionaries,\s*tableTopicsLimits,?\s*\)/,
		);
		// And the club columns must actually be selected, or the caller forwards
		// two undefineds that typecheck as null.
		expect(caller).toContain(
			"tableTopicsMinSeconds: clubs.tableTopicsMinSeconds",
		);
		// The ARGUMENT one frame up, which everything above is blind to. A
		// mutation pass replaced this object with `null` at `loadAgendaDraft`'s
		// call and passed the whole suite: `materialiseForMeeting` takes
		// `TableTopicsLimits | null`, the selected column stays selected (an
		// unused select is not an error), and the inner forward still matches
		// because `tableTopicsLimits` there is the PARAMETER. This is the one
		// unwire with a permanent consequence — the marks are frozen into the
		// club's own rows and never re-derived.
		expect(caller).toContain("minSeconds: meeting.tableTopicsMinSeconds,");
		expect(caller).toContain("maxSeconds: meeting.tableTopicsMaxSeconds,");
		expect(caller, "must not freeze a null window").not.toMatch(
			/materialiseForMeeting\([\s\S]{0,140}geIntroducesFunctionaries,\s*null/,
		);
	});

	it("the Timer's own role sheet follows the club, table and script alike", () => {
		// The surface #443 originally excluded, on a stated reason that was false:
		// `role-sheet-layout.ts` is ONE layout serving both the committed blanks
		// and the per-meeting sheets rendered by
		// `api/meetings.$id.role-sheets.$sheet.pdf.ts`. Leaving it out handed the
		// Timer a sheet saying red at 2:00 beside an agenda saying 2:30, with a
		// script telling them to say the wrong number aloud.
		const layout = readSource("src/server/role-sheet-layout.ts");
		expect(layout).toContain("tableTopicsLimits?: TableTopicsLimits | null;");
		// BOTH halves. The table is what the Timer signals from; the script is
		// what they say. Wiring one and not the other is the same sheet
		// contradicting itself.
		expect(layout).toContain("standardTimingRows(fill?.tableTopicsLimits)");
		expect(layout).toContain(
			"sheetScripts(fill?.roleNames, fill?.tableTopicsLimits)",
		);
		// The script must DERIVE from the rows rather than from the constant, or
		// the override reaches the printed table and stops at the spoken half.
		expect(layout).toMatch(
			/function signalSentence\([\s\S]{0,200}standardTimingRows\(tableTopicsLimits\)/,
		);

		// And the loader has to ship the columns, or every sheet renders blank
		// defaults with nothing failing.
		const loader = readSource("src/server/role-sheets-pdf-logic.ts");
		expect(loader).toContain(
			"tableTopicsMinSeconds: clubs.tableTopicsMinSeconds",
		);
		expect(loader).toContain(
			"tableTopicsMaxSeconds: clubs.tableTopicsMaxSeconds",
		);
		expect(loader).toContain("minSeconds: row.tableTopicsMinSeconds,");
		expect(loader).toContain("maxSeconds: row.tableTopicsMaxSeconds,");
	});

	it("the admin form refuses all FOUR rules before the request", () => {
		// A route file cannot be mounted in vitest, so this is the only gate that
		// exists on the form's own validation — the precedent is
		// `club-index-wiring.guard.test.ts`. The ceiling check is the one that was
		// missing: `parseTableTopicsClock` accepts three digits of minutes on
		// purpose, so "20:00" parsed, passed the other three checks, and came back
		// as a raw zod message through the generic catch — the exact outcome the
		// comment above the checks says cannot happen.
		const src = readSource("src/routes/_authed/admin/club-settings.tsx");
		for (const rule of [
			"TABLE_TOPICS_MESSAGES.unparseable",
			"TABLE_TOPICS_MESSAGES.halfStated",
			"TABLE_TOPICS_MESSAGES.inverted",
			"TABLE_TOPICS_MESSAGES.tooLong",
		]) {
			expect(src, `${rule} is checked client-side`).toContain(rule);
		}
		expect(src).toContain("max > MAX_TABLE_TOPICS_SECONDS");
		// And the payload has to carry the parsed values, not the raw text.
		expect(src).toContain("tableTopicsMinSeconds: min,");
		expect(src).toContain("tableTopicsMaxSeconds: max,");
	});

	it("the two layers state the rules in one voice", () => {
		// The form and the zod schema both refuse a half-stated and an inverted
		// window, and the sentences used to be byte-for-byte duplicates with
		// nothing linking them. `CLUB_ARCHIVED_MESSAGE` is the repo's existing
		// pattern for this shape.
		const schema = readSource("src/server/clubs-logic.ts");
		expect(schema).toContain("message: TABLE_TOPICS_MESSAGES.halfStated,");
		expect(schema).toContain("message: TABLE_TOPICS_MESSAGES.inverted,");
		expect(
			schema,
			"no retyped copy of a message that lives in the constant",
		).not.toContain('message: "Set both the minimum');
	});

	it("the templated deck states the club's rule, not the speech grace", () => {
		// `beatTimingText` called `qualifyingWindowForMarks` with no filter, so a
		// MATERIALISED meeting projected "qualifies 0:30–3:00" while the same
		// club's unmaterialised meeting projected "2:31+ disqualified" — two
		// disqualification rules, separated only by whether anyone had opened the
		// agenda editor.
		const src = readSource("src/lib/agenda-template-slides.ts");
		expect(src).toContain("row.roleKey === TABLE_TOPICS_ROLE_KEY");
		expect(src).toContain("formatTableTopicsWindow(row.marks)");
		// The club's own columns must reach it, off the same `ClubForDeck` the
		// standard deck reads.
		expect(src).toMatch(
			/beatTimingText\(row, \{[\s\S]{0,120}minSeconds: club\.tableTopicsMinSeconds/,
		);
	});

	it("the loader ships the columns every surface above reads", () => {
		const src = readSource("src/server/meetings.ts");
		expect(src).toContain("tableTopicsMinSeconds: true");
		expect(src).toContain("tableTopicsMaxSeconds: true");
		// BOTH lines. Only the MIN was pinned, and mutating the max to a literal
		// `null` passed — which makes `hasTableTopicsLimits` false and reverts all
		// five surfaces to the standard window, reading exactly like a feature
		// that never shipped. Nothing else can catch it: `loadMeetingDetail` is
		// private to a server-fn module and unreachable from vitest, so this
		// assertion is the only gate that exists.
		expect(src).toMatch(
			/tableTopicsMinSeconds: club\?\.tableTopicsMinSeconds \?\? null/,
		);
		expect(src).toMatch(
			/tableTopicsMaxSeconds: club\?\.tableTopicsMaxSeconds \?\? null/,
		);
	});
});
