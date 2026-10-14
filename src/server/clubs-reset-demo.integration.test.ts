/**
 * `resetDemoClubFromClub` (#1200), through the REAL server-fn handler behind the
 * minimal adapter the other authz suites use: the demo admin rebuilds the demo
 * club from inside it, an admin of a real club who passes that club's id deletes
 * nothing, and a member who is not an admin is refused. Only the cookie ->
 * session lookup and the fixture builder are faked.
 *
 * The builder is a small stand-in, as in `demo-reset-logic.integration.test.ts`
 * (the real fixture's fixed addresses collide with the fixture suite's cleanup).
 * It writes what the logic relies on: a club flagged `is_demo`, and the admin
 * Person linked to `admin.userId` as an admin member. What these tests pin is the
 * gate and the pass-through around the logic, which does not care which ran.
 *
 * The demo club is owned through `withDemoClub` (one open transaction, always
 * rolled back): the single `is_demo` row belongs to the #1199 suite.
 *
 * Run with (in a worktree, nothing exported):
 *   bunx vitest run src/server/clubs-reset-demo.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { buildFixtureClub as BuildFixtureClub } from "#/db/fixtures/club-fixture";
import { clubs, members, people, user } from "#/db/schema";
import { hasTestDb } from "#/test/db";
import { type DemoClubCtx, withDemoClub } from "#/test/demo-club-tx";

const RUN = vi.hoisted(() => Math.random().toString(36).slice(2, 8));

vi.mock("#/db", async () => (await import("#/test/demo-club-tx")).dbMock());
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
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => ({ headers: new Headers() }),
}));

const h = vi.hoisted(() => ({ sessionUserId: null as string | null }));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				h.sessionUserId ? { user: { id: h.sessionUserId } } : null,
		},
	},
}));

vi.mock("#/db/fixtures/club-fixture", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("#/db/fixtures/club-fixture")>();
	const stubBuild: typeof BuildFixtureClub = async (tx, o) => {
		const schema = await import("#/db/schema");
		const [club] = await tx
			.insert(schema.clubs)
			.values({
				name: o.name,
				slug: o.slug,
				timezone: o.timeZone,
				isDemo: o.isDemo ?? false,
			})
			.returning({ id: schema.clubs.id });
		if (!club) throw new Error("stub: club");
		const [person] = await tx
			.insert(schema.people)
			.values({
				name: o.admin.name,
				email: o.admin.email,
				userId: o.admin.userId,
			})
			.returning({ id: schema.people.id });
		if (!person) throw new Error("stub: person");
		await tx.insert(schema.members).values({
			clubId: club.id,
			personId: person.id,
			name: o.admin.name,
			clubRole: "admin",
			status: "active",
		});
		return { clubId: club.id };
	};
	return { ...real, buildFixtureClub: stubBuild };
});

const { getClubProfileSettings, resetDemoClubFromClub } = await import(
	"./clubs"
);
const { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } = await import(
	"./guards"
);

type Fn = (input: { data: unknown }) => Promise<{ clubId: string }>;
const reset = resetDemoClubFromClub as unknown as Fn;

const DEMO_EMAIL = `demo-${RUN}@test.example`;

async function makeUser(tx: DemoClubCtx["tx"], email: string) {
	const id = randomUUID();
	await tx.insert(user).values({ id, name: "U", email, emailVerified: true });
	return id;
}

async function join(
	tx: DemoClubCtx["tx"],
	clubId: string,
	userId: string,
	email: string,
	role: "admin" | "member",
) {
	const [person] = await tx
		.insert(people)
		.values({ name: "P", email, userId })
		.returning({ id: people.id });
	if (!person) throw new Error("person");
	await tx.insert(members).values({
		clubId,
		personId: person.id,
		name: "P",
		clubRole: role,
		status: "active",
	});
}

const clubExists = async (tx: DemoClubCtx["tx"], id: string) =>
	(await tx.select({ id: clubs.id }).from(clubs).where(eq(clubs.id, id)))
		.length === 1;

async function seed(tx: DemoClubCtx["tx"], demoClubId: string) {
	const demoAdmin = await makeUser(tx, DEMO_EMAIL);
	await join(tx, demoClubId, demoAdmin, DEMO_EMAIL, "admin");
	const demoMember = await makeUser(tx, `m-${randomUUID()}@club.org`);
	await join(
		tx,
		demoClubId,
		demoMember,
		`m-${randomUUID()}@club.org`,
		"member",
	);
	const [real] = await tx
		.insert(clubs)
		.values({ name: "Real Club", slug: `reset-1200-${randomUUID()}` })
		.returning({ id: clubs.id });
	if (!real) throw new Error("club");
	const realAdmin = await makeUser(tx, `ra-${randomUUID()}@club.org`);
	await join(tx, real.id, realAdmin, `ra-${randomUUID()}@club.org`, "admin");
	return { demoAdmin, demoMember, realClubId: real.id, realAdmin };
}

describe.skipIf(!hasTestDb)("resetDemoClubFromClub (#1200)", () => {
	afterEach(() => {
		h.sessionUserId = null;
		vi.unstubAllEnvs();
	});

	// protects=the demo account, signed in as the admin of the demo club, rebuilds
	//   it from inside it: the old club is gone, a new `is_demo` club exists, and
	//   the same account is its admin, still signed in (its user row kept);
	// fails_when=the club is not rebuilt, the presenter is left in no club, or the
	//   account is deleted with the old club;
	// no_claim=the page's navigation (the component test); the builder is a stand-in
	//   that writes the contract the logic relies on, not the Harbor City fixture.
	it("lets the demo admin rebuild the demo club and leaves them its admin", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			vi.stubEnv("DEMO_ACCOUNT_EMAIL", DEMO_EMAIL);
			const { demoAdmin } = await seed(tx, demoClubId);
			h.sessionUserId = demoAdmin;

			const { clubId: fresh } = await reset({ data: { clubId: demoClubId } });

			expect(fresh).not.toBe(demoClubId);
			expect(await clubExists(tx, demoClubId)).toBe(false);
			const [row] = await tx
				.select({ isDemo: clubs.isDemo })
				.from(clubs)
				.where(eq(clubs.id, fresh));
			expect(row?.isDemo).toBe(true);
			const memberships = await tx
				.select({ role: members.clubRole })
				.from(members)
				.innerJoin(people, eq(people.id, members.personId))
				.where(eq(people.userId, demoAdmin));
			expect(memberships).toEqual([{ role: "admin" }]);
			const [account] = await tx
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, demoAdmin));
			expect(account?.id).toBe(demoAdmin);
		});
	});

	// protects=an admin of a REAL club who names that club deletes nothing: the
	//   logic refuses NOT_DEMO_CLUB, the demo club and the real club both survive;
	// fails_when=the call proceeds on the demo club (the `expectClubId`
	//   pass-through dropped answers NOT_AUTHORIZED instead, and a missing actor
	//   re-check would delete it), or the real club is touched;
	// no_claim=what the reset card shows: this is the server's answer to a card
	//   forced onto a real club.
	it("refuses an admin of a real club naming that club, and deletes nothing", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			vi.stubEnv("DEMO_ACCOUNT_EMAIL", DEMO_EMAIL);
			const { realClubId, realAdmin } = await seed(tx, demoClubId);
			h.sessionUserId = realAdmin;

			await expect(
				reset({ data: { clubId: realClubId } }),
			).rejects.toMatchObject({ code: "NOT_DEMO_CLUB" });

			expect(await clubExists(tx, demoClubId)).toBe(true);
			expect(await clubExists(tx, realClubId)).toBe(true);
		});
	});

	// protects=a member who is not an admin of the demo club is refused with the
	//   permission message before the logic runs, and an admin of ANOTHER club is
	//   refused naming the demo club they are not in;
	// fails_when=the gate is skipped, so either caller reaches the logic (the member
	//   would then get NOT_AUTHORIZED, the outsider NOT_DEMO_CLUB's neighbour, a
	//   rebuild), or the demo club is deleted;
	// no_claim=the order of the gate and the logic beyond these two refusals.
	it("refuses a member who is not an admin, and an admin of another club", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			vi.stubEnv("DEMO_ACCOUNT_EMAIL", DEMO_EMAIL);
			const { demoMember, realAdmin } = await seed(tx, demoClubId);

			h.sessionUserId = demoMember;
			await expect(reset({ data: { clubId: demoClubId } })).rejects.toThrow(
				NO_PERMISSION_MESSAGE,
			);

			h.sessionUserId = realAdmin;
			await expect(reset({ data: { clubId: demoClubId } })).rejects.toThrow(
				NOT_A_MEMBER_MESSAGE,
			);

			expect(await clubExists(tx, demoClubId)).toBe(true);
		});
	});
	// protects=the settings loader's club row says `isDemo` for the demo club and
	//   false for a real one, which is what the page reads to show the card;
	// fails_when=the flag is missing or true for a real club (the card would show
	//   there, and only the server's refusal above would stand between it and a
	//   click);
	// no_claim=that the page renders the card from it (the component test).
	it("tells the settings page which club is the demo club", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			vi.stubEnv("DEMO_ACCOUNT_EMAIL", DEMO_EMAIL);
			const { demoAdmin, realClubId, realAdmin } = await seed(tx, demoClubId);
			const read = getClubProfileSettings as unknown as (i: {
				data: unknown;
			}) => Promise<{ isDemo: boolean } | null>;

			h.sessionUserId = demoAdmin;
			expect((await read({ data: demoClubId }))?.isDemo).toBe(true);
			h.sessionUserId = realAdmin;
			expect((await read({ data: realClubId }))?.isDemo).toBe(false);
		});
	});
});
