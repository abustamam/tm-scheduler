/**
 * The queued (expected-holder) role writes keep their deadlock retry (#1638).
 *
 * `applyRoleOpExpectingHolder` takes the merge and member locks first, like the
 * claim's, so a deadlock with a member edit (#1388) must retry on a new
 * transaction instead of surfacing as a failure that leaves the op queued.
 *
 * protects=each of the claim, release and reassign expected-holder paths wraps
 *   its `applyRoleOpExpectingHolder` transaction in `withDeadlockRetry`;
 * fails_when=a path calls `db.transaction` bare, or the wrapper is named only in
 *   a comment (the source is read comment-blind);
 * no_claim=that a retry happens on a real deadlock (deadlock-retry's own tests).
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const src = readSource("src/server/slots.ts").replace(/\s+/g, " ");

describe("expected-holder role writes retry a deadlock (#1638)", () => {
	it.each(["claim", "release", "reassign"])("the %s path", (kind) => {
		expect(src).toMatch(
			new RegExp(
				`withDeadlockRetry\\(\\(\\) => db\\.transaction\\(\\(tx\\) => applyRoleOpExpectingHolder\\(tx, \\{ kind: "${kind}"`,
			),
		);
	});
});
