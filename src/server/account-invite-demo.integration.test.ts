/**
 * The demo club sends no invite mail (#1200): `inviteMember` and
 * `inviteAllMembers` skip the send there and answer `notSent: "demo"`, and send
 * as before in a real club. Through the REAL server-fn handlers behind the
 * minimal adapter the other authz suites use; only the cookie -> session lookup
 * and `auth.api.signInMagicLink` are faked, everything else runs against the
 * test database.
 *
 * The demo club is owned through `withDemoClub` (one open transaction, always
 * rolled back) because the single `is_demo` row belongs to the #1199 suite.
 *
 * Run with (in a worktree, nothing exported):
 *   bunx vitest run src/server/account-invite-demo.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, user } from "#/db/schema";
import { hasTestDb } from "#/test/db";
import { type DemoClubCtx, withDemoClub } from "#/test/demo-club-tx";

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

const h = vi.hoisted(() => ({
	sessionUserId: null as string | null,
	signInMagicLink: vi.fn(async () => ({ status: true })),
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				h.sessionUserId ? { user: { id: h.sessionUserId } } : null,
			signInMagicLink: h.signInMagicLink,
		},
	},
}));

const { inviteAllMembers, inviteMember } = await import("./account-invite");

type Fn = (input: { data: unknown }) => Promise<Record<string, unknown>>;
const invite = inviteMember as unknown as Fn;
const inviteAll = inviteAllMembers as unknown as Fn;

/** An admin and one not-yet-joined member with an email, in `clubId`. */
async function seedRoster(tx: DemoClubCtx["tx"], clubId: string) {
	const adminUserId = randomUUID();
	await tx.insert(user).values({
		id: adminUserId,
		name: "Admin",
		email: `admin-${adminUserId}@test.example`,
		emailVerified: true,
	});
	const [adminPerson, memberPerson] = await tx
		.insert(people)
		.values([
			{
				name: "Admin",
				email: `admin-${adminUserId}@test.example`,
				userId: adminUserId,
			},
			{ name: "Ada", email: `ada-${adminUserId}@test.example` },
		])
		.returning({ id: people.id });
	if (!adminPerson || !memberPerson) throw new Error("people");
	const [, memberRow] = await tx
		.insert(members)
		.values([
			{
				clubId,
				personId: adminPerson.id,
				name: "Admin",
				clubRole: "admin",
				status: "active",
			},
			{
				clubId,
				personId: memberPerson.id,
				name: "Ada",
				clubRole: "member",
				status: "active",
			},
		])
		.returning({ id: members.id });
	if (!memberRow) throw new Error("member");
	return {
		adminUserId,
		memberId: memberRow.id,
		memberPersonId: memberPerson.id,
	};
}

async function realClub(tx: DemoClubCtx["tx"]) {
	const [row] = await tx
		.insert(clubs)
		.values({ name: "Real Club", slug: `invite-1200-${randomUUID()}` })
		.returning({ id: clubs.id });
	if (!row) throw new Error("club");
	return row.id;
}

async function invitedAt(
	tx: DemoClubCtx["tx"],
	personId: string,
): Promise<Date | null> {
	const [row] = await tx
		.select({ invitedAt: people.invitedAt })
		.from(people)
		.where(eq(people.id, personId));
	return row?.invitedAt ?? null;
}

describe.skipIf(!hasTestDb)("invites in the demo club (#1200)", () => {
	afterEach(() => {
		h.sessionUserId = null;
		h.signInMagicLink.mockClear();
	});

	// protects=in the demo club a single invite sends no mail and says so, while
	//   still stamping the member as invited (the roster then reads "invited");
	// fails_when=the demo club's invite reaches `signInMagicLink`, answers without
	//   `notSent`, or skips the stamp;
	// no_claim=that mail to a reserved address is also dropped by auth.ts (#1199);
	//   `signInMagicLink` is a spy, so no real send is attempted.
	it("inviteMember sends nothing in the demo club and answers notSent", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const { adminUserId, memberId, memberPersonId } = await seedRoster(
				tx,
				demoClubId,
			);
			h.sessionUserId = adminUserId;

			const res = await invite({ data: { clubId: demoClubId, memberId } });

			expect(res).toEqual({ outcome: "ready", notSent: "demo" });
			expect(h.signInMagicLink).not.toHaveBeenCalled();
			expect(await invitedAt(tx, memberPersonId)).not.toBeNull();
		});
	});

	// protects=the bulk send in the demo club sends nothing, reports `notSent`, and
	//   counts no invite as sent, while still stamping each member as invited (as
	//   the single invite does);
	// fails_when=any member is mailed, `notSent` is missing, `sent` is not 0, or a
	//   member is left unstamped;
	// no_claim=the per-member refusal counts, which the existing bulk suite owns.
	it("inviteAllMembers sends nothing in the demo club and answers notSent", async () => {
		await withDemoClub(async ({ tx, demoClubId }) => {
			const { adminUserId, memberPersonId } = await seedRoster(tx, demoClubId);
			h.sessionUserId = adminUserId;
			expect(await invitedAt(tx, memberPersonId)).toBeNull();

			const res = await inviteAll({ data: { clubId: demoClubId } });

			expect(res).toMatchObject({ notSent: "demo", sent: 0, failed: 0 });
			expect(h.signInMagicLink).not.toHaveBeenCalled();
			expect(await invitedAt(tx, memberPersonId)).not.toBeNull();
		});
	});

	// protects=a real club is unchanged: one send per invite, no `notSent` on the
	//   result (the CONTROL for both tests above, so they cannot pass because
	//   nothing ever sends);
	// fails_when=the skip leaks to a club that is not the demo club;
	// no_claim=the content of the mail; the spy only counts calls.
	it("still sends in a real club, one at a time and in bulk", async () => {
		await withDemoClub(async ({ tx }) => {
			const clubId = await realClub(tx);
			const { adminUserId, memberId, memberPersonId } = await seedRoster(
				tx,
				clubId,
			);
			h.sessionUserId = adminUserId;

			const single = await invite({ data: { clubId, memberId } });
			expect(single).toEqual({ outcome: "ready" });
			expect(h.signInMagicLink).toHaveBeenCalledTimes(1);

			// The bulk run honours the 24h cooldown the single invite just started.
			await tx
				.update(people)
				.set({ invitedAt: null })
				.where(eq(people.id, memberPersonId));
			const bulk = await inviteAll({ data: { clubId } });
			expect(bulk).toMatchObject({ sent: 1 });
			expect(bulk).not.toHaveProperty("notSent");
			expect(h.signInMagicLink).toHaveBeenCalledTimes(2);
		});
	});
});
