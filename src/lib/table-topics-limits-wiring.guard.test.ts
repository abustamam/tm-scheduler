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
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/** Every source file under `dir`, as repo-relative paths `readSource` accepts.
 *  Tests are excluded: a fixture that calls `buildTemplateRows` directly is the
 *  normal way to test it, not a render surface that forgot the refresh. */
function walkSource(dir: string): string[] {
	const out: string[] = [];
	const visit = (abs: string) => {
		for (const entry of readdirSync(abs)) {
			if (SKIP_DIRS.has(entry)) continue;
			const child = join(abs, entry);
			if (statSync(child).isDirectory()) visit(child);
			else if (
				/\.(m?[jt]sx?)$/i.test(entry) &&
				!/\.(test|bench\.test)\.[jt]sx?$/i.test(entry)
			)
				out.push(relative(ROOT, child));
		}
	};
	visit(resolve(ROOT, dir));
	return out;
}

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

		// The MEETING PACKET staples that same sheet in, through its own call one
		// frame up, and nothing pinned it (#679). `buildRoleSheetPage` takes
		// `RoleSheetFill | undefined`, so mutating this argument to `undefined`
		// typechecks, reverts every packet-stapled Timer sheet to the standard
		// window, and fails nothing — `packet-pdf.integration.test.ts` names
		// `tableTopics` nowhere. Exactly the shape this file's header describes:
		// the FUNCTION was policed and the ARGUMENT was not.
		const packet = readSource("src/server/packet-pdf-logic.ts");
		expect(packet, "the packet loads a real fill").toContain(
			"loadRoleSheetFill(",
		);
		expect(packet).toMatch(/buildRoleSheetPage\(\s*[^,()]+,\s*fill\b/);
		expect(packet, "must not staple a blank sheet in").not.toMatch(
			/buildRoleSheetPage\(\s*[^,()]+,\s*(undefined|null)\b/,
		);
	});

	it("the admin form calls the one validator and sends what it returns", () => {
		// A route file cannot be mounted in vitest, so this is the only gate that
		// exists on the form's WIRING — the precedent is
		// `club-index-wiring.guard.test.ts`. The four refusals themselves are no
		// longer written here: #679 lifted them into `validateTableTopicsForm`,
		// where every branch has a unit test with absolute boundaries. That is the
		// point — the ceiling check was missing for as long as the rules lived in a
		// file no test could reach.
		const src = readSource("src/routes/_authed/admin/club-settings.tsx");
		expect(src).toContain("validateTableTopicsForm(ttMin, ttMax)");
		// The refusal must SHORT-CIRCUIT. Reading `result.message` while still
		// submitting would toast the right sentence and store the wrong window.
		expect(src).toMatch(/if \(!result\.ok\) \{[\s\S]{0,200}return;/);
		// And the payload has to carry the validator's parsed values, not the raw
		// text and not a second parse of its own.
		expect(src).toContain("tableTopicsMinSeconds: result.minSeconds,");
		expect(src).toContain("tableTopicsMaxSeconds: result.maxSeconds,");
		// The inputs are seeded through the shared helper too, so "null renders as
		// empty, not 0:00" is stated once and tested once.
		expect(
			src.match(/tableTopicsClockText\(agenda\.tableTopics/g)?.length ?? 0,
			"both inputs seed through the helper",
		).toBe(2);
		// The refusal reaches the FIELD, not only the toast — the whole point of
		// `refuseTableTopicsSeconds` returning a field at all, and the one part of
		// it that lives in this unmountable file. Deleting the attribution, or
		// pointing both inputs at the same field, passes every other gate here.
		expect(src).toContain("setTtRefusal({ field: result.field");
		expect(src).toContain('aria-invalid={ttRefusal?.field === "min"}');
		expect(src).toContain('aria-invalid={ttRefusal?.field === "max"}');
		// And the sentence itself is rendered beside the input, described by it —
		// a toast is announced once and gone, which leaves a screen-reader user
		// with a field marked invalid and no reason.
		expect(src).toContain('id="tt-min-error"');
		expect(src).toContain('id="tt-max-error"');
		expect(src).toMatch(/aria-describedby=\{[\s\S]{0,80}"tt-min-error"/);
		expect(src).toMatch(/aria-describedby=\{[\s\S]{0,80}"tt-max-error"/);
		// Cleared on an accepted save, or a stale marker outlives the input that
		// earned it.
		expect(src).toMatch(
			/setTtRefusal\(null\);[\s\S]{0,60}setSavingAgenda\(true\)/,
		);
		// The clearing RULE comes from the lib, and each input names its OWN field.
		// Swapping the two arguments, or dropping either call, reproduces exactly
		// the bug the extraction exists to prevent — and an inline two-liner is
		// what the first cut of #679 re-grew in this very file.
		expect(src).toContain("refusalAfterEdit(prev, field)");
		expect(src).toMatch(/setTtMin\(e\.target\.value\);[\s\S]{0,60}"min"\)/);
		expect(src).toMatch(/setTtMax\(e\.target\.value\);[\s\S]{0,60}"max"\)/);
		// No re-grown copy of any rule the validator owns. The constant itself is
		// still legitimately READ here — the help text renders
		// `formatTableTopicsClock(MAX_TABLE_TOPICS_SECONDS)` so the stated ceiling
		// cannot drift from the enforced one — so this bans the COMPARISON, which
		// is the thing that would be a second copy of the rule.
		expect(src, "the rules live in the lib, not here").not.toMatch(
			/[<>]=?\s*MAX_TABLE_TOPICS_SECONDS/,
		);
		expect(src).not.toContain("TABLE_TOPICS_MESSAGES.");
	});

	it("the two layers state the rules in ONE place, not merely in one voice", () => {
		// #443 shared the SENTENCES and left the rules as two hand-written copies,
		// and the copies had already diverged before the ink dried — the form was
		// missing the ceiling. #679 collapsed the rules themselves: one
		// `refuseTableTopicsSeconds`, consumed by the form's validator and by the
		// zod schema, so the two cannot disagree about WHICH rule an input broke.
		const schema = readSource("src/server/clubs-logic.ts");
		expect(schema).toContain("refuseTableTopicsSeconds(");
		expect(schema).toMatch(/superRefine\(\(v, ctx\)/);
		expect(
			schema,
			"no retyped copy of a message that lives in the constant",
		).not.toContain('message: "Set both the minimum');
		// The ceiling belongs to the shared predicate now. A `.max()` back on the
		// bound would re-split it, and the split is what let the two drift.
		expect(schema, "the ceiling is not restated here").not.toContain(
			".max(MAX_TABLE_TOPICS_SECONDS)",
		);

		const lib = readSource("src/lib/table-topics-limits.ts");
		expect(lib).toContain("export function refuseTableTopicsSeconds(");
		expect(lib).toContain("export function validateTableTopicsForm(");
		// The form's validator must DELEGATE rather than restate — otherwise the
		// collapse is cosmetic and the two layers are two copies again.
		expect(lib).toMatch(
			/function validateTableTopicsForm\([\s\S]{0,900}refuseTableTopicsSeconds\(/,
		);
	});

	it("a materialised Table Topics row follows the club at render (#679)", () => {
		// `materialiseRunOfShow` freezes the marks and `resolveMarks` makes the
		// frozen copy authoritative, so a club editing its window afterwards kept
		// the old numbers — while the Timer's role sheet re-derived live, so one
		// packet contradicted itself. Two seams apply the refresh and both are
		// invisible to typecheck: the parameter already existed on one and the
		// other returns the rows unchanged either way.
		const runsheet = readSource("src/lib/agenda-runsheet.ts");
		expect(runsheet).toMatch(
			/buildTemplateRows\(\s*refreshTableTopicsMarks\(\s*input\.template\.beats,\s*input\.tableTopicsLimits,?\s*\)/,
		);
		// The editor's inputs read the DRAFT, so this is what keeps them from
		// showing numbers that will not print.
		const draft = readSource("src/server/meeting-agenda-edit-logic.ts");
		expect(draft).toMatch(
			/rows: refreshTableTopicsMarks\(rows, \{[\s\S]{0,140}minSeconds: meeting\.tableTopicsMinSeconds/,
		);
		expect(draft, "must not refresh against a null window").not.toMatch(
			/refreshTableTopicsMarks\(rows, null\)/,
		);
		// And the editor must not offer an edit the render path would discard —
		// through the SAME predicate, imported rather than re-typed. The first cut
		// hand-wrote three of the four conditions here and the copies disagreed
		// immediately, disabling the inputs on a row the server refreshed nothing
		// on. `readSource` is comment-blind, so a comment naming the symbol cannot
		// satisfy this.
		const editor = readSource("src/components/agenda/agenda-editor.tsx");
		expect(editor).toContain("isTableTopicsSegment");
		expect(editor).toContain("const marksFromClub = isTableTopicsSegment(row)");
		expect(
			editor,
			"the editor must not restate the predicate's conditions",
		).not.toContain("row.roleKey === TABLE_TOPICS_ROLE_KEY");

		// Undo restores ALL THREE marks, with no special case. An earlier cut
		// skipped them on a club-governed row, and `addAgendaRow` inserts NULL
		// marks — so the restored row stopped matching `isTableTopicsSegment` and
		// was never refreshed again: no timer window on the run sheet, the agenda
		// or the deck, while the Timer's role sheet kept printing the club's. One
		// misclick and an Undo rebuilt the contradicting packet this whole change
		// removes.
		expect(
			editor,
			"Undo must not special-case the club-governed row's marks",
		).not.toMatch(/isTableTopicsSegment\(snapshot\)/);
		expect(editor).toMatch(
			/markGreen: snapshot\.markGreen,\s*markYellow: snapshot\.markYellow,\s*markRed: snapshot\.markRed,/,
		);

		// The root fix that made the unconditional restore safe, and it lives in a
		// server-fn module whose zod schema is module-private — invisible to
		// vitest, so a source grep is the only gate that can exist (CLAUDE.md's
		// "a schema private to a server-fn module" rule).
		//
		// The three MARK fields back `real()` columns and the app's own constants
		// are fractional (`EVALUATION_MARKS` is 2 / 2.5 / 3), so `.int()` on them
		// made a half-minute mark unwritable through the only path that writes
		// them. `minutes` KEEPS `.int()` — that column is an integer.
		const editSchema = readSource("src/server/meeting-agenda-edit.ts");
		for (const field of ["markGreen", "markYellow", "markRed"] as const) {
			expect(
				editSchema,
				`${field} backs a real() column and must accept a fraction`,
			).toMatch(
				new RegExp(`${field}: z\\n?\\s*\\.number\\(\\)\\s*\\.min\\(0\\)`),
			);
		}
		expect(editSchema, "minutes is an integer column and keeps .int()").toMatch(
			/minutes: z[\s\S]{0,40}\.int\(\)/,
		);

		// `flex` must NOT be part of the predicate. The "Pin" button sets it false
		// in one click and is about the row's LENGTH, so keying identity on it lets
		// that click silently detach the timing from club settings — the packet
		// that contradicts itself, back again. Asserted on the source because the
		// behavioural gate (`agenda-template-rows.test.ts`) can be deleted.
		const rows = readSource("src/lib/agenda-template-rows.ts");
		expect(rows).toContain(
			"export function isTableTopicsSegment<T extends MarkedBeat>",
		);
		// A TYPE PREDICATE, so a caller that has checked it needs no `?? 0` fallback
		// the check already made unreachable. Dead defence reads as care and is
		// untestable by construction.
		expect(rows).toContain("beat is T & ClubOwnedMarks");
		expect(rows, "the predicate must not read `flex`").not.toMatch(
			/function isTableTopicsSegment[\s\S]{0,400}beat\.flex/,
		);

		// ENROLLMENT, not a list of two names. `refreshTableTopicsMarks` is
		// deliberately outside `buildTemplateRows`, so a THIRD render surface that
		// calls the builder without it silently reintroduces the freeze — the shape
		// #443 shipped wrong twice and this file's own header is about. Derive the
		// candidate set instead of remembering it.
		const REFRESH_WAIVERS = new Map([
			[
				"src/components/agenda/agenda-editor.tsx",
				"rows arrive pre-refreshed from loadAgendaDraft; asserted above",
			],
		]);
		const callers = walkSource("src").filter(
			(p) =>
				p !== "src/lib/agenda-template-rows.ts" &&
				p !== "src/lib/agenda-runsheet.ts" &&
				/buildTemplateRows(WithSource)?\(/.test(readSource(p)),
		);
		// Every waiver must still BE a caller, or it is rot: a file that stops
		// calling the builder (or gets renamed) leaves a waiver excusing nothing,
		// and the next real caller can be added under its name.
		for (const [waived] of REFRESH_WAIVERS) {
			expect(
				callers,
				`${waived} is waived but no longer calls the builder`,
			).toContain(waived);
		}
		// The floor counts UNWAIVED callers. Counting all of them made this
		// vacuous: the only caller today IS the waiver, so the loop body never ran
		// and a typo inside it would have gone unnoticed until a third caller
		// appeared — the "vacuity floor counting a proxy" trap in CLAUDE.md, in a
		// guard written in the same change that cites it.
		const unwaived = callers.filter((p) => !REFRESH_WAIVERS.has(p));
		for (const path of unwaived) {
			expect(
				readSource(path),
				`${path} builds template rows without refreshing the Table Topics window`,
			).toContain("refreshTableTopicsMarks");
		}
	});

	it("the schema's startup bundles stay free of application code (#679)", () => {
		// `schema.ts` interpolates `MAX_TABLE_TOPICS_SECONDS` into the CHECK, so it
		// now imports from `src/lib`. That is safe only while the imported module
		// pulls in no runtime graph of its own, because `schema.ts` is bundled into
		// two standalone scripts that gate every container start — `package.json`'s
		// `start` chains `.output/seed-catalog.mjs` and `.output/seed-templates.mjs`
		// with `&&`, so a throw in either stops the server booting — as well as
		// into drizzle-kit's own schema read.
		//
		// NOT `.output/migrate.mjs`, and an earlier version of this comment said it
		// was. `scripts/migrate.ts` imports only `drizzle-orm/node-postgres/migrator`,
		// `drizzle` and `pg`; it never touches the schema. The claim was wrong in
		// the direction that sounds most alarming, which is the kind that gets
		// repeated rather than checked.
		const schema = readSource("src/db/schema.ts");
		// EVERY specifier, not just `../`-relative brace imports. The repo's
		// preferred alias is `#/*`, so the natural way to add a heavy second import
		// — `import { x } from "#/lib/heavy"` — was invisible to the first cut of
		// this regex, as were default and bare side-effect imports.
		const specifiers = [...schema.matchAll(/\bfrom\s+"([^"]+)"/g)].map(
			(m) => m[1],
		);
		const outsideDb = specifiers.filter((s) => !s.startsWith("./"));
		expect(outsideDb.sort()).toEqual([
			"../lib/table-topics-limits",
			"drizzle-orm",
			"drizzle-orm/pg-core",
		]);
		expect(schema, "no bare side-effect import").not.toMatch(
			/^import\s+"[^"]+";/m,
		);
		const lib = readSource("src/lib/table-topics-limits.ts");
		const valueImports = [
			...lib.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+"([^"]+)"/gm),
		].map((m) => m[1]);
		expect(
			valueImports,
			"table-topics-limits must stay a leaf: only `import type`",
		).toEqual([]);
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
