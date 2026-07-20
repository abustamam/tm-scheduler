// Enforces ADR-0024: GavelUp does not reproduce the official Toastmasters
// International wordmark/logo *image* in any rendered or exported output. The
// word "Toastmasters" stays (nominative fair use); the mark image does not.
//
// A source-grep guard (like server-modules.guard.test.ts) because the change is
// a negative — "this asset is no longer imported" — which a behavioural test
// can't easily assert. If someone re-adds the wordmark to the deck without
// obtaining a TI Trademark Use Request, this fails and points back at the ADR.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

/** The audience-facing / exported deck renderers. */
const DECK_RENDERERS = [
	"src/components/agenda/meeting-present.tsx",
	"src/lib/deck-to-pptx.ts",
	"src/components/agenda/meeting-agenda-print.tsx",
];

/** Matches an import/reference of a vendored official TI mark asset. */
const TI_MARK =
	/Toastmasters(Wordmark|Logo)\w*\.(png|svg)|ToastmastersWordmark\b/;

describe("ADR-0024: no reproduced TI wordmark in deck renderers", () => {
	for (const rel of DECK_RENDERERS) {
		it(`${rel} does not import or render the official TI wordmark/logo image`, () => {
			const src = readFileSync(resolve(ROOT, rel), "utf8");
			expect(src).not.toMatch(TI_MARK);
		});
	}
});
