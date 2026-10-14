/**
 * The demo club's two console server fns refuse a signed-in non-superadmin
 * (#1199), through the REAL `createServerFn` handlers behind the minimal adapter
 * the other authz suites use. Only the cookie -> session lookup is faked;
 * `requireUser` and `requireSuperadmin` run for real against the test database.
 *
 * `DEMO_ACCOUNT_EMAIL` is deliberately UNSET throughout: a call that got past the
 * gate answers NOT_CONFIGURED and writes nothing, so this file can neither build
 * nor delete the one `is_demo` club the logic suite owns, even if the gate
 * failed open.
 *
 * Run with:
 *   bunx vitest run src/server/demo-club-console.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, user } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => ({ headers: new Headers() }),
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const consoleFns = await import("./onboarding");
const { NO_PERMISSION_MESSAGE } = await import("./guards");

type Fn = (input?: { data?: unknown }) => Promise<unknown>;

describe.skipIf(!hasTestDb)("the demo club console fns (#1199)", () => {
	const userIds: string[] = [];
	let memberId: string;
	let superadminId: string;

	async function makeUser(isSuperadmin: boolean) {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "U",
			email: `u-${id}@test.example`,
			emailVerified: true,
			isSuperadmin,
		});
		userIds.push(id);
		return id;
	}

	beforeEach(async () => {
		vi.stubEnv("DEMO_ACCOUNT_EMAIL", "");
		memberId = await makeUser(false);
		superadminId = await makeUser(true);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		sessionUserId = null;
		for (const id of userIds.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	const demoCount = async () =>
		(
			await testDb
				.select({ id: clubs.id })
				.from(clubs)
				.where(eq(clubs.isDemo, true))
		).length;

	// protects=a signed-in non-superadmin, and an anonymous caller, cannot read the
	//   demo club's state or rebuild it, and the refusal is the permission message
	//   from the gate rather than the logic's;
	// fails_when=either fn runs the logic for them (the reset would then answer
	//   NOT_CONFIGURED instead of the permission message), or writes a club;
	// no_claim=the order of requireUser and requireSuperadmin relative to the logic
	//   is read from source elsewhere; this proves the refusal itself.
	it.each([
		["getDemoClubConsole", "member"],
		["resetDemoClubFromConsole", "member"],
		["getDemoClubConsole", "anonymous"],
		["resetDemoClubFromConsole", "anonymous"],
	] as const)("%s refuses a %s caller", async (name, who) => {
		sessionUserId = who === "member" ? memberId : null;
		const before = await demoCount();

		await expect(
			(consoleFns[name] as unknown as Fn)({ data: undefined }),
		).rejects.toThrow(who === "member" ? NO_PERMISSION_MESSAGE : /./);

		expect(await demoCount()).toBe(before);
	});

	// protects=the control: the same calls from a superadmin get past the gate, so
	//   the refusals above are the gate and not a harness that refuses everything;
	// fails_when=the superadmin is refused by the gate, or the state read answers
	//   the wrong `configured`;
	// no_claim=the reset answers NOT_CONFIGURED because the env var is unset: it
	//   reached the logic, which is all this control needs.
	it("lets a superadmin through the gate", async () => {
		sessionUserId = superadminId;

		const state = (await (consoleFns.getDemoClubConsole as unknown as Fn)({
			data: undefined,
		})) as {
			configured: boolean;
		};
		expect(state.configured).toBe(false);
		await expect(
			(consoleFns.resetDemoClubFromConsole as unknown as Fn)({
				data: undefined,
			}),
		).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});
});
