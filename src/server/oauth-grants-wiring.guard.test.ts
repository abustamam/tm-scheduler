import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The half of #851 `oauth-grants-logic.integration.test.ts` cannot reach: that
 * the server fns hand the logic the SESSION's user id.
 *
 * The logic is proven to scope every statement by the user id it is given. A
 * `createServerFn` handler cannot be invoked in vitest (CODING_STANDARDS.md),
 * so nothing behavioural proves which id it is given. The request carries a
 * `clientId` and nothing else, and clients are shared across users — so a
 * handler that took its user id from anywhere but `requireUser()` would let one
 * person revoke another's grant, with the whole integration suite green.
 *
 * Comment-blind reader (`src/test/guard-source.ts`), because every assertion
 * here is "must BE present" and this module discusses its wiring in prose.
 */
const SRC = readSource(resolve(__dirname, "oauth-grants.ts"));

/** One `export const <name> = createServerFn…` declaration. */
function handlerBody(name: string): string {
	const start = SRC.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in oauth-grants.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = SRC.indexOf("\nexport const", start + 1);
	return SRC.slice(start, next === -1 ? SRC.length : next);
}

describe("connected-apps server fns act as the session's user (#851)", () => {
	it("getConnectedApps lists the session user's grants", () => {
		const body = handlerBody("getConnectedApps");
		expect(body).toContain("const user = await requireUser();");
		expect(body).toContain("listConnectedApps(user.id)");
	});

	it("disconnectConnectedApp disconnects the session user's grant, by the sent client id only", () => {
		const body = handlerBody("disconnectConnectedApp");
		expect(body).toContain("const user = await requireUser();");
		expect(body).toContain("disconnectApp(user.id, data.clientId)");
		// The validator accepts a client id and nothing that could name a user.
		expect(body).toContain(
			"z.object({ clientId: z.string().min(1).max(512) })",
		);
		expect(body).not.toMatch(/userId/);
	});

	it("both are pinned to their methods", () => {
		expect(handlerBody("getConnectedApps")).toContain(
			'createServerFn({ method: "GET" })',
		);
		expect(handlerBody("disconnectConnectedApp")).toContain(
			'createServerFn({ method: "POST" })',
		);
	});
});
