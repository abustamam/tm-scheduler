import { describe, expect, it } from "vitest";
import {
	PINNED_BELOW_HEADER,
	SHELL_BANNER_HEIGHT,
	SHELL_BANNER_OFFSET_VAR,
	SHELL_PINNED_TOP_VAR,
	shellStickyVars,
} from "./shell-sticky-offset";

// The parameter is "a banner is showing" (#1113): the shell passes it for an
// impersonation banner, a preview banner, or their ONE combined banner, so a
// session plus a preview is one banner high, never two. That `||` lives in the
// shell and is pinned by `roster-action-row-geometry.test.ts`.
describe("shellStickyVars", () => {
	it("is zero with no banner", () => {
		const v = shellStickyVars(false) as Record<string, string>;
		expect(v[SHELL_BANNER_OFFSET_VAR]).toBe("0px");
		expect(v[SHELL_PINNED_TOP_VAR]).toBe(`calc(0px + ${PINNED_BELOW_HEADER})`);
	});

	it("is one banner high with a banner", () => {
		const v = shellStickyVars(true) as Record<string, string>;
		expect(v[SHELL_BANNER_OFFSET_VAR]).toBe(SHELL_BANNER_HEIGHT);
		expect(v[SHELL_PINNED_TOP_VAR]).toBe(
			`calc(${SHELL_BANNER_HEIGHT} + ${PINNED_BELOW_HEADER})`,
		);
	});
});
