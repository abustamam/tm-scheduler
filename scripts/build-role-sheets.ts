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
 * the committed file. That gate is in `bun run test`, not in a CI workflow step:
 * PDF bytes are not reproducible across machines, so `build:role-sheets` +
 * `git diff --exit-code` would be red on every run. `src/test/pdf-content.ts`
 * has the measurements.
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
