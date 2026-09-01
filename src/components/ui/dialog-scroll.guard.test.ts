// Enforces that `DialogContent` keeps a height ceiling AND a scroller (#619).
//
// ## Why a source grep
//
// jsdom performs no layout, so no in-process test can observe this: the defect
// is a property of rendered geometry, the same blind spot CLAUDE.md records for
// print CSS and for `pinned-column-reachability.test.ts`. It was measured in a
// real browser instead — the public identity dialog at a 375x400 viewport
// rendered 457px tall, centred at top=-28, with the "I'm new — add me" control
// at y=404 and NO scrollable ancestor between it and the body. Not below the
// fold: unreachable, because `DialogContent` is `fixed` and a fixed box is not
// in the document's scroll flow.
//
// ## The COMBINATION is the fact, not either class
//
// `overflow-y-auto` with no ceiling is a box that grows instead of scrolling,
// and it satisfies any grep that only asks whether the class is present. A
// ceiling with no `overflow-y-auto` clips with no way to scroll. So both
// assertions below exist, and neither is redundant. This is the same lesson
// `pinned-column-reachability.test.ts` encodes for `overflow-y-auto` on a flex
// child with no `min-h-0`.
//
// ## Read direction
//
// The primitive assertions read COMMENT-BLIND (`readSource`): they are
// "this pattern must BE present", so a comment merely quoting the class would
// satisfy a raw read while the real class was gone — a false PASS, which is the
// bypass `src/test/guard-source.ts` exists to close. This file's own header
// quotes those classes, which is exactly the situation that makes it necessary.
//
// The call-site sweep at the bottom reads RAW: it asserts an OFFENDER LIST IS
// EMPTY, where a comment can only ever add a FALSE offender. Stripping there
// would loosen the guard rather than harden it. Same file, opposite directions,
// same rule as `no-tel-links.guard.test.ts`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DIALOG_VIEWPORT_HEIGHT,
	DIALOG_VIEWPORT_TOP,
} from "#/lib/dialog-viewport";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../../..");
const DIALOG = resolve(ROOT, "src/components/ui/dialog.tsx");

/**
 * The `cn(...)` class string on `DialogPrimitive.Content`. Scoped to that
 * element rather than the whole file, so a `max-h` added to `DialogOverlay` or
 * to a sibling primitive cannot satisfy these assertions by accident.
 */
function dialogContentClasses(): string {
	const src = readSource(DIALOG);
	const at = src.indexOf("DialogPrimitive.Content");
	expect(
		at,
		"dialog.tsx no longer renders DialogPrimitive.Content — this guard is pointed at the wrong element",
	).toBeGreaterThan(-1);
	// Up to the closing of that element's props. Bounded by the next JSX close
	// so a later primitive in the same file cannot leak in.
	const end = src.indexOf(">", src.indexOf("{...props}", at));
	return src.slice(at, end === -1 ? undefined : end);
}

/**
 * The class string on the scrolling BODY — the inner element that carries the
 * scroller since #627 split it off the shell.
 *
 * Matched by `data-slot="dialog-body"` rather than by position, so reordering
 * the shell's children cannot silently point this at the close button.
 */
function dialogBodyClasses(): string {
	const src = readSource(DIALOG);
	const at = src.indexOf('data-slot="dialog-body"');
	expect(
		at,
		"dialog.tsx no longer renders a dialog-body element — the shell/body split (#627) has collapsed, which puts the close button back inside the scroller",
	).toBeGreaterThan(-1);
	const end = src.indexOf(">", at);
	return src.slice(at, end === -1 ? undefined : end);
}

describe("DialogContent keeps a height ceiling and a scroller (#619, #627)", () => {
	it("the shell declares a max-height", () => {
		expect(dialogContentClasses()).toMatch(/\bmax-h-\[/);
	});

	it("the body declares a vertical scroller", () => {
		// Moved off the shell by #627: an absolutely-positioned close button inside
		// a scroll container scrolls away with the content.
		expect(dialogBodyClasses()).toMatch(/\boverflow-y-auto\b/);
	});

	it("the body can shrink, so the scroller actually scrolls", () => {
		// `min-h-0` on a flex child is the whole difference between a box that
		// scrolls and a box that grows and gets clipped. Without it this is #619
		// again in a new shape, and the assertion above would still pass — which is
		// exactly the failure `pinned-column-reachability.test.ts` was written for.
		expect(dialogBodyClasses()).toMatch(/\bmin-h-0\b/);
	});

	it("the shell does not scroll, so the close button cannot scroll away", () => {
		// The shell must NOT carry a vertical scroller. If it does, the close
		// button — an absolute child of it — moves with the content again and #627
		// is back. Asserted as an absence because that is the actual invariant.
		const shell = dialogContentClasses();
		expect(shell).not.toMatch(/\boverflow-y-(auto|scroll)\b/);
		expect(shell).toMatch(/\boverflow-hidden\b/);
	});

	it("keeps the close button out of the scrolling body", () => {
		// Structural, not a class check: the close button must be a SIBLING of the
		// body, not inside it. Compares source offsets — the body element must
		// close before the close button opens.
		//
		// Anchored inside the `DialogPrimitive.Content` render, because this file
		// declares TWO elements carrying `data-slot="dialog-close"`: the standalone
		// `DialogClose` re-export near the top, and the built-in button down here.
		// A bare `indexOf` finds the re-export and compares the wrong pair, which
		// is how the first version of this assertion failed on correct code. Same
		// miscrediting-across-declarations shape as the fn-body splitter in
		// `member-write-authz.guard.test.ts`.
		const src = readSource(DIALOG);
		const contentAt = src.indexOf("DialogPrimitive.Content");
		expect(contentAt).toBeGreaterThan(-1);
		const bodyAt = src.indexOf('data-slot="dialog-body"', contentAt);
		const closeAt = src.indexOf('data-slot="dialog-close"', contentAt);
		expect(bodyAt, "no dialog-body inside DialogContent").toBeGreaterThan(-1);
		expect(closeAt, "no close button inside DialogContent").toBeGreaterThan(-1);
		const bodyCloseTag = src.indexOf("</div>", bodyAt);
		expect(bodyCloseTag).toBeGreaterThan(-1);
		expect(
			closeAt,
			"the close button moved inside the scrolling body — it will scroll out of view (#627)",
		).toBeGreaterThan(bodyCloseTag);
	});

	it("measures the ceiling in svh, not vh", () => {
		// `vh` is the LARGE viewport height — it assumes mobile browser chrome is
		// hidden, so a `vh` ceiling lands below the fold on exactly the devices
		// this guard exists for. The two call sites this change deleted both used
		// `max-h-[80vh]`, which is how the bug survived being noticed twice.
		const classes = dialogContentClasses();
		const ceiling = classes.match(/max-h-\[[^\]]+\]/)?.[0] ?? "";
		expect(ceiling).toContain("svh");
		expect(ceiling).not.toMatch(/[^s]vh/);
	});

	it("measures the ceiling against the VISUAL viewport, not just svh", () => {
		// #619 half (b). `svh` resolves against the LAYOUT viewport, which the
		// on-screen keyboard does not shrink, so an `svh`-only ceiling is correct
		// and simply never engages with the keyboard up. The ceiling has to read
		// the property `#/lib/dialog-viewport` publishes, and `100svh` survives as
		// the `var()` fallback for SSR and for engines with no `visualViewport`.
		const ceiling = dialogContentClasses().match(/max-h-\[[^\]]+\]/)?.[0] ?? "";
		expect(ceiling).toContain(DIALOG_VIEWPORT_HEIGHT);
		expect(ceiling).toContain("100svh");
	});

	it("centres against the VISUAL viewport too, not only sizes to it", () => {
		// Shrinking the box without moving it leaves a correctly sized dialog
		// still centred on the layout viewport — i.e. still under the keyboard.
		// `offsetTop` is what iOS reports when it scrolls the visual viewport to
		// clear a focused input, and it is a separate failure mode from height,
		// so both properties are asserted.
		const top = dialogContentClasses().match(/\btop-\[[^\]]+\]/)?.[0] ?? "";
		expect(top).toContain(DIALOG_VIEWPORT_HEIGHT);
		expect(top).toContain(DIALOG_VIEWPORT_TOP);
		expect(top).toContain("100svh");
	});

	it("wires the class string to the module that writes those properties", () => {
		// The seam that can drift SILENTLY. A Tailwind arbitrary value is scanned
		// statically, so the class string above must spell the property names as
		// literal text and cannot interpolate the constants. Rename them in
		// `dialog-viewport.ts` alone and `var()` falls back to `100svh` — the fix
		// is gone, nothing throws, and typecheck, lint and every in-process test
		// stay green. The two assertions above read the same exported constants
		// this one requires the component to import, so a rename now has to reach
		// the class string or fail here.
		const src = readSource(DIALOG);
		expect(src).toMatch(/from\s+"#\/lib\/dialog-viewport(\.ts)?"/);
		expect(src).toContain("trackVisualViewport");
	});

	it("tracks the viewport from inside Content, not beside it", () => {
		// Two failure modes, and only one position avoids both.
		//
		// In `DialogContent` itself the effect runs for every dialog COMPONENT in
		// the tree, open or not — call sites render the element unconditionally
		// and Radix decides presence internally — so the listener would stay
		// attached for the life of the page. Hence: under the portal.
		//
		// As a SIBLING of `Content` under that portal it unmounts too EARLY:
		// Radix wraps each portal child in its own `Presence`, and this one
		// declares no exit animation, so the properties clear while `Content` is
		// still fading out. Measured in the browser, that grows a closing
		// keyboard-open dialog from 237px back to 528px mid-fade. Hence: a child
		// of `Content`, whose lifetime includes the exit animation.
		const src = readSource(DIALOG);
		const contentAt = src.indexOf("<DialogPrimitive.Content");
		const syncAt = src.indexOf("<DialogViewportSync");
		const bodyAt = src.indexOf('data-slot="dialog-body"');
		expect(syncAt, "DialogViewportSync is not rendered").toBeGreaterThan(-1);
		expect(contentAt, "no DialogPrimitive.Content").toBeGreaterThan(-1);
		expect(
			syncAt,
			"DialogViewportSync must be INSIDE DialogPrimitive.Content — as a " +
				"sibling it unmounts before the close animation finishes",
		).toBeGreaterThan(contentAt);
		expect(syncAt).toBeLessThan(bodyAt);
	});

	it("still centres with a translate, which is why the ceiling is required", () => {
		// If DialogContent ever stops being fixed+centred, the failure mode this
		// guard protects changes shape and the reasoning above needs revisiting.
		// Asserted so that refactor cannot pass silently.
		const classes = dialogContentClasses();
		expect(classes).toMatch(/\bfixed\b/);
		expect(classes).toMatch(/translate-y-\[-50%\]/);
	});
});

/**
 * Dialogs that may override the primitive's height behaviour, with a reason.
 *
 * Keep this near-empty. A local override is how this defect stayed open through
 * two sightings: both Pathways dialogs patched themselves with
 * `max-h-[80vh] overflow-y-auto` and nobody fixed the shared component, so every
 * other dialog in the app kept the bug. A new entry should be a deliberate,
 * explained exception, not a reflex.
 */
const REVIEWED_LOCAL_OVERRIDES: Record<string, string> = {
	// `CommandDialog` passes `overflow-hidden p-0`, and `cn()` is tailwind-merge,
	// so `overflow-hidden` RESOLVES OVER the primitive's `overflow-y-auto` — this
	// dialog gets the ceiling without the scroller. Deliberate: cmdk owns its own
	// scrolling through `CommandList`, and a dialog-level scroller nested outside
	// it chains badly on iOS. Currently unreachable either way (zero call sites as
	// of this change), but waived rather than left to the regex so that a future
	// first call site is a decision someone made on purpose.
	"src/components/ui/command.tsx":
		"overflow-hidden is intentional; cmdk scrolls via CommandList, not the dialog",
};

function tsxFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) tsxFiles(full, acc);
		else if (entry.endsWith(".tsx") && !entry.includes(".test."))
			acc.push(full);
	}
	return acc;
}

/**
 * A call-site class that re-solves or DEFEATS the primitive's height behaviour.
 *
 * `overflow-hidden` earns its place beside the two obvious ones. `cn()` is
 * tailwind-merge, so a caller's `overflow-hidden` resolves over the primitive's
 * `overflow-y-auto` in the same property group and silently removes the
 * scroller, leaving a ceiling that clips with no way to reach the clipped part.
 * That is the ORIGINAL bug reintroduced one call site at a time, and a regex
 * matching only `overflow-y-*` cannot see it — found by review, not by the
 * first draft of this guard.
 *
 * `top-[` joined them with #619's keyboard half, and it is the subtlest of the
 * four. The shell now takes BOTH its ceiling and its centring from the visual
 * viewport, and a call site that overrides only `top` leaves the dialog
 * correctly SIZED to the space above the keyboard while still centred on the
 * layout viewport — which is to say, still behind the keyboard. That failure
 * looks like nothing at all on a desktop viewport, where the two agree.
 * Anchored on a leading token boundary so a longer utility ending in `top-`
 * cannot trip it.
 */
const HEIGHT_OVERRIDE =
	/max-h-\[|overflow-y-(auto|scroll)|overflow-hidden|[\s:"']top-\[/;

/**
 * Every `<DialogContent …>` opening tag in a file, brace-aware.
 *
 * A plain `/<DialogContent\b[^>]*>/` truncates at the FIRST `>`, and a JSX prop
 * can legitimately contain one: `meeting-export-menu.tsx` passes
 * `onCloseAutoFocus={(e) => {…}}`. There the `className` happens to be declared
 * first, so the naive regex still sees it — but that is prop ORDER, not
 * correctness. Swap the two and the sweep goes silently blind, which is the
 * false-NEGATIVE direction and the one an offender list must not have.
 *
 * So scan for the `>` at brace depth zero, skipping quoted strings. A prop value
 * containing `>` always sits inside `{}` or quotes in JSX, so depth-zero is the
 * real tag close.
 */
function dialogContentTags(src: string): string[] {
	const tags: string[] = [];
	const OPEN = "<DialogContent";
	for (let i = src.indexOf(OPEN); i !== -1; i = src.indexOf(OPEN, i + 1)) {
		// Reject `<DialogContentSomethingElse` — require a JSX name boundary.
		if (/[A-Za-z0-9_]/.test(src[i + OPEN.length] ?? "")) continue;
		let depth = 0;
		let quote: string | null = null;
		for (let j = i + OPEN.length; j < src.length; j++) {
			const c = src[j];
			if (quote) {
				if (c === quote && src[j - 1] !== "\\") quote = null;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") quote = c;
			else if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth === 0) {
				tags.push(src.slice(i, j + 1));
				break;
			}
		}
	}
	return tags;
}

describe("no dialog re-solves height locally (#619)", () => {
	it("has no un-waived local max-h / overflow override on a DialogContent", () => {
		// Reads RAW — offender list, see the header.
		const offenders: string[] = [];
		for (const file of tsxFiles(resolve(ROOT, "src"))) {
			if (file === DIALOG) continue;
			const src = readFileSync(file, "utf8");
			for (const tag of dialogContentTags(src)) {
				if (!HEIGHT_OVERRIDE.test(tag)) continue;
				const rel = relative(ROOT, file);
				if (rel in REVIEWED_LOCAL_OVERRIDES) continue;
				offenders.push(`${rel}: ${tag.slice(0, 90)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// The sweep is only as good as its tag scanner, and the naive
	// `[^>]*>` version passed the real tree by prop-order luck. These pin the
	// scanner directly so the hardening cannot rot into decoration.
	it("finds an override declared AFTER a prop containing '>'", () => {
		const src = `
			<DialogContent
				onCloseAutoFocus={(e) => { e.preventDefault(); }}
				className="max-h-[50vh] overflow-y-auto"
			>
		`;
		const tags = dialogContentTags(src);
		expect(tags).toHaveLength(1);
		expect(HEIGHT_OVERRIDE.test(tags[0] ?? "")).toBe(true);
	});

	it("does not treat a '>' inside a quoted prop as the tag close", () => {
		const src = `<DialogContent aria-label="a > b" className="overflow-hidden">`;
		const tags = dialogContentTags(src);
		expect(tags).toHaveLength(1);
		expect(HEIGHT_OVERRIDE.test(tags[0] ?? "")).toBe(true);
	});

	it("finds a call site that re-centres the dialog itself", () => {
		// The #619 keyboard half: overriding `top` alone keeps the ceiling and
		// throws away the re-centring, which reads as correct everywhere the
		// layout and visual viewports agree.
		const tags = dialogContentTags('<DialogContent className="top-[10%]">');
		expect(tags).toHaveLength(1);
		expect(HEIGHT_OVERRIDE.test(tags[0] ?? "")).toBe(true);
	});

	it("does not trip on a utility that merely ends in 'top-'", () => {
		// The token boundary earns its place: without it, any future utility
		// whose name ends in `top-` would produce a false offender, and an
		// offender list nobody trusts gets waived rather than fixed.
		const tags = dialogContentTags('<DialogContent className="scroll-mt-4">');
		expect(tags).toHaveLength(1);
		expect(HEIGHT_OVERRIDE.test(tags[0] ?? "")).toBe(false);
	});

	it("does not match a different component with the same prefix", () => {
		expect(
			dialogContentTags('<DialogContentExtra className="max-h-[1px]">'),
		).toEqual([]);
	});
});
