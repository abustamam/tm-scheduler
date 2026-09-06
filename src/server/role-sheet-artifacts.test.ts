/**
 * The gate that keeps `public/role-sheets/*.pdf` honest to
 * `src/server/role-sheet-layout.ts` (#515).
 *
 * Those five PDFs are build artifacts. `bun run build:role-sheets` renders them
 * and a human commits the result, and until this file existed the ONLY thing
 * keeping them in step with the layout was remembering to run that script.
 * Forgetting has shipped wrong sheets to a live club twice: #507 printed "Amber"
 * on all five while the layout said "Yellow", and `ah-counter.pdf` sat on `main`
 * with one table column ~1.25× wider than the layout's nine equal columns.
 *
 * Every other role-sheet assertion in this repo — the "What to say" block, the
 * one-page guarantee, the absent speaker pre-fill — renders the document FRESH
 * and inspects it in memory. None of them reads the file `/resources` and the
 * meeting page actually serve, so all of them stayed green through both.
 *
 * This runs inside `bun run test`, which CI already runs, so it needs no
 * `.github/workflows/ci.yml` step. It is NOT the only workable gate, and an
 * earlier version of this comment wrongly said so — the byte-level step #515
 * asked for (`build:role-sheets`, normalise, `git diff --exit-code`) is viable,
 * and `src/test/pdf-content.ts` has both the measurement that refuted the claim
 * and the four reasons this one is still the better artifact.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import {
	describePdfDrift,
	isUninflated,
	readPdfContent,
} from "#/test/pdf-content";
import { buildRoleSheetDoc, ROLE_SHEETS } from "./role-sheet-layout";

/**
 * Derived from this file, not `process.cwd()`, so the gate reads the same five
 * files however vitest was invoked.
 */
const SHEETS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"public",
	"role-sheets",
);

const REBUILD =
	"Run `bun run build:role-sheets` and commit public/role-sheets/*.pdf.";

describe("the committed role sheets match the layout", () => {
	it.each(
		ROLE_SHEETS.map((s) => [s.key, s.file] as const),
	)("public/role-sheets/%s.pdf is what the layout renders today", async (key, file) => {
		// The blank template: no `fill`, exactly as `scripts/build-role-sheets.ts`
		// renders it. The meeting-aware variant has no committed artifact to drift.
		const rendered = await renderToBuffer(
			buildRoleSheetDoc(key) as Parameters<typeof renderToBuffer>[0],
		);
		const committed = readPdfContent(readFileSync(resolve(SHEETS_DIR, file)));
		// Vacuity floor. "These two agree" is the same sentence whether the reader
		// found a sheet full of drawing operators or found nothing at all, and a
		// gate that compares two empty parses is indistinguishable from a passing
		// one — the failure shape `print-page-count` hit with Chrome happily
		// writing a valid one-page PDF for an empty body (CODING_STANDARDS.md,
		// "Test coverage"). Assert there is something to compare, out loud.
		expect(committed.pages).toBe(1);
		expect(committed.streams).toHaveLength(1);
		expect(committed.streams[0].length).toBeGreaterThan(1_000);
		// Named separately from the length floor because the failure is different
		// in KIND, not degree: an opaque stream silently demotes this gate from
		// comparing layout to comparing compression, and two mis-delimited streams
		// hash equal. Assert it on both sides, so the message says which.
		expect(committed.streams.filter(isUninflated)).toEqual([]);
		expect(readPdfContent(rendered).streams.filter(isUninflated)).toEqual([]);

		const drift = describePdfDrift(committed, readPdfContent(rendered));
		expect(
			drift,
			`public/role-sheets/${file} is stale.\n${drift}\n${REBUILD}`,
		).toBeNull();
	});

	it("reports drift when the two really do differ", () => {
		// The control. Every assertion above is an equality that passes when the
		// comparison is broken in the safe-looking direction, so one pair that MUST
		// come back different is what proves the gate can still fail at all.
		const [first, second] = ROLE_SHEETS;
		expect(
			describePdfDrift(
				readPdfContent(readFileSync(resolve(SHEETS_DIR, first.file))),
				readPdfContent(readFileSync(resolve(SHEETS_DIR, second.file))),
			),
		).toContain("first differing drawing operator");
	});

	it("holds no sheet the registry has stopped naming", () => {
		// A renamed or dropped sheet leaves its old PDF behind, still reachable at
		// its public URL and no longer rendered by anything — drift the per-sheet
		// comparison above cannot see, because it only looks at files it expects.
		expect(
			readdirSync(SHEETS_DIR)
				.filter((f) => f.endsWith(".pdf"))
				.sort(),
		).toEqual(ROLE_SHEETS.map((s) => s.file).sort());
	});
});
