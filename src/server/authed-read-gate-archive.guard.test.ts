/**
 * Source guard: every authed READ gate must grant through the one funnel that
 * consults `clubs.archived_at` (#560).
 *
 * `archive-club.integration.test.ts` fails if either gate that exists TODAY stops
 * rejecting an archived club, so current behaviour is covered. What no behavioural
 * test can see is the NEXT gate: a third read gate, or a fourth arm on an existing
 * one, that resolves a membership and builds its own `{ via: "member" }` would be
 * born with the #560 defect and every suite would stay green. That is not
 * hypothetical — it is what #560 WAS, with `requireMembership` holding the check
 * and the two gates beside it not.
 *
 * Gates are DERIVED by return type, not listed: any exported function in
 * `guards.ts` answering `Promise<ClubViewAccess>` is a read gate and must funnel.
 * A listed set is an allowlist, and an allowlist that has to be remembered is how
 * both #544 and #560 happened.
 *
 * The property asserted is "no gate constructs a grant itself", NOT "the text
 * looks like this". An earlier version counted occurrences of `via: "member",` —
 * with a trailing comma, to avoid matching the `ClubViewAccess` interface's
 * `via: "member" | "impersonation"`. That was evadable by property order:
 * `{ impersonating: false, membership, via: "member" }` puts `via` last, has no
 * trailing comma, survives `biome check` unchanged, and left the guard green while
 * re-opening the hole. `grantView` now takes `via` as an ARGUMENT, so a gate body
 * has no legitimate reason to name that key in any form — which makes the bare
 * pattern both exact and order-proof.
 *
 * Read comment-blind. This is a "must NOT appear" assertion, which
 * `guard-source.ts` warns is normally the shape that must read RAW, because
 * stripping can only remove offenders. It is correct here for the narrower reason
 * that a `via:` inside a comment constructs nothing, so counting one would be a
 * false failure on correct code — and `guards.ts`'s own prose discusses `via:`
 * while explaining this funnel.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource(resolve(process.cwd(), "src/server/guards.ts"));

/** Every exported fn in guards.ts that answers with a `ClubViewAccess`. */
function readGates(): { name: string; body: string }[] {
	const decls = [
		...SOURCE.matchAll(
			/export async function (\w+)\(\s*[^)]*\)\s*:\s*Promise<ClubViewAccess>\s*\{/g,
		),
	];
	return decls.map((m) => {
		const start = (m.index ?? 0) + m[0].length;
		// Top-level declarations close with `}` at column 0.
		const body = SOURCE.slice(start).split("\n}")[0] ?? "";
		return { name: m[1] as string, body };
	});
}

describe("authed read gates gate on clubs.archived_at (#560)", () => {
	const gates = readGates();

	it("finds the read gates by return type", () => {
		// Vacuity: every assertion below is a no-op over an empty list, and a
		// signature reformat could empty it silently.
		expect(gates.map((g) => g.name).sort()).toEqual([
			"requireClubAdminView",
			"requireClubViewAccess",
		]);
		// And each body was actually sliced.
		for (const g of gates) {
			expect(g.body.length, `${g.name} body did not slice`).toBeGreaterThan(50);
			expect(
				g.body,
				`${g.name} slice ran past its own declaration`,
			).not.toContain("export async function");
		}
	});

	it.each(
		gates.map((g) => g.name),
	)("%s grants only through grantView", (name) => {
		const gate = gates.find((g) => g.name === name);
		expect(gate).toBeDefined();
		const body = (gate as { body: string }).body;

		expect(
			body,
			`${name} must return grantView(...) for every arm that grants`,
		).toContain("grantView(");

		// The real invariant: a gate never builds a grant itself, in ANY property
		// order. `grantView` takes `via` as an argument, so naming that key inside a
		// gate means constructing a `ClubViewAccess` outside the funnel and skipping
		// `assertClubNotArchived` — that is #560. This covers the impersonation arm
		// too: the exemption it used to enjoy was dropped, so no arm may bypass.
		expect(
			body.match(/via:/g),
			`${name} constructs a grant inline instead of calling grantView, which ` +
				"skips assertClubNotArchived — that is #560: an archived club keeps " +
				"serving its data to signed-in callers",
		).toBeNull();
	});

	it("the funnel asserts the archive state on BOTH arms before it grants", () => {
		const funnel = SOURCE.slice(
			SOURCE.indexOf("async function grantView("),
		).split("\n}")[0] as string;
		expect(funnel.length).toBeGreaterThan(20);

		// Two arms since #566, and each has to be named. The member arm reads the
		// `archivedAt` that `getMembership` now carries on its join; only the
		// memberless impersonation arm still queries. Asserting one would leave the
		// other deletable — which is the shape of the whole #560 bug, one level down.
		const memberArm = funnel.indexOf("assertNotArchived(membership)");
		const impersonationArm = funnel.indexOf("await assertClubNotArchived(");
		const grantAt = funnel.search(/return \{/);

		expect(
			memberArm,
			"grantView no longer checks the archive state for a real membership — an archived club would serve its own members again (#560)",
		).toBeGreaterThan(-1);
		expect(
			impersonationArm,
			"grantView no longer checks the archive state for the memberless impersonation arm",
		).toBeGreaterThan(-1);
		expect(grantAt, "grantView no longer builds the grant").toBeGreaterThan(-1);

		for (const [name, at] of [
			["the member arm", memberArm],
			["the impersonation arm", impersonationArm],
		] as const) {
			expect(
				at,
				`grantView builds the grant before ${name} asserts the archive state`,
			).toBeLessThan(grantAt);
		}
	});
});
