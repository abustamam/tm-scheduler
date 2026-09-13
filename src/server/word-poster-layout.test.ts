/**
 * The meeting packet's Word of the Day page, in POINTS (#718).
 *
 * WHY THIS FILE EXISTS. `word-poster-layout.ts` is a second renderer for a
 * surface whose sizes are measured elsewhere: it takes `posterWordSize` /
 * `posterBodySize` out of `#/lib/word-poster` — px, derived against the HTML
 * poster's measure — and converts them to points on its own letter-portrait
 * page. That makes every size on this page a FUNCTION OF A CONSTANT IN ANOTHER
 * MODULE, and until #718 nothing asserted the result.
 *
 * What that cost: #718 turned the HTML poster landscape, which moved
 * `CONTENT_W` from 704px to 944px. The old single converter scaled BOTH sizes
 * by the ratio of the two measures, so the multiplier fell from 0.992 to 0.740
 * and the packet's definition and example shrank 25.4% — on a page the issue
 * explicitly required to be unchanged, with `packet-pdf.integration.test.ts`
 * asserting page COUNTS and no sizes at all, so nothing went red.
 *
 * The word did not shrink, and that is the trap rather than a mitigation: its
 * px size grew by almost exactly the ratio it was then divided by, so the two
 * cancelled and the surface that was WRONG was the one that looked untouched.
 * A reviewer checking "did the word survive" got a yes.
 *
 * So the assertions below are ABSOLUTE POINT VALUES, not relationships. A test
 * written as `posterWordPt(posterWordSize(w)) === pxToPt(w) * ratio` restates
 * the implementation and cannot fail; these are the numbers `main` shipped
 * before #718, and they are what "the packet is unchanged" means.
 */
import { describe, expect, it } from "vitest";
import { pxToPt } from "#/lib/agenda-print-type";
import { CONTENT_W, posterBodySize, posterWordSize } from "#/lib/word-poster";
import {
	buildWordPosterPage,
	CONTENT_PT,
	posterBodyPt,
	posterWordPt,
} from "./word-poster-layout";

/**
 * What this page rendered on `main` immediately before #718, in points, for a
 * short word. Recorded rather than derived — see the header.
 *
 * From `CONTENT_W = 704`, `posterWordSize("Apt") = 173`, `posterBodySize =
 * 32`, and the single converter `pxToPt(px) * (524 / (704 * 0.75))`.
 */
const SHIPPED_BEFORE = {
	word: 128.767,
	definition: 23.818,
	example: 19.531,
};

/** How far a size may drift and still count as "unchanged" for AC 3. */
const TOLERANCE = 0.01; // 1%

function fontSizeOf(style: unknown): number | undefined {
	const layers = Array.isArray(style) ? style : [style];
	for (let i = layers.length - 1; i >= 0; i--) {
		const layer = layers[i] as { fontSize?: unknown } | null | undefined;
		if (layer && typeof layer.fontSize === "number") return layer.fontSize;
	}
	return undefined;
}

/**
 * Every string of text in the built page, with the font size actually applied
 * to it.
 *
 * Walks the real element tree `buildWordPosterPage` returns rather than
 * re-deriving anything, so a change that stops threading a size to its `Text`
 * fails here too — the conversion being right is not the same claim as the
 * result reaching the page.
 */
function renderedText(
	node: unknown,
	out: { text: string; pt?: number }[] = [],
) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const child of node) renderedText(child, out);
		return out;
	}
	const props = (node as { props?: Record<string, unknown> }).props;
	if (!props) return out;
	const pt = fontSizeOf(props.style);
	const children = props.children;
	if (typeof children === "string") out.push({ text: children, pt });
	else renderedText(children, out);
	return out;
}

function sizesFor(word: string) {
	const page = buildWordPosterPage(
		{
			word,
			definition: "Lasting for a very short time; fleeting.",
			example: "The applause was ephemeral, but the lesson stayed.",
			clubName: "Downtown Toastmasters",
			dateLong: "Friday, July 31, 2026",
		},
		"k",
	);
	const text = renderedText(page);
	const find = (needle: string) => {
		const hit = text.find((t) => t.text.includes(needle));
		if (!hit) {
			throw new Error(
				`"${needle}" is not on the built page. Rendered: ${text
					.map((t) => JSON.stringify(t.text.slice(0, 24)))
					.join(", ")}`,
			);
		}
		return hit.pt;
	};
	return {
		word: find(word),
		definition: find("Lasting for a very short time"),
		example: find("The applause was ephemeral"),
	};
}

describe("the packet poster's point sizes", () => {
	// The fixture has to actually find three distinct pieces of text, or every
	// assertion below is measuring `undefined` against `undefined`.
	it("threads a size onto the word, the definition and the example", () => {
		const s = sizesFor("Apt");
		expect(typeof s.word).toBe("number");
		expect(typeof s.definition).toBe("number");
		expect(typeof s.example).toBe("number");
	});

	/**
	 * AC 3 OF #718: the meeting packet still prints letter portrait, UNCHANGED.
	 * This is the line that says so in numbers.
	 *
	 * All three must hold. The word alone passed throughout the regression.
	 */
	it("matches what main shipped before the poster turned landscape", () => {
		const s = sizesFor("Apt");
		for (const [key, before] of Object.entries(SHIPPED_BEFORE)) {
			const now = s[key as keyof typeof s] as number;
			expect(
				Math.abs(now / before - 1),
				`the packet's ${key} is ${now?.toFixed(3)}pt against the ${before}pt ` +
					"this page shipped before #718. The packet is a letter-PORTRAIT " +
					"page and nothing about the HTML poster's orientation may move it — " +
					"if CONTENT_W changed, the bug is in which converter this size uses " +
					"(see word-poster-layout.ts), not in this number.",
			).toBeLessThan(TOLERANCE);
		}
	});

	/**
	 * The two conversion rules, stated as the PROPERTY that distinguishes them,
	 * because that is the thing a future edit gets wrong.
	 */
	it("converts the body size by the unit alone — no measure ratio", () => {
		// The definition is a legibility clamp (20–32px), not a fraction of any
		// measure, so it must be exactly pxToPt and must not mention CONTENT_W.
		expect(posterBodyPt(32)).toBe(pxToPt(32));
		expect(posterBodyPt(32)).toBe(24);
		expect(posterBodyPt(20)).toBe(15);
	});

	it("converts the word size through the ratio of the two measures", () => {
		// The word IS a fraction of the measure, so it is ported as one. Written
		// out rather than compared to the implementation: this is the arithmetic
		// the docblock claims, evaluated independently.
		expect(posterWordPt(233)).toBeCloseTo((233 * CONTENT_PT) / CONTENT_W, 6);
		expect(CONTENT_PT).toBe(524);
	});

	/**
	 * And the reason the word may keep its ratio while the body may not: the
	 * ratio is what makes the word ORIENTATION-PROOF. `posterWordSize` and
	 * `CONTENT_W` move together, so their quotient barely moves — 173/704 =
	 * 24.57% portrait, 233/944 = 24.68% landscape.
	 *
	 * This is the invariant a future re-derivation has to preserve, and it is
	 * also what caught the 220px search-ceiling bug: at 220 the fraction was
	 * 23.31% and this page's word came out 5% small.
	 */
	it("keeps the word at the same fraction of the measure across the turn", () => {
		const fraction = posterWordSize("Apt") / CONTENT_W;
		const before = 173 / 704;
		// A RELATIVE tolerance, the same 1% AC 3 is held to, not a decimal-place
		// check: the two fractions are 24.57% and 24.68%, which differ by 0.44% of
		// each other but by 0.001 absolutely — `toBeCloseTo(…, 3)` reads that as a
		// failure and `(…, 2)` would pass the 23.31% the 220px ceiling produced.
		// Neither is the question being asked.
		expect(
			Math.abs(fraction / before - 1),
			`the ≤6 bucket occupies ${(fraction * 100).toFixed(2)}% of the poster's ` +
				`measure against ${(before * 100).toFixed(2)}% before #718. The word's ` +
				"size on the packet is that fraction of 524pt, so a re-derivation that " +
				"moves it moves a page it has nothing to do with.",
		).toBeLessThan(TOLERANCE);
	});

	// Both tables reach this page, so the all-caps branch needs its own line —
	// it has its own sizes and the same two conversion rules.
	it("applies the same two rules to an all-caps word", () => {
		const s = sizesFor("APT");
		expect(s.word).toBeCloseTo(
			(posterWordSize("APT") * CONTENT_PT) / CONTENT_W,
			6,
		);
		expect(s.definition).toBe(pxToPt(posterBodySize("APT")));
	});

	// The long end, where posterBodySize is no longer clamped at 32 and the
	// absolute rule has something to say.
	it("carries an unclamped body size through unscaled", () => {
		const long = "Electroencephalographs";
		expect(posterBodySize(long)).toBe(31); // 93/3, under the ceiling
		expect(sizesFor(long).definition).toBe(pxToPt(31));
	});
});
