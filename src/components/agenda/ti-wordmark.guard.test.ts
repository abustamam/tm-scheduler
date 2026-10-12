// Enforces ADR-0024 (as revisited by #380): GavelUp neither reproduces the
// official Toastmasters International wordmark/logo *image* in any rendered or
// exported output, nor keeps the vendored mark assets in the repository. The
// word "Toastmasters" stays (nominative fair use); the mark image does not.
//
// A source-grep guard (like server-modules.guard.test.ts) because the change is
// a negative — "this asset is not imported, and does not exist" — which a
// behavioural test can't assert. Originally this greped three deck renderers;
// #380 widened it to the whole `src/` + `extension/` tree plus an on-disk
// existence check, so re-vendoring the assets fails the build rather than
// passing silently. If someone wants the wordmark back, that needs an approved
// TI Trademark Use Request first — see docs/adr/0024-ti-trademark-safe-default.md.
//
// ONE sanctioned exception (ADR-0024, "Revisited — 2026-10-09 (meeting signs)",
// #1167): `ToastmastersLogo3Color.svg` is vendored again for the printed meeting
// sign only, on the Brand Manual v2.0 p.32 club-stationery basis. `SANCTIONED`
// names that one asset and the one file allowed to reference it; any other file
// named after a TI mark, or any other importer of the SVG, still fails.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../../..");

/** Matches an import/reference of a vendored official TI mark asset. */
const TI_MARK =
	/Toastmasters(Wordmark|Logo)\w*\.(png|svg)|ToastmastersWordmark\b/;

/**
 * The official TI mark assets that stay out of the tree: ten were deleted from
 * `src/assets/` by #380, and `ToastmastersLogo3Color.svg` is back by the
 * `SANCTIONED` exception below, so nine remain.
 */
const DELETED_ASSETS = [
	"ToastmastersLogo3Color.png",
	"ToastmastersWordmarkBlack.png",
	"ToastmastersWordmarkBlack.svg",
	"ToastmastersWordmarkColor.png",
	"ToastmastersWordmarkColor.svg",
	"ToastmastersWordmarkColorTight.png",
	"ToastmastersWordmarkWhite.png",
	"ToastmastersWordmarkWhite.svg",
	"ToastmastersWordmarkWhiteTight.png",
];

/**
 * The one asset ADR-0024's 2026-10-09 revisit (#1167) vendors again, mapped to
 * the only files that may reference it: the printed meeting sign. Repo-relative
 * paths, as `relative(ROOT, …)` yields them.
 */
const SANCTIONED: Record<string, string[]> = {
	"src/assets/ToastmastersLogo3Color.svg": [
		"src/components/agenda/meeting-sign.tsx",
	],
};

/**
 * The shipped source trees. `docs/` is deliberately exempt: the ADR and the
 * historical plans name the assets as a record of the decision, and recording a
 * decision is not reproducing a mark.
 */
const SCAN_ROOTS = ["src", "extension"];
const SKIP_DIRS = new Set([
	"node_modules",
	".output",
	".wxt",
	".vite",
	"dist",
	"build",
]);
/** Text file types that could carry an import or a URL reference to an asset. */
const SCANNED = /\.(m?[jt]sx?|cjs|cts|css|html?|json|svg)$/i;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

const sourceFiles = SCAN_ROOTS.filter((r) => existsSync(resolve(ROOT, r)))
	.flatMap((r) => walk(resolve(ROOT, r)))
	// This guard states the pattern it forbids, so it can't be its own offender.
	.filter((abs) => abs !== SELF);

describe("ADR-0024/#380: no vendored TI mark, anywhere in the shipped tree", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it("no file in src/ or extension/ is named after an official TI mark asset", () => {
		const vendored = sourceFiles
			.map((abs) => relative(ROOT, abs))
			.filter((rel) => TI_MARK.test(basename(rel)))
			.filter((rel) => !(rel in SANCTIONED));
		expect(
			vendored,
			"Official Toastmasters International mark assets are back in the tree. " +
				"Per ADR-0024 (Revisited, 2026-07-26 / #380) they must not be vendored " +
				"without an approved TI Trademark Use Request.",
		).toEqual([]);
	});

	it("the mark files deleted from src/assets do not exist on disk", () => {
		const resurrected = DELETED_ASSETS.filter((name) =>
			existsSync(resolve(ROOT, "src/assets", name)),
		);
		expect(
			resurrected,
			"These official TI mark assets were deleted by #380 and must stay deleted.",
		).toEqual([]);
	});

	it("no source file in src/ or extension/ imports or references a TI mark asset", () => {
		const offenders: string[] = [];
		for (const abs of sourceFiles) {
			if (!SCANNED.test(abs)) continue;
			// Deliberately NOT `#/test/guard-source` (which blanks comments). This
			// asserts an offender list is EMPTY, so a comment can only ever add a
			// false offender — stripping would LOOSEN the guard, not harden it. That
			// is the opposite direction from the "pattern must BE present" guards.
			const rel = relative(ROOT, abs);
			const text = readFileSync(abs, "utf8");
			if (!TI_MARK.test(text)) continue;
			// A sanctioned file may name the sanctioned asset and nothing else:
			// strip those names, and anything that still matches is an offender.
			const allowed = Object.entries(SANCTIONED)
				.filter(([, importers]) => importers.includes(rel))
				.map(([asset]) => basename(asset));
			const rest = allowed.reduce((t, name) => t.split(name).join(""), text);
			if (TI_MARK.test(rest)) offenders.push(rel);
		}
		expect(
			offenders,
			"These files import or render the official TI wordmark/logo image. " +
				"ADR-0024 forbids reproducing the mark without an approved TI " +
				"Trademark Use Request.",
		).toEqual([]);
	});

	it("the sanctioned logo exists, and the sign that is allowed to use it still does (#1167)", () => {
		// The exception cannot outlive the sign: if `meeting-sign.tsx` stops
		// referencing the SVG, the asset is an unused vendored mark and fails here.
		for (const [asset, importers] of Object.entries(SANCTIONED)) {
			expect(existsSync(resolve(ROOT, asset)), `${asset} is missing`).toBe(
				true,
			);
			for (const importer of importers) {
				// Comment-blind, and an actual import: a comment that merely names the
				// file must not keep the exception alive after the import is gone.
				expect(
					readSource(resolve(ROOT, importer)),
					`${importer} no longer imports ${asset}; delete the asset and the SANCTIONED entry, or restore the import.`,
				).toMatch(
					new RegExp(
						`import\\s+\\w+\\s+from\\s+["'][^"']*${basename(asset).replace(/\./g, "\\.")}["']`,
					),
				);
			}
		}
	});

	it("the sanctioned exception is exactly one asset, and it is not one of the nine that stay deleted", () => {
		expect(Object.keys(SANCTIONED)).toEqual([
			"src/assets/ToastmastersLogo3Color.svg",
		]);
		expect(DELETED_ASSETS).toHaveLength(9);
		expect(DELETED_ASSETS).not.toContain("ToastmastersLogo3Color.svg");
	});
});
