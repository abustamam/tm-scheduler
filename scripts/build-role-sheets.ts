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
