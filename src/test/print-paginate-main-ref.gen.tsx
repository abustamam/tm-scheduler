/**
 * Writes `src/components/agenda/__snapshots__/print-paginate-main-baseline.json`
 * (#1227): what Timing printed on `main` before it could paginate.
 *
 * The stored markup's font weights were remapped by script in #1402 (800 to 700, 500 to
 * 400/600), so regenerating from the documented commit would reintroduce the old weights and
 * must be followed by the same remap.
 *
 * Regenerate, ONLY from a checkout of the commit before #1227 (a later commit
 * renders through the code the snapshot exists to check):
 *
 *   git worktree add --detach <scratch> <commit before #1227>
 *   ln -s <repo>/node_modules <scratch>/node_modules
 *   cp print-paginate-main-ref{,-entry}.tsx print-paginate-main-ref.gen.tsx \
 *      <scratch>/src/test/
 *   cd <scratch> && CHROME_PATH=<chrome-headless-shell> \
 *      bun src/test/print-paginate-main-ref.gen.tsx
 *   cp <scratch>/src/components/agenda/__snapshots__/print-paginate-main-baseline.json \
 *      <repo>/src/components/agenda/__snapshots__/
 *   git worktree remove --force <scratch>
 *
 * Two parts: `markup` (`renderToStaticMarkup` of Timing at both densities for
 * each `MARKUP_FIXTURES`) and `reference` (the whitespace-collapsed text of the
 * run-of-show box of the single compact sheet 2, read in Chrome before any
 * effect, per `REFERENCE_FIXTURES`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PRINT_PAGE_CSS } from "#/components/agenda/print-theme";
import { runClientEntry } from "#/test/client-bundle-chrome";
import {
	MARKUP_FIXTURES,
	markupKey,
	timingMarkup,
} from "#/test/print-paginate-main-ref";

const OUT = resolve(
	__dirname,
	"../components/agenda/__snapshots__/print-paginate-main-baseline.json",
);

const markup: Record<string, string> = {};
for (const fixture of MARKUP_FIXTURES)
	for (const density of ["regular", "compact"] as const)
		markup[markupKey(fixture, density)] = timingMarkup(fixture, density);

const reference = await runClientEntry<Record<string, string>>(
	"src/test/print-paginate-main-ref-entry.tsx",
	PRINT_PAGE_CSS,
	{},
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ markup, reference }, null, "\t")}\n`);
console.log(
	`wrote ${OUT}: ${Object.keys(markup).length} markup, ${Object.keys(reference).length} reference`,
);
