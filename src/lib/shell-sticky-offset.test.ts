import { describe, expect, it } from "vitest";
import {
	IMPERSONATION_BANNER_HEIGHT,
	PINNED_BELOW_HEADER,
	SHELL_BANNER_OFFSET_VAR,
	SHELL_PINNED_TOP_VAR,
	shellStickyVars,
} from "./shell-sticky-offset";

// The shell computes `impersonating != null || viewAs != null` (#1113): a
// superadmin session plus a preview is ONE banner, so the offset is one banner
// high, not two.
const showing = (impersonating: boolean, viewAs: boolean) =>
	shellStickyVars(impersonating || viewAs) as Record<string, string>;

describe("shellStickyVars", () => {
	it("is zero with no banner", () => {
		expect(showing(false, false)[SHELL_BANNER_OFFSET_VAR]).toBe("0px");
	});
	it("is one banner high for a preview alone", () => {
		expect(showing(false, true)[SHELL_BANNER_OFFSET_VAR]).toBe(
			IMPERSONATION_BANNER_HEIGHT,
		);
	});
	it("is one banner high for impersonation alone", () => {
		expect(showing(true, false)[SHELL_BANNER_OFFSET_VAR]).toBe(
			IMPERSONATION_BANNER_HEIGHT,
		);
	});
	it("stays ONE banner high when both are on", () => {
		const both = showing(true, true);
		expect(both[SHELL_BANNER_OFFSET_VAR]).toBe(IMPERSONATION_BANNER_HEIGHT);
		expect(both[SHELL_PINNED_TOP_VAR]).toBe(
			`calc(${IMPERSONATION_BANNER_HEIGHT} + ${PINNED_BELOW_HEADER})`,
		);
	});
});
