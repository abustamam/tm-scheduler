// #1401: the meeting route hands <MeetingToolbar> the club's canonical SLUG,
// which builds its "View agenda" link (moved there from <MeetingAgenda>). The
// component's own tests inject the prop, so they cannot see the call site; the
// original bug was a uuid reaching it.
//
// The route cannot be rendered in jsdom (loader plus server fns), so the
// opening tag is read from source. Order-independent: the tag is located
// brace-aware and checked for a `clubSlug=` prop, wherever it sits among the
// others. Comment-blind (`readSource`): the route documents this prop in prose.
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

/** The text of the first `<tag …>` opening, through its closing `>`/`/>`
 *  outside any `{…}` expression, or "" when absent. */
function openingTag(src: string, tag: string): string {
	const start = src.search(new RegExp(`<${tag}(?=[\\s/>])`));
	if (start < 0) return "";
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (c === "{") depth++;
		else if (c === "}") depth--;
		else if (c === ">" && depth === 0) return src.slice(start, i + 1);
	}
	return "";
}

describe("meeting route wiring for MeetingToolbar's slug (#1401)", () => {
	const src = readSource(ROUTE);

	it("finds the tag whatever the prop order, and ignores `>` inside braces", () => {
		const tag = openingTag("<A onX={(a) => a > 1} clubSlug={s} b={1} />", "A");
		expect(tag).toContain("clubSlug={s}");
		expect(openingTag("<B x={1} />", "A")).toBe("");
	});

	it("feeds clubSlug from the route's $clubId param, never a uuid", () => {
		const tag = openingTag(src, "MeetingToolbar");
		expect(tag).not.toBe("");
		expect(tag).toMatch(/\bclubSlug=\{clubId\}/);
		// `clubId` is the `$clubId` param, destructured from useParams. It is the
		// canonical slug only because the parent route's `resolveClubOrRedirect`
		// (src/lib/club-route.ts) redirects a uuid or old slug to it before render;
		// a route without that redirect cannot trust the param this way.
		expect(src).toMatch(
			/const\s*\{[^}]*\bclubId\b[^}]*\}\s*=\s*Route\.useParams\(\)/,
		);
	});
});
