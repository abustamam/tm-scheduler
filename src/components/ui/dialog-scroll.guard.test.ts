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

describe("DialogContent keeps a height ceiling and a scroller (#619)", () => {
	it("declares a max-height", () => {
		expect(dialogContentClasses()).toMatch(/\bmax-h-\[/);
	});

	it("declares a vertical scroller", () => {
		expect(dialogContentClasses()).toMatch(/\boverflow-y-auto\b/);
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
 */
const HEIGHT_OVERRIDE = /max-h-\[|overflow-y-(auto|scroll)|overflow-hidden/;

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

	it("does not match a different component with the same prefix", () => {
		expect(
			dialogContentTags('<DialogContentExtra className="max-h-[1px]">'),
		).toEqual([]);
	});
});
