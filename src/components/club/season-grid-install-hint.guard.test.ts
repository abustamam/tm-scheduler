// protects: a successful claim (any proof) is counted toward the install hint,
// after the write and before the refetch, and the Undo of a release is not.
// fails_when: noteClaim is removed from claim(), moves into the catch/failure
// path, or loses its `!afterRelease` gate. no_claim: source-text guard; the
// hint's behaviour is tested in install-hint.test.tsx and the Undo count in
// season-grid.test.tsx.
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

function claimBody(): string {
	const src = readSource("src/components/club/season-grid.tsx");
	const start = src.indexOf("async function claim(");
	const end = src.indexOf("async function release(", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	const body = src.slice(start, end);
	expect(body.trim().length).toBeGreaterThan(0);
	return body;
}

describe("season grid counts claims", () => {
	it("calls noteClaim between the claim toast and the quiet refetch", () => {
		expect(claimBody()).toMatch(
			/toast\.success\([\s\S]*?\);\s*if \(!afterRelease\) noteClaim\(\);\s*await refetchQuietly\("claim"\)/,
		);
	});
});
