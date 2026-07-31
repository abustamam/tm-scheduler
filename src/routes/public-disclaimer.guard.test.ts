// Trademark guard (#381, wording from #256 / ADR-0024): every PUBLIC club
// surface must show the TI non-affiliation disclaimer.
//
// The signed-in app gets it free from <AppShell>'s footer. The anonymous club
// routes render their own lightweight chrome, so the disclaimer has to be added
// deliberately — and these are the surfaces guests actually land on (the shared
// sign-up sheet, a meeting agenda, the guest book, the role sheet), i.e. exactly
// where an implied-endorsement reading would arise.
//
// A source grep (the ti-wordmark.guard.test.ts pattern) rather than a render
// test, because the thing being protected is *coverage of a route set*: a NEW
// public club route added a year from now must not be able to ship without a
// footer, and no render test of today's routes can assert that.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTES = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(ROUTES, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * Strip comments before matching. These assertions are source greps, so a route
 * that merely MENTIONS `<PublicFooter />` in a comment explaining its footer
 * satisfies them exactly as well as the element does — leaving the real footer
 * deletable with this file still green. That is not hypothetical: it happened
 * while adding the Word of the Day poster route, and a mutation check (delete
 * the element, keep the comment) is what surfaced it. Stripping makes the guard
 * immune structurally, rather than asking every future author to remember.
 */
const stripComments = (s: string) =>
	s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const readRoute = (file: string) =>
	stripComments(readFileSync(resolve(ROUTES, file), "utf8"));

/** The shared footer every public club surface should reach for. */
const FOOTER_COMPONENT = "src/components/public-footer.tsx";

/**
 * Escaped (`$clubId_`) routes that legitimately don't render <PublicFooter />:
 * they are full-bleed export surfaces whose own footer treatment carries the
 * disclaimer. The mapping is a manual claim, so the test verifies BOTH ends —
 * the route really renders that component, and that component really still
 * states the disclaimer.
 */
const RENDERS_DISCLAIMER_VIA: Record<
	string,
	{ renders: string; disclaimerIn: string }
> = {
	"club.$clubId_.meeting.$meetingId.present.tsx": {
		renders: "MeetingPresent",
		disclaimerIn: "src/components/agenda/meeting-present.tsx",
	},
	"club.$clubId_.meeting.$meetingId.print.tsx": {
		// MeetingAgendaPrint ends every layout in print-theme's <DarkFooter />.
		renders: "MeetingAgendaPrint",
		disclaimerIn: "src/components/agenda/print-theme.tsx",
	},
	// NOT listed: club.$clubId_.meeting.$meetingId.word.tsx. It is hybrid — a
	// poster branch that carries the disclaimer via <DarkFooter />, and a no-word
	// fallback branch that renders <PublicFooter />. Mapping it here would check
	// only the poster branch and stop pinning the fallback's footer, which is the
	// one at risk of silent deletion; the default `else` below pins that instead.
	// The poster branch is pinned by render assertions in
	// components/agenda/word-of-the-day-poster.test.tsx.
};

const clubRoutes = readdirSync(ROUTES)
	.filter((f) => f.startsWith("club.") && f.endsWith(".tsx"))
	.sort();

/** `club.$clubId_.*` escapes the layout; `club.$clubId.*` nests inside it. */
const escapesLayout = (file: string) => file.startsWith("club.$clubId_.");

describe("public club surfaces carry the TI non-affiliation disclaimer (#381)", () => {
	it("finds the club route files (so a rename can't make this vacuous)", () => {
		expect(clubRoutes).toContain("club.$clubId.tsx");
		expect(clubRoutes.filter(escapesLayout).length).toBeGreaterThan(0);
	});

	it("the shared footer renders the canonical constant, not inlined wording", () => {
		const src = read(FOOTER_COMPONENT);
		expect(src).toMatch(
			/import\s*\{[^}]*TOASTMASTERS_DISCLAIMER[^}]*\}\s*from\s*"#\/lib\/brand"/,
		);
		expect(src).toMatch(/\{TOASTMASTERS_DISCLAIMER\}/);
	});

	// One footer on the layout's anonymous branch covers every nested public club
	// route (`/club/:clubId`, `/club/:clubId/meeting/:key`). The signed-in branch
	// is wrapped in <AppShell>, which has its own.
	it("club.$clubId.tsx renders <PublicFooter /> on the anonymous branch", () => {
		const src = readRoute("club.$clubId.tsx");
		expect(src).toMatch(/from "#\/components\/public-footer"/);
		expect(src).toMatch(/<PublicFooter\b/);
		// The anonymous branch is the code AFTER the early `return` of the
		// <AppShell> branch — that's where the footer has to be.
		const anonBranch = src.slice(src.indexOf("</AppShell>"));
		expect(
			anonBranch,
			"<PublicFooter /> must be in the anonymous branch; the signed-in branch " +
				"already gets the disclaimer from <AppShell>.",
		).toMatch(/<PublicFooter\b/);
	});

	for (const file of clubRoutes.filter(escapesLayout)) {
		const via = RENDERS_DISCLAIMER_VIA[file];
		if (via) {
			it(`${file} renders <${via.renders} />, which carries the disclaimer`, () => {
				expect(readRoute(file)).toMatch(new RegExp(`<${via.renders}\\b`));
				expect(
					read(via.disclaimerIn),
					`${via.disclaimerIn} no longer references TOASTMASTERS_DISCLAIMER, so ` +
						`${file} has silently lost it. Add <PublicFooter /> to the route.`,
				).toMatch(/TOASTMASTERS_DISCLAIMER/);
			});
			continue;
		}
		it(`${file} escapes the club layout, so it renders <PublicFooter /> itself`, () => {
			const src = readRoute(file);
			expect(
				src,
				`${file} is a PUBLIC club surface outside the /club/$clubId layout, so ` +
					`it must render <PublicFooter /> (or be added to ` +
					`RENDERS_DISCLAIMER_VIA with the component that carries the disclaimer).`,
			).toMatch(/<PublicFooter\b/);
			expect(src).toMatch(/from "#\/components\/public-footer"/);
		});
	}
});
