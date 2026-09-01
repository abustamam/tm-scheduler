import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { probeDialog, type VisualBox } from "#/test/dialog-keyboard-reach";
import { readSource } from "#/test/guard-source";
import { buildAppCss, candidatesIn } from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

/**
 * #619, half (b): with the on-screen keyboard up, can you still reach the
 * bottom of a dialog?
 *
 * Half (a) — the ceiling and the body scroller — shipped in v1.25.2.0 and is
 * pinned by `dialog-scroll.guard.test.ts`. It could not fix this, and the
 * reason is the whole point of this file: the ceiling is measured in `svh`,
 * `svh` resolves against the LAYOUT viewport, and the platform default
 * (`interactive-widget=resizes-visual`, since the viewport meta names no other)
 * shrinks only the VISUAL viewport. So with the keyboard up nothing overflows,
 * the scroller never engages, and the bottom of the dialog is not below the
 * fold — it is behind the keyboard.
 *
 * The measurement that opened the issue: the public identity dialog on an
 * SE-class phone is ~533px of content in a 560px layout viewport; iOS's
 * keyboard takes ~291px, leaving ~269px visible. Those are the numbers below.
 *
 * The class strings are read out of `dialog.tsx`, comment-blind — that file
 * quotes its own utilities in a long explanatory comment, and matching one of
 * those would measure documentation instead of the shipped attribute.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIALOG = resolve(HERE, "dialog.tsx");

/** An SE-class phone. */
const VIEWPORT = { width: 375, height: 560 };

/** What iOS leaves visible once its keyboard is up. */
const KEYBOARD_OPEN: VisualBox = { height: 269, offsetTop: 0 };

/** The same phone with nothing covering it. */
const NO_KEYBOARD: VisualBox = { height: 560, offsetTop: 0 };

/**
 * The `cn(...)` literal on `DialogPrimitive.Content` — the shell.
 *
 * Anchored to that element rather than to the file, so a `max-h` that moved to
 * the overlay or to a sibling primitive cannot satisfy this by accident. Same
 * slicing as `dialog-scroll.guard.test.ts`, for the same reason.
 */
function shellClasses(): string {
	const src = readSource(DIALOG);
	const at = src.indexOf("DialogPrimitive.Content");
	expect(
		at,
		"dialog.tsx no longer renders DialogPrimitive.Content",
	).toBeGreaterThan(-1);
	const m = /"(fixed [^"]*)"/.exec(src.slice(at));
	expect(
		m,
		"no shell class literal after DialogPrimitive.Content",
	).not.toBeNull();
	return m?.[1] ?? "";
}

/** The scrolling body's `className`, matched by its slot rather than position. */
function bodyClasses(): string {
	const src = readSource(DIALOG);
	const at = src.indexOf('data-slot="dialog-body"');
	expect(
		at,
		"dialog.tsx no longer renders a dialog-body element",
	).toBeGreaterThan(-1);
	const m = /className="([^"]*)"/.exec(src.slice(at));
	expect(m, "no className on the dialog body").not.toBeNull();
	return m?.[1] ?? "";
}

/**
 * The public identity dialog's shape, at the sizes #619 measured: a header
 * whose description wraps to two lines, a labelled search input, a roster list
 * with its own `max-h-[40svh]` scroller, and — the part the issue is about —
 * an "I'm new" block BELOW the list.
 *
 * The roster's inner scroller earns its place in the fixture. It is capped in
 * `svh`, so it does NOT shrink when the keyboard opens; names stay reachable
 * inside it while everything positioned after it does not, which is exactly the
 * asymmetry that made the bug hard to see from a screenshot.
 */
function fixture(): string {
	const rows = Array.from(
		{ length: 12 },
		(_, i) =>
			`<button class="flex w-full items-center rounded-md px-3 py-2 text-sm">Member ${i + 1}</button>`,
	).join("");
	return `
<div class="fixed inset-0 z-50 bg-black/50"></div>
<div data-probe="shell" class="${shellClasses()}">
	<div data-probe="body" class="${bodyClasses()}">
		<div class="flex flex-col gap-2 text-center sm:text-left">
			<h2 class="text-lg leading-none font-semibold">Who are you?</h2>
			<p class="text-sm text-muted-foreground">Pick your name to continue. This just tags what you sign up for &mdash; no account needed.</p>
		</div>
		<div class="grid gap-2">
			<label class="text-sm font-medium">Search members</label>
			<input class="h-9 w-full rounded-md border px-3 py-1 text-base" value="" />
		</div>
		<div class="max-h-[40svh] overflow-y-auto rounded-md border">${rows}</div>
		<div class="border-t pt-4">
			<p class="text-sm font-medium">Don't see your name?</p>
			<div data-probe="tail" class="mt-2 flex gap-2">
				<input class="h-9 w-full rounded-md border px-3 py-1 text-base" value="" />
				<button class="h-9 shrink-0 rounded-md border px-3 text-sm">I'm new &mdash; add me</button>
			</div>
		</div>
	</div>
	<button data-probe="close" class="absolute top-4 right-4 size-4 rounded-xs opacity-70">x</button>
</div>`;
}

const SELECTORS = {
	shellSelector: '[data-probe="shell"]',
	bodySelector: '[data-probe="body"]',
	tailSelector: '[data-probe="tail"]',
	closeSelector: '[data-probe="close"]',
};

const hasChrome = findChrome() !== null;

describe("dialog keyboard harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		// A silently absent geometry gate reads exactly like a passing one, which
		// is the failure shape CLAUDE.md records for the DB-backed suites and for
		// the two print ones. Skipping locally is fine; skipping in CI is not.
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every reachability measurement would skip and " +
				"the suite would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"dialog reachability with the keyboard up (#619)",
	() => {
		let css = "";
		let html = "";

		beforeAll(async () => {
			html = fixture();
			css = await buildAppCss(candidatesIn(html));
		}, CHROME_TEST_TIMEOUT_MS);

		it(
			"keeps the whole dialog inside the visible band",
			() => {
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					box: KEYBOARD_OPEN,
					band: KEYBOARD_OPEN,
				});
				// Not "roughly fits" — the shell's own edges are inside the band. A
				// ceiling stated relative to the thing it guards would pass for any
				// value of that thing, so both edges are absolute numbers.
				expect(probe.shellTop).toBeGreaterThanOrEqual(0);
				expect(probe.shellBottom).toBeLessThanOrEqual(KEYBOARD_OPEN.height);
			},
			CHROME_TEST_TIMEOUT_MS,
		);

		it(
			"engages the body scroller, so the tail is reachable",
			() => {
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					box: KEYBOARD_OPEN,
					band: KEYBOARD_OPEN,
				});
				// The scroller EXISTING is what half (a) shipped; the scroller having
				// something to scroll is what this half adds. Assert it moved, because
				// `scrollTop = scrollHeight` on a box that cannot scroll silently
				// leaves 0 and every later assertion still reads plausibly.
				expect(probe.bodyOverflows).toBe(true);
				expect(probe.scrolledBy).toBeGreaterThan(0);
				expect(probe.tailInsideVisibleBand).toBe(true);
			},
			CHROME_TEST_TIMEOUT_MS,
		);

		it(
			"keeps the close button in the band while the body is scrolled",
			() => {
				// #627's fix must survive the shell shrinking: the close button is an
				// absolute child of the shell, so a shell that shrinks to 237px must
				// still put it inside the band rather than clipping it.
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					box: KEYBOARD_OPEN,
					band: KEYBOARD_OPEN,
				});
				expect(probe.closeInsideVisibleBand).toBe(true);
			},
			CHROME_TEST_TIMEOUT_MS,
		);

		it(
			"follows the visual viewport when iOS scrolls it down",
			() => {
				// iOS does not only shrink the visual viewport, it scrolls it so the
				// focused input clears the keyboard. A fix that shrinks the ceiling and
				// keeps centring on the layout viewport is correctly sized and still
				// under the keyboard, so `offsetTop` is a separate failure mode from
				// `height` and gets its own case.
				const scrolled: VisualBox = { height: 269, offsetTop: 80 };
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					box: scrolled,
					band: scrolled,
				});
				expect(probe.shellTop).toBeGreaterThanOrEqual(scrolled.offsetTop);
				expect(probe.shellBottom).toBeLessThanOrEqual(
					scrolled.offsetTop + scrolled.height,
				);
				expect(probe.tailInsideVisibleBand).toBe(true);
			},
			CHROME_TEST_TIMEOUT_MS,
		);

		it(
			"is unchanged when nothing is covering the screen",
			() => {
				// Acceptance criterion 3 on #619: the no-keyboard case must still behave
				// as v1.25.2.0 measured. At full height this dialog fits, so the
				// scroller must NOT engage — a fix that made every dialog scroll all the
				// time would pass every assertion above.
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					box: NO_KEYBOARD,
					band: NO_KEYBOARD,
				});
				expect(probe.bodyOverflows).toBe(false);
				expect(probe.shellTop).toBeGreaterThanOrEqual(0);
				expect(probe.shellBottom).toBeLessThanOrEqual(VIEWPORT.height);
				expect(probe.tailInsideVisibleBand).toBe(true);
			},
			CHROME_TEST_TIMEOUT_MS,
		);

		it(
			"centres on the layout viewport when the properties are absent",
			() => {
				// The `var()` fallbacks are the SSR and no-`visualViewport` path, and
				// they must reproduce v1.25.2.0 exactly: `100svh` ceiling, centred. If
				// this drifts, every first paint before the effect runs is wrong.
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					band: NO_KEYBOARD,
				});
				expect(probe.shellTop).toBeGreaterThanOrEqual(0);
				expect(probe.shellBottom).toBeLessThanOrEqual(VIEWPORT.height);
				// Centred: the gaps above and below the shell match within a pixel of
				// rounding.
				const below = VIEWPORT.height - probe.shellBottom;
				expect(Math.abs(probe.shellTop - below)).toBeLessThanOrEqual(1);
			},
			CHROME_TEST_TIMEOUT_MS,
		);
	},
);

/**
 * The control that makes every assertion above capable of failing.
 *
 * Publishing nothing is exactly the pre-fix rendering — `100svh`, centred on
 * the layout viewport — so this is v1.25.2.0 measured against a keyboard. If
 * these expectations ever flip, the suite above has stopped being able to tell
 * the fix from its absence, and CLAUDE.md's "a test stated relative to the
 * constant it guards cannot fail" has arrived in a new shape.
 */
describe.skipIf(!hasChrome)(
	"pre-fix control: the bug, reproduced (#619)",
	() => {
		it(
			"leaves the tail behind the keyboard and reachable by nothing",
			async () => {
				const html = fixture();
				const css = await buildAppCss(candidatesIn(html));
				const probe = probeDialog({
					bodyHtml: html,
					css,
					...SELECTORS,
					viewport: VIEWPORT,
					// No box: the class string's fallbacks apply.
					band: KEYBOARD_OPEN,
				});
				// The dialog fits the LAYOUT viewport, which is why every in-process
				// gate was happy...
				expect(probe.shellBottom).toBeLessThanOrEqual(VIEWPORT.height);
				// ...and hangs below the keyboard line anyway.
				expect(probe.shellBottom).toBeGreaterThan(KEYBOARD_OPEN.height);
				// Nothing overflows, so the scroller half (a) added never engages.
				expect(probe.bodyOverflows).toBe(false);
				expect(probe.tailInsideVisibleBand).toBe(false);
				// And the document cannot scroll a fixed box back, so there is no
				// escape hatch: the control is not "below the fold", it is unreachable.
				expect(probe.tailReachableByPageScroll).toBe(false);
			},
			CHROME_TEST_TIMEOUT_MS,
		);
	},
);
