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
 * Dialogs that may carry their own `max-h` / `overflow-y-auto`, with a reason.
 *
 * Empty on purpose. The primitive covers every dialog now, and a local override
 * is how this defect stayed open through two sightings: both Pathways dialogs
 * patched themselves with `max-h-[80vh] overflow-y-auto` and nobody fixed the
 * shared component, so every other dialog in the app kept the bug. A new entry
 * here should be a deliberate, explained exception, not a reflex.
 */
const REVIEWED_LOCAL_OVERRIDES: Record<string, string> = {};

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

describe("no dialog re-solves height locally (#619)", () => {
	it("has no un-waived local max-h / overflow override on a DialogContent", () => {
		// Reads RAW — offender list, see the header.
		const offenders: string[] = [];
		for (const file of tsxFiles(resolve(ROOT, "src"))) {
			if (file === DIALOG) continue;
			const src = readFileSync(file, "utf8");
			// Every `<DialogContent …>` opening tag in the file, with its props.
			for (const m of src.matchAll(/<DialogContent\b[^>]*>/g)) {
				if (!/max-h-\[|overflow-y-(auto|scroll)/.test(m[0])) continue;
				const rel = relative(ROOT, file);
				if (rel in REVIEWED_LOCAL_OVERRIDES) continue;
				offenders.push(`${rel}: ${m[0].slice(0, 90)}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
