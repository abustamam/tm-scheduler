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

describe("app shell sidebar scrolling", () => {
	// Control. Every assertion below is "the extracted string contains X", and
	// an extraction that silently returned "" would report the same shape as a
	// pass for the two negative-ish reads and fail confusingly for the rest.
	// Pin a class that is not under test so a broken extractor is legible.
	it("extracts the two sidebar surfaces (control)", () => {
		expect(classNameAfter("<aside")).toContain("w-[248px]");
		expect(classNameAfter("<SheetContent")).toContain("w-[284px]");
	});

	it("gives the desktop sidebar its own vertical scroll", () => {
		expect(classNameAfter("<aside")).toMatch(/\boverflow-y-(auto|scroll)\b/);
	});

	it("keeps the desktop sidebar pinned to the viewport height", () => {
		// The premise of the assertion above: the sidebar overflows because its
		// height is nailed to the viewport. If this is ever intentionally
		// dropped so the aside grows with the document instead, revisit that
		// test rather than deleting this one — the two are one invariant.
		expect(classNameAfter("<aside")).toMatch(/\bh-(svh|dvh|lvh|screen)\b/);
	});

	it("keeps the mobile nav drawer scrollable", () => {
		expect(classNameAfter("<SheetContent")).toMatch(
			/\boverflow-y-(auto|scroll)\b/,
		);
	});
});
