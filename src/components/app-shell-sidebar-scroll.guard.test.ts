import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The desktop sidebar must be its OWN scroll container.
 *
 * It is `position: sticky` at a pinned `h-svh`, so its box can never grow past
 * the viewport and the document scroll cannot reveal its tail. That was
 * invisible while the nav was short. It stopped being invisible once the nav
 * outgrew the fold — an officer who is also a superadmin renders ~28 items —
 * and everything below the fold, the sign-out footer included, became
 * unreachable at any window height, with no scrollbar to say so. The mobile
 * drawer never had the bug: `SheetContent` has carried `overflow-y-auto` since
 * it was added, which is why this only ever reproduced at `lg+`.
 *
 * Nothing else in the suite can see this. jsdom performs no layout, so a
 * rendered `<AppShell>` reports the same (zero) geometry with or without the
 * class; typecheck and lint have no view of Tailwind semantics; and the print
 * page-count harness only ever inlines `PRINT_PAGE_CSS`. So the reachable gate
 * is a source grep.
 *
 * COMMENT-BLIND (`readSource`) is mandatory here: every assertion below is of
 * the "this pattern must BE present" form, and the fix's own explanatory
 * comment sits two lines above the `<aside>` and names `overflow-y-auto`. Read
 * raw, that comment satisfies the assertion on its own and the class becomes
 * deletable with this file green — exactly the bypass `guard-source.ts` exists
 * to close.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, "app-shell.tsx");

/**
 * The first `className="…"` after an opening tag. Deliberately not a `>` scan:
 * `<SheetContent>` carries arrow-function props whose `=>` would end the tag
 * early.
 */
function classNameAfter(tag: string): string {
	const source = readSource(SHELL);
	const at = source.indexOf(tag);
	expect(at, `${tag} not found in app-shell.tsx`).toBeGreaterThan(-1);
	const match = /className="([^"]*)"/.exec(source.slice(at));
	expect(match, `no className on ${tag}`).not.toBeNull();
	return match?.[1] ?? "";
}

/**
 * The unique `className` containing `fragment`. The nav band and the footer are
 * plain `<div>`s with no tag to anchor on, and uniqueness is asserted so a
 * fragment that starts matching two elements fails loudly instead of silently
 * checking whichever came first.
 */
function classNameContaining(fragment: string): string {
	const hits = [...readSource(SHELL).matchAll(/className="([^"]*)"/g)]
		.map((m) => m[1])
		.filter((c) => c.includes(fragment));
	expect(
		hits,
		`\`${fragment}\` should match exactly one className in app-shell.tsx`,
	).toHaveLength(1);
	return hits[0];
}

/** The scrolling middle band, and the footer that must stay out of it. */
const NAV_BAND = classNameContaining("min-h-0 flex-1 flex-col");
const FOOTER = classNameContaining("rounded-xl border border-[var(--line)]");

describe("app shell sidebar scrolling", () => {
	// Control. Every assertion below is "the extracted string contains X", and
	// an extraction that silently returned "" would report the same shape as a
	// pass for the two negative-ish reads and fail confusingly for the rest.
	// Pin a class that is not under test so a broken extractor is legible.
	it("extracts the two sidebar surfaces (control)", () => {
		expect(classNameAfter("<aside")).toContain("w-[248px]");
		expect(classNameAfter("<SheetContent")).toContain("w-[284px]");
	});

	it("keeps the desktop sidebar pinned to the viewport height", () => {
		// The premise of everything below: the column overflows because its height
		// is nailed to the viewport, and being `sticky` means the document scroll
		// cannot reveal what spills out. If this is ever intentionally dropped so
		// the aside grows with the document instead, revisit the scroller rather
		// than deleting this — they are one invariant.
		expect(classNameAfter("<aside")).toMatch(/\bh-(svh|dvh|lvh|screen)\b/);
	});

	it("puts the scroller on the nav band, not on either host", () => {
		// Both hosts are fixed-height flex columns and NEITHER scrolls: the
		// scroller sits on `SidebarInner`'s middle band, so the brand and the
		// sign-out footer stay put while the nav moves. A host that scrolls again
		// takes the footer with it — that is the bug this shape replaced, not a
		// second way of spelling the same fix.
		expect(classNameAfter("<aside")).not.toMatch(
			/\boverflow-y-(auto|scroll)\b/,
		);
		expect(classNameAfter("<SheetContent")).toContain("overflow-hidden");
		expect(NAV_BAND).toMatch(/\boverflow-y-(auto|scroll)\b/);
	});

	it("lets the nav band shrink below its content", () => {
		// `min-h-0` is the difference between a scroller and a box that grows. A
		// flex item defaults to `min-height: auto`, which refuses to shrink below
		// its content and hands the overflow straight back to the column — so the
		// band would carry `overflow-y-auto`, satisfy the assertion above, and
		// scroll nothing. Geometry catches this; a class-presence grep does not,
		// which is why the pair is split across this file and
		// `pinned-column-reachability.test.ts`.
		expect(NAV_BAND).toContain("min-h-0");
		expect(NAV_BAND).toContain("flex-1");
	});

	it("keeps the brand and the footer out of the scrolling band", () => {
		// If either drifts into the band, it scrolls away — which is the whole
		// defect, reintroduced one element at a time.
		expect(FOOTER).toContain("shrink-0");
		expect(FOOTER).not.toMatch(/\bmt-auto\b/);
	});
});
