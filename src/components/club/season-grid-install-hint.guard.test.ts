// protects: a successful claim (any proof) is counted toward the install hint,
// after the write and before the refetch. fails_when: noteClaim is removed from
// claim(), or moves into the catch/failure path. no_claim: source-text guard;
// the hint's behaviour is tested in install-hint.test.tsx.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("season grid counts claims", () => {
	it("calls noteClaim between the claim toast and the quiet refetch", () => {
		const src = readFileSync("src/components/club/season-grid.tsx", "utf8");
		expect(src).toMatch(
			/toast\.success\([\s\S]*?\);\s*noteClaim\(\);\s*await refetchQuietly\("claim"\)/,
		);
	});
});
