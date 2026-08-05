/**
 * The speaker-detail caps (#522) are only a defence if the modules that write
 * and render those fields actually COMPOSE them — and neither fact has a
 * behavioural test surface here.
 *
 * `slots.ts` is a server-fn module: `updateSpeakerDetailsSchema` and
 * `claimSchema` are private and reach the world only through a
 * `createServerFn` validator, which vitest cannot invoke outside a request
 * context. Swapping the truncating schema back for the rejecting one — or
 * dropping both for `z.any()` — leaves every other test in this repo green.
 *
 * `minutes-pdf-logic.ts` is grepped for a WEAKER reason, and an earlier version
 * of this comment overstated it. It claimed `renderMinutesPdf` was "not
 * reachable from a unit test at all". That is false — `minutes-pdf-bounds.test.ts`
 * mocks `#/db` and `./minutes-logic` and renders the real entry point, the same
 * way `role-sheets-pdf-logic.test.ts` already did. That behavioural test is the
 * real defence and it is where the bound is proven.
 *
 * These greps still earn their place beside it: a behavioural test proves the
 * OUTPUT is bounded, but cannot say WHICH cap did it, so a `cap()` call left
 * with the wrong argument on a rarely-rendered section can hide behind a
 * bounded total. The grep pins each call site by name.
 *
 * ## Two source reads, deliberately
 *
 * `guard-source.ts` documents that these two assertion shapes must read source
 * DIFFERENTLY, and the first version of this file got it wrong by running
 * everything through the stripper:
 *
 * - "this pattern must BE present" → read COMMENT-BLIND (`readSource`). A
 *   comment that merely mentions the pattern would otherwise satisfy the
 *   assertion, which is a real bypass.
 * - "this offender must be ABSENT" → read RAW (`readFileSync`). Stripping can
 *   only ever DELETE text a negative might have matched, so it loosens the
 *   guard. The stripper's own documented limitation makes that concrete: it
 *   does not track template literals, so a `//` inside one blanks the rest of
 *   the line and could hide a genuinely uncapped `${p.speechTitle}`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SERVER = join(process.cwd(), "src", "server");

/** Comment-blind. For "must BE present" only. */
const slots = () => readSource(join(SERVER, "slots.ts"));
const minutesPdf = () => readSource(join(SERVER, "minutes-pdf-logic.ts"));

/** Raw. For "must be ABSENT" only — stripping would loosen these. */
const slotsRaw = () => readFileSync(join(SERVER, "slots.ts"), "utf8");
const minutesPdfRaw = () =>
	readFileSync(join(SERVER, "minutes-pdf-logic.ts"), "utf8");

describe("slots.ts composes the right speaker-details schema per path", () => {
	it("uses the TRUNCATING variant for updateSpeakerDetails", () => {
		// The edit sheet prefills and resubmits the fields it renders, so a value
		// stored before #522 must not block edits to the others.
		expect(slots()).toMatch(/speakerDetails:\s*speakerDetailsUpdateSchema/);
	});

	it("uses the REJECTING variant for claimSlot", () => {
		// Nothing is prefilled on a fresh claim, so an error is actionable and
		// silently truncating what someone just typed would be the worse failure.
		expect(slots()).toMatch(
			/speakerDetails:\s*speakerDetailsSchema\.optional\(\)/,
		);
	});

	it("imports both from the schema module rather than redeclaring either", () => {
		expect(slots()).toMatch(
			/speakerDetailsUpdateSchema[\s\S]*?from "\.\/speaker-details-schema"/,
		);
		expect(slotsRaw()).not.toMatch(/speakerDetails:\s*z\.(any|unknown|object)/);
	});
});

describe("minutes-pdf-logic.ts bounds every list it renders", () => {
	// The per-row string caps bound each item; these bound how many items there
	// are, which is the other half. react-pdf's cost is super-linear in row
	// count even when every row is short (5,000 short rows = 19.6s measured),
	// and `addSpeakerSlot` grows the program with no session via the
	// `tmod-self-assert` path.
	// `minutes.awards` is deliberately absent: `loadMinutes` builds it from the
	// fixed AWARD_CATEGORIES enum, so it is always exactly three rows and a cap
	// there could never fire.
	it.each([
		["program", "programRows"],
		["minutes.tableTopicsSpeakers", "tableTopicsRows"],
	])("slices %s before mapping it", (list, capKey) => {
		expect(minutesPdf()).toMatch(
			new RegExp(
				`${list.replace(".", "\\.")}\\s*\\n?\\s*\\.slice\\(0,\\s*MINUTES_RENDER_CAPS\\.${capKey}\\)`,
			),
		);
	});
});

describe("minutes-pdf-logic.ts caps the program-list strings", () => {
	it("caps the speech title with the SHARED write-side limit", () => {
		// Reading `SPEAKER_LIMITS.speechTitle` rather than a second literal is what
		// keeps the write cap and the render cap from drifting apart.
		expect(minutesPdf()).toMatch(
			/cap\(\s*p\.speechTitle\s*,\s*SPEAKER_LIMITS\.speechTitle\s*\)/,
		);
	});

	it("caps the assignee name and the role name", () => {
		// Defence in depth, not a hole: the PUBLIC guest self-add is already
		// bounded (`guestBookSchema`, 120), and the name writes that stay
		// unbounded are admin-gated. This cap covers what a write cap cannot — a
		// row written before any cap, and a future write path added without one.
		const src = minutesPdf();
		expect(src).toMatch(
			/cap\(\s*p\.assigneeName\s*,\s*MINUTES_RENDER_CAPS\.name\s*\)/,
		);
		expect(src).toMatch(
			/cap\(\s*p\.roleName\s*,\s*MINUTES_RENDER_CAPS\.roleName\s*\)/,
		);
	});

	it("caps the header, attendance, Table Topics and awards strings too", () => {
		// The first version of #522 capped only the Program row, while the SAME
		// synchronous document laid out six other user strings — one of them
		// (`theme`) writable with no session at all.
		const src = minutesPdf();
		for (const [expr, capKey] of [
			["meeting.theme", "theme"],
			["meeting.wordOfTheDay", "word"],
			["s.name", "name"],
			["s.topic", "topic"],
			["a.name", "name"],
		]) {
			// `,?` because the formatter wraps longer calls across lines and adds a
			// trailing comma before the closing paren.
			expect(src).toMatch(
				new RegExp(
					`cap\\(\\s*${expr.replace(".", "\\.")}\\s*,\\s*MINUTES_RENDER_CAPS\\.${capKey}\\s*,?\\s*\\)`,
				),
			);
		}
		// The attendance roster is bounded BEFORE it is joined, inside `names()`,
		// rather than by capping the joined line afterwards — capping after the
		// join leaves the build cost scaling with the input.
		expect(src).toMatch(/\.slice\(0,\s*MINUTES_RENDER_CAPS\.nameRows\)/);
		expect(src).toMatch(/cap\(x\.name, MINUTES_RENDER_CAPS\.name\)/);
		// …and the joined result is capped too, which is cheap because the slice
		// above already bounded its input.
		expect(src).toMatch(/MINUTES_RENDER_CAPS\.namesLine/);

		// The club name is capped ONCE into a local, then reused for both the
		// document title and the header.
		expect(src).toMatch(
			/cap\(\s*club\?\.name[^,]*,\s*MINUTES_RENDER_CAPS\.club\s*,?\s*\)/,
		);
	});

	it("interpolates none of the user strings raw into the document", () => {
		// The assertions above prove a capped call EXISTS; this proves no uncapped
		// interpolation survives beside it. Read RAW — see the header.
		const src = minutesPdfRaw();
		// Full expressions, not bare field names — these have five different
		// receivers (`p.`, `s.`, `a.`, `r.`, `meeting.`).
		for (const field of [
			"p\\.speechTitle",
			"p\\.assigneeName",
			"p\\.roleName",
			"s\\.name",
			"s\\.topic",
			"a\\.name",
			"r\\.names",
			"meeting\\.theme",
			"meeting\\.wordOfTheDay",
		]) {
			// The three ways the value could be rendered whole. Spelled out rather
			// than inferred with a lookahead: a "field not followed by cap()"
			// pattern false-positives on the legitimate `${cap(p.roleName, …)}`,
			// because there the `cap` sits BEFORE the field.
			for (const form of [
				`\\$\\{\\s*${field}\\s*\\}`,
				`\\$\\{\\s*String\\(\\s*${field}\\s*\\)\\s*\\}`,
				`\\$\\{\\s*${field}\\s*\\?\\?[^}]*\\}`,
			]) {
				expect(src).not.toMatch(new RegExp(form));
			}
		}
	});

	it("reuses the audited cap() rather than a second slice", () => {
		// That function has now had TWO defects found in it by review — a
		// full-input spread (#519) and an astral-plane bypass (#522) — so a
		// hand-rolled second copy is the wrong kind of duplication.
		expect(minutesPdf()).toMatch(/import \{ cap \} from "#\/lib\/cap"/);
	});
});
