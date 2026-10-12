/**
 * The meeting page's date strip fetches the past-but-after gap (#1158).
 *
 * ## Why a source guard
 *
 * `loadPastMeetings({ after })` and `buildMeetingNavItems` are tested directly,
 * but what hands the first to the second lives in the route's loader, which
 * vitest cannot reach. Dropping `after` from that call (so it returns the
 * newest archive page, not the gap) or adding a `before` (so it stops being a
 * window from the viewed meeting) leaves every other test green and puts the
 * hole back in the strip. Reads comment-blind through `readSource`, since the
 * loader's own comments name these keys.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

/** Every `listPastMeetings({ data: { … } })` argument object in the route. */
function pastMeetingsCalls(src: string): string[] {
	return [...src.matchAll(/listPastMeetings\(\{\s*data:\s*\{([^}]*)\}/g)].map(
		(m) => m[1] ?? "",
	);
}

describe("meeting page → date strip gap wiring (#1158)", () => {
	const src = readSource(ROUTE);
	const calls = pastMeetingsCalls(src);
	const gapCall = calls.find((c) => /\bafter\b/.test(c));

	it("makes a backward-window call and a gap call", () => {
		expect(calls).toHaveLength(2);
		expect(gapCall, "no listPastMeetings call passes `after`").toBeTruthy();
	});

	it("anchors the gap at the viewed meeting, with no `before`", () => {
		expect(gapCall).toMatch(/after:\s*viewedAt\.toISOString\(\)/);
		expect(gapCall).not.toMatch(/\bbefore\b/);
	});

	it("runs the gap beside the backward window and feeds both into the strip", () => {
		expect(src).toMatch(/Promise\.all\(\[\s*listPastMeetings/);
		expect(src).toMatch(
			/\[\.\.\.\(past\?\.meetings \?\? \[\]\), \.\.\.\(gap\?\.meetings \?\? \[\]\)\]/,
		);
	});

	it("skips the gap fetch for a meeting that is not in the past", () => {
		expect(src).toMatch(/viewedAt\.getTime\(\) < Date\.now\(\)\s*\?/);
	});
});
