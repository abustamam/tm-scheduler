/**
 * Club home "Your upcoming roles": Release renders only for a SESSION identity
 * (#1003, ADR-0026).
 *
 * `releaseSlot` needs `requireSessionActor` since #763. This route serves both a
 * signed-in member and an anonymous name-pick, and `useEffectiveMember` has
 * already said which one it is (`source`). A Release offered to a name-pick
 * comes back "You need to be signed in" on every tap, so it must not render.
 *
 * A source guard for the same reason `club-index-wiring.guard.test.ts` gives:
 * rendering this route to observe one conditional means standing up the
 * commitments query, the identity gate and the whole SeasonGrid. Comment-blind
 * (`readSource`), because the assertion is of the "must BE present" form and a
 * comment quoting the pattern would otherwise pass it.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.index.tsx";

describe("club index → Release needs a session (#1003)", () => {
	const src = readSource(ROUTE);

	it('wraps the only doRelease button in a source === "session" conditional', () => {
		const calls = src.match(/doRelease\(c\.slotId\)/g) ?? [];
		expect(calls, "expected exactly one Release button").toHaveLength(1);
		expect(src).toMatch(
			/\{source === "session" \? \(\s*<Button\b[^>]*?onClick=\{\(\) => doRelease\(c\.slotId\)\}/s,
		);
	});

	it("sends no actorMemberId to releaseSlot (#763 strips it)", () => {
		const call = src.match(/releaseSlot\(\{[^;]*\}\)/s)?.[0] ?? "";
		expect(call, "no releaseSlot call found").not.toBe("");
		expect(call).not.toMatch(/actorMemberId/);
	});

	it("reports a refused release through showWriteError", () => {
		const fn = src.match(/async function doRelease[\s\S]*?\n\t\}\n/)?.[0] ?? "";
		expect(fn, "no doRelease found").not.toBe("");
		expect(fn).toMatch(/showWriteError\(err,/);
		expect(fn).not.toMatch(/toast\.error/);
	});
});
