/**
 * Generates the blank, GavelUp-branded role sheets served from
 * `public/role-sheets/*.pdf` (#310). Original content — NO Toastmasters
 * International copyrighted material. Run manually and commit the output:
 *
 *   bun run build:role-sheets
 *
 * The sheet layout lives in `src/server/role-sheet-layout.ts` — shared with the
 * meeting-aware, server-rendered sheets (#311) so blank and pre-filled variants
 * can't drift. This script just renders each sheet blank (no fill) and writes
 * the PDF.
 *
 * Forgetting to run it is caught by `src/server/role-sheet-artifacts.test.ts`
 * (#515), which renders every sheet and compares the drawing operators against
 * the committed file. That gate lives in `bun run test` rather than a CI workflow
 * step, but NOT because a byte-level step is impossible — an earlier version of
 * this comment claimed that and was wrong. Renders here are reproducible once
 * `/CreationDate` and the trailer `/ID` are normalised; `src/test/pdf-content.ts`
 * has the measurement and the reasons the test gate is still the better one.
 *
 * The output is reproducible only as far as the machine, though: re-render on a
 * different OS or zlib and the compressed bytes may differ while the drawing
 * operators do not. That is invisible to the gate by design, so if you are
 * diffing these files by hand, inflate first.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { buildRoleSheetDoc, ROLE_SHEETS } from "../src/server/role-sheet-layout";

const OUT = resolve(process.cwd(), "public", "role-sheets");
mkdirSync(OUT, { recursive: true });

for (const { key, file } of ROLE_SHEETS) {
	const buf = await renderToBuffer(
		buildRoleSheetDoc(key) as Parameters<typeof renderToBuffer>[0],
	);
	writeFileSync(resolve(OUT, file), buf);
	console.log(`wrote public/role-sheets/${file}`);
}
