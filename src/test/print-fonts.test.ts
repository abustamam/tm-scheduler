/**
 * Which FACE the browser-backed geometry suites are measuring with.
 *
 * Those suites block the network, so Fraunces and Manrope never load and every
 * number they produce belongs to whatever the fallback resolves to. That used
 * to be the machine's answer rather than the repo's: a stock Ubuntu desktop
 * lands on Noto Sans, `ubuntu-latest` on DejaVu Sans, and the difference moved
 * the editorial agenda's fit scale from 0.7239 to 0.71603 against a 0.72 floor.
 * The density gate therefore failed on a developer's machine and passed in CI
 * on identical code, which teaches everyone to ignore the gate — and it is one
 * of the only gates here that can see a print regression at all.
 *
 * `print-fonts.conf` pins it. This file is why that pin is a mechanism rather
 * than a hope, and it earned its place twice over:
 *
 *  · `FONTCONFIG_FILE` is inert wherever fontconfig is not the font backend.
 *    macOS Chrome uses CoreText and ignores the file completely.
 *  · A malformed conf is discarded WHOLE and silently. The first draft of
 *    `print-fonts.conf` had a doubled hyphen inside an XML comment, which is
 *    illegal; fontconfig dropped the file and fell back, and every wrapper
 *    still looked healthy — the path resolved, the file existed, Chrome
 *    started. Only the numbers disagreed.
 *
 * So it measures the face instead of trusting the file, the way the suites
 * beside it measure geometry instead of trusting a class name.
 */
import { describe, expect, it } from "vitest";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
} from "./print-page-count";

const hasChrome = findChrome() !== null;

/**
 * Long enough that advance-width differences accumulate into different wrap
 * points, in a column narrow enough that they do so often.
 *
 * Both halves are load-bearing. Line boxes QUANTIZE, so a short sample in a
 * wide column reports the same height for wildly different faces: the first
 * draft of this file used one line of text at 300px and measured 90px for
 * DejaVu Sans, Noto Sans and Liberation Sans alike. A canary that cannot tell
 * the faces apart is the thing it exists to prevent.
 */
const SAMPLE = (
	"The quick brown fox jumps over the lazy dog while the club Toastmaster " +
	"introduces the next speaker and the timer watches the clock carefully."
).repeat(6);

/** The two stacks the print surfaces actually declare (`print-theme.tsx`). */
const PROBE_CSS = `
div { font-size: 16px; line-height: 1.4; width: 200px; }
#sans { font-family: 'Manrope', ui-sans-serif, system-ui, sans-serif; }
#serif { font-family: 'Fraunces', Georgia, serif; }
`;

/**
 * MEASURED 2026-09-20 on the pinned fallback. Absolute, and not stated against
 * anything the pin controls — a canary expressed in terms of its own subject
 * cannot fail.
 *
 * The control that makes `sans` mean something: the same probe measures 828 on
 * Noto Sans (a stock Ubuntu desktop's answer, the bug this pins) and 739 on
 * Liberation Sans.
 *
 * `serif` is asserted even though nothing pins it. The prepend that redirects
 * the sans stack leaves the serif stack at 694 whichever face it names, so
 * this number is a DETECTOR rather than a guarantee: if a machine or a runner
 * image ever does move it, that surfaces as this named red test instead of a
 * geometry floor failing somewhere else for no visible reason.
 */
const EXPECTED = { sans: 940, serif: 694 } as const;

describe("the faces the geometry suites measure with", () => {
	it("has a browser to measure with when running in CI", () => {
		// Mirrors its siblings: a silently absent browser reads exactly like a
		// passing gate, so in CI that is a failure rather than a skip.
		expect(
			hasChrome || !process.env.CI,
			"CI has no Chrome on PATH, so the font pin would go unverified.",
		).toBe(true);
	});

	it.skipIf(!hasChrome)(
		"resolves the blocked web fonts to the PINNED fallback",
		() => {
			const [sans, serif] = measuredHeights(
				printableDocument(
					PROBE_CSS,
					`<div id="sans">${SAMPLE}</div><div id="serif">${SAMPLE}</div>`,
				),
				["#sans", "#serif"],
			);

			const hint =
				"The geometry suites are not measuring the face they were " +
				"calibrated against, so their floors do not mean here what they " +
				"mean in CI. Check that src/test/print-fonts.conf parses " +
				"(`FONTCONFIG_FILE=src/test/print-fonts.conf fc-match sans-serif` " +
				"should answer DejaVu Sans; a malformed file fails SILENTLY), and " +
				"that DejaVu is installed. On macOS Chrome uses CoreText and " +
				"ignores fontconfig entirely.";
			expect(sans, `sans stack: ${hint}`).toBe(EXPECTED.sans);
			expect(serif, `serif stack: ${hint}`).toBe(EXPECTED.serif);
		},
		CHROME_TEST_TIMEOUT_MS,
	);
});
