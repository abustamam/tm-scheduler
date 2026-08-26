// `meetings.ts` must not query the `guests` table itself (#637).
//
// ## The bug this pins
//
// `loadMeetingDetail` built the assign picker's guest list with its own
// `select ... from guests where club_id = ?` and NO stage filter, so the meeting
// page offered every guest in the club — `joined` and `lost` included. Assigning
// a converted one writes `assigned_guest_id` onto a slot for somebody who is a
// MEMBER, re-splitting a human whose two records were just joined up (#635).
//
// `listClubGuests` (`guests-logic.ts`) had the correct filter the whole time,
// and a comment saying exactly why converted guests must be excluded. The copy
// simply never called it. One seam, one inline duplicate, and the duplicate is
// the one the UI used — the same shape `attendance-plan-store.guard.test.ts`
// polices for `meeting_attendance_plan`.
//
// ## Why a source guard rather than a behavioural test
//
// `loadMeetingDetail` is a module-private function inside a `createServerFn`
// module. It is not exported, and a server-fn module cannot be imported in
// vitest, so nothing could reach the query — which is exactly why a filter this
// obviously wrong survived since #151 while the seam beside it had coverage.
// The assign-picker behaviour IS now covered at the seam
// (`guests.integration.test.ts` / `guest-pipeline.integration.test.ts`); what
// this adds is that the meeting page keeps USING that seam.
//
// Reads RAW, not comment-blind: this asserts an OFFENDER IS ABSENT, so a comment
// mentioning the table can only ever produce a false FAILURE, and stripping
// comments would loosen it. Same rule as `no-tel-links.guard.test.ts`. Note this
// file's own header names `guests` repeatedly — which is why the assertion below
// targets the drizzle SYMBOL in a query position, not the bare word.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");
const MEETINGS = resolve(ROOT, "src/server/meetings.ts");

describe("meetings.ts sources guests only through listClubGuests (#637)", () => {
	it("does not import the guests table", () => {
		// The import is the tightest possible signal: with the inline query gone,
		// `meetings.ts` has no reason to name the table at all, and re-adding the
		// import is the first keystroke of re-adding the query.
		//
		// Sliced from the matching `import {`, NOT a fixed offset back. The first
		// version took `indexOf(...) - 400`, and that import sits ~317 bytes into
		// the file — so the start was NEGATIVE, which `String.slice` reads as an
		// offset from the END, producing start > end and an empty string. The
		// assertion passed on every input, including the exact bug it exists to
		// catch. Found by re-adding the inline query and watching this one stay
		// green while its two neighbours went red.
		const src = readFileSync(MEETINGS, "utf8");
		const end = src.indexOf('} from "#/db/schema"');
		expect(
			end,
			"meetings.ts no longer imports from #/db/schema",
		).toBeGreaterThan(-1);
		const start = src.lastIndexOf("import {", end);
		expect(start).toBeGreaterThan(-1);
		const schemaImport = src.slice(start, end);
		// Sanity: the slice must actually contain the import's other members, or a
		// future refactor could empty it out and make this vacuous again.
		expect(schemaImport).toMatch(/\bmeetings,/);
		expect(
			schemaImport,
			"meetings.ts imported the `guests` table again — the assign picker's list belongs to listClubGuests, which filters out joined and lost guests",
		).not.toMatch(/\bguests,/);
	});

	it("calls listClubGuests", () => {
		// The positive half. Without it this file would pass on a meetings.ts that
		// dropped the guest list entirely, which is not the fix — the picker still
		// has to be populated.
		const src = readFileSync(MEETINGS, "utf8");
		expect(src).toMatch(/listClubGuests\(/);
	});

	it("does not select guest contact columns onto the meeting payload", () => {
		// `listClubGuests` also returns `email` and `phone` for the VP-Membership
		// board. The meeting payload has never carried guest contact details, so
		// the call site projects to `{ id, name }`. Passing the seam's rows through
		// unprojected would widen PII on this page as a silent side effect.
		const src = readFileSync(MEETINGS, "utf8");
		const at = src.indexOf("listClubGuests(");
		expect(at).toBeGreaterThan(-1);
		const callSite = src.slice(at, at + 220);
		expect(callSite).toMatch(/\bid:/);
		expect(callSite).toMatch(/\bname:/);
		expect(
			callSite,
			"the meeting payload's guest rows must stay {id, name}",
		).not.toMatch(/\b(email|phone)\b/);
	});
});
