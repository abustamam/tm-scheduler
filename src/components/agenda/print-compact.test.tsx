// @vitest-environment jsdom
/**
 * Compact run of show (#1226): a long agenda keeps the layout the club chose.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENDA_LAYOUTS } from "#/lib/agenda-layouts";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	type AgendaLayout,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";

const BASELINE_PATH = resolve(
	__dirname,
	"__snapshots__",
	"print-compact-baseline.json",
);
const QR = "https://example.test/meeting";

function mcfMarkup(layout: AgendaLayout): string {
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={MCF_HEADER}
			roles={MCF_ROLES}
			officers={MCF_OFFICERS}
			explainers={MCF_EXPLAINERS}
			rows={MCF_ROWS}
			qrUrl={QR}
		/>,
	);
}

describe("regular density is the markup that shipped", () => {
	// protects=an agenda that fits prints exactly as it did before #1226
	// fails_when=any byte of an MCF layout's static markup differs from the baseline
	//   committed before the change (a regular-density style, wrapper or key leaking out)
	// no_claim=what a long agenda renders at compact, or what Chrome measures
	for (const layout of AGENDA_LAYOUTS) {
		it(`${layout}: MCF markup is byte-identical to the baseline`, () => {
			const actual = mcfMarkup(layout);
			if (process.env.WRITE_PRINT_COMPACT_BASELINE === "1") {
				let baseline: Record<string, string> = {};
				try {
					baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
				} catch {
					// first write
				}
				baseline[layout] = actual;
				mkdirSync(dirname(BASELINE_PATH), { recursive: true });
				writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, "\t")}\n`);
			}
			const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<
				string,
				string
			>;
			expect(actual).toBe(baseline[layout]);
		});
	}
});
