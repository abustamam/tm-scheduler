/**
 * The speaker-detail caps (#522) are only a defence if the modules that write
 * and render those fields actually COMPOSE them — and neither fact has a
 * behavioural test surface here.
 *
 * `slots.ts` is a server-fn module: `updateSpeakerDetailsSchema` and
 * `claimSlotSchema` are private and reach the world only through a
 * `createServerFn` validator, which vitest cannot invoke outside a request
 * context. Swapping the truncating schema back for the rejecting one — or
 * dropping both for `z.any()` — leaves every other test in this repo green.
 *
 * `minutes-pdf-logic.ts` has the same hole for a different reason:
 * `renderMinutesPdf` needs a database and a published meeting, so the one line
 * that lays out the program list is not reachable from a unit test at all.
 *
 * Read COMMENT-BLIND (`#/test/guard-source`): every assertion here is of the
 * "this pattern must BE present" form, where a comment merely mentioning the
 * pattern would be a real bypass. See that module for which guards must NOT
 * read through it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SERVER = join(process.cwd(), "src", "server");
const slots = () => readSource(join(SERVER, "slots.ts"));
const minutesPdf = () => readSource(join(SERVER, "minutes-pdf-logic.ts"));

describe("slots.ts composes the right speaker-details schema per path", () => {
	it("uses the TRUNCATING variant for updateSpeakerDetails", () => {
		// The edit sheet prefills and resubmits every field, so a value stored
		// before #522 must not block edits to the others.
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
		const src = slots();
		expect(src).toMatch(
			/speakerDetailsUpdateSchema[\s\S]*?from "\.\/speaker-details-schema"/,
		);
		expect(src).not.toMatch(/speakerDetails:\s*z\.(any|unknown|object)/);
	});
});

describe("minutes-pdf-logic.ts caps every user string it lays out", () => {
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
		// unbounded are admin-only. This cap covers what a write cap cannot — a
		// row written before any cap, and a future write path added without one.
		const src = minutesPdf();
		expect(src).toMatch(
			/cap\(\s*p\.assigneeName\s*,\s*MINUTES_RENDER_CAPS\.name\s*\)/,
		);
		expect(src).toMatch(
			/cap\(\s*p\.roleName\s*,\s*MINUTES_RENDER_CAPS\.roleName\s*\)/,
		);
	});

	it("interpolates none of the three raw into the program row", () => {
		// The assertions above prove a capped call EXISTS; this proves no uncapped
		// interpolation survives beside it. Without this, adding the cap in a new
		// expression while leaving the old one in place would pass.
		const src = minutesPdf();
		for (const field of ["speechTitle", "assigneeName", "roleName"]) {
			expect(src).not.toMatch(new RegExp(`\\$\\{\\s*p\\.${field}\\s*\\}`));
		}
	});

	it("reuses the audited cap() rather than a second slice", () => {
		// The first version of that function spread its whole input before
		// deciding whether to truncate, which recreated the DoS it existed to
		// close. A hand-rolled second copy is the wrong kind of duplication.
		expect(minutesPdf()).toMatch(
			/import \{ cap \} from "\.\/role-sheet-layout"/,
		);
	});
});
