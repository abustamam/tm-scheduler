/**
 * THR Speaking Club's 2026-10-10 timing agenda must print on two sheets.
 *
 * In production its page 2 measured taller than `PAGE_H / MIN_FIT_SCALE`, so
 * `FitPage` stopped scaling and let the run of show FLOW onto a third sheet.
 * The page count cannot see that (see `guest-caption-print-fit.test.tsx`), so
 * this measures the natural height against the cliff directly.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { meetingHubUrlFor } from "#/lib/meeting-hub";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
} from "#/test/print-page-count";
import {
	THR_EXPLAINERS,
	THR_HEADER,
	THR_OFFICERS,
	thrAgenda,
} from "#/test/thr-agenda-fixture";
import { MeetingAgendaPrint } from "./meeting-agenda-print";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

const QR_URL = meetingHubUrlFor(
	{ clubKey: "thr-speaking-club", meetingKey: "2026-10-10" },
	"https://gavelup.app",
);

function pageTwoHeight(captions: { veena: string; david: string }): number {
	const { roles, rows } = thrAgenda(captions);
	const html = renderToStaticMarkup(
		<MeetingAgendaPrint
			layout="timing"
			header={THR_HEADER}
			roles={roles}
			officers={THR_OFFICERS}
			explainers={THR_EXPLAINERS}
			rows={rows}
			qrUrl={QR_URL}
		/>,
	);
	const [h] = measuredHeights(printableDocument(PRINT_PAGE_CSS, html), [
		".agenda-page:nth-of-type(2) [data-fit-inner]",
	]);
	return h ?? 0;
}

describe.skipIf(!findChrome())(
	"THR 2026-10-10 timing agenda",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("page 2 scales onto one sheet, with headroom, rather than flowing", () => {
			// Measured here: 1418px at the old 150px Role column and 6px rows,
			// 1287px now. Production's webfonts set the same sheet taller (1500px
			// before, past the cliff; ~1363px after). So the bound is the cliff
			// less 100px of headroom, which the old layout fails in this harness.
			const cliff = (PAGE_H - 2) / MIN_FIT_SCALE;
			const h = pageTwoHeight({ veena: "Guest", david: "Guest" });
			expect(h).toBeLessThanOrEqual(cliff - 100);
		});
	},
);
