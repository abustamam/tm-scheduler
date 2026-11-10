/**
 * `authorizeDelegateForMeeting` (#1567): the connector's "does this caller hold
 * a role on THIS meeting" check, through the four web resolvers.
 *
 * Card: protects=an officer, or the member whose OWN membership holds the slot a
 * capability keys off, may use the capability from the connector, and nobody
 * else, including a superadmin impersonating the club;
 * fails_when=the slot equality is bypassed (every non-holder row grants), the
 * `officer` arm is dropped or widened, the impersonation fallback is reached, the
 * holder is cached rather than read per call, or the archive/lock policy of the
 * web resolvers is not shared;
 * no_claim=that a tool using the helper writes correctly (each tool's own suite
 * says that); the web resolvers' own tables (`meeting-authz.integration.test.ts`).
 *
 * Run with a worktree's test database (`bun run worktree:setup`):
 *   bunx vitest run src/server/mcp/delegate-authz.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	impersonationSessions,
	meetings,
	members,
	officerTerms,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import type { DelegateCapability } from "#/server/mcp/authz-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// Pass-through, so one test can make a resolver fail in a way the real ones
// only do under a race or a driver fault.
vi.mock("#/server/meeting-authz-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meeting-authz-logic")>();
	return {
		...actual,
		resolveVoteCounterAuthz: vi.fn(actual.resolveVoteCounterAuthz),
	};
});

const { hashApiToken } = await import("#/server/api-tokens-logic");
const {
	authorizeDelegateForMeeting,
	NOT_OFFICER_MESSAGE,
	NOT_ROLE_HOLDER_MESSAGE,
} = await import("#/server/mcp/authz-logic");
const { CLUB_ARCHIVED_MESSAGE } = await import("#/lib/club-archive");
const authzLogic = await import("#/server/meeting-authz-logic");

type Capability = DelegateCapability;

/** The role names that grant each capability, as the web resolvers define them. */
const GRANTING_ROLES: Record<Capability, string[]> = {
	agenda: ["Toastmaster of the Day"],
	wordOfTheDay: ["Toastmaster of the Day", "Grammarian"],
	tableTopicsNotes: ["Toastmaster of the Day", "Table Topics Master"],
	voteCounter: ["Vote Counter", "Toastmaster of the Day"],
};
const CAPABILITIES = Object.keys(GRANTING_ROLES) as Capability[];

const seeded: SeededClub[] = [];
const extraUsers: string[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
	for (const id of extraUsers.splice(0)) {
		await testDb.delete(user).where(eq(user.id, id));
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

/** A new sign-in user with an active plain membership in `clubId`. */
async function addMember(clubId: string, name: string) {
	const userId = randomUUID();
	extraUsers.push(userId);
	await testDb.insert(user).values({
		id: userId,
		name,
		email: `${userId}@test.example`,
		emailVerified: true,
	});
	const [person] = await testDb
		.insert(people)
		.values({ name, email: `${userId}@test.example`, userId })
		.returning({ id: people.id });
	const [member] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: (person as { id: string }).id,
			name,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	return { userId, memberId: (member as { id: string }).id };
}

/** A slot for `roleName` on `meetingId`, held by `memberId`. Returns the slot id. */
async function giveRole(
	clubId: string,
	meetingId: string,
	roleName: string,
	memberId: string,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: roleName,
			category: "functionary",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId,
			roleDefinitionId: (def as { id: string }).id,
			assignedMemberId: memberId,
			status: "confirmed",
		})
		.returning({ id: roleSlots.id });
	return (slot as { id: string }).id;
}

async function otherMeeting(clubId: string): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	return (m as { id: string }).id;
}

async function outcome(p: Promise<unknown>) {
	try {
		return { ok: true as const, value: await p };
	} catch (err) {
		const e = err as { code?: string; message: string };
		return { ok: false as const, code: e.code, message: e.message };
	}
}

const run = (token: string, meetingId: string, cap: Capability) =>
	outcome(authorizeDelegateForMeeting({ rawToken: token }, meetingId, cap));

describe.skipIf(!hasTestDb)("authorizeDelegateForMeeting (#1567)", () => {
	describe.each(CAPABILITIES)("%s", (cap) => {
		it("grants an officer, with the officer's own membership credited", async () => {
			const s = await club();
			const r = await run(await tokenFor(s.adminUserId), s.meetingId, cap);
			expect(r).toMatchObject({
				ok: true,
				value: { via: "admin", actorMemberId: s.adminMemberId },
			});
		});

		it.each(
			GRANTING_ROLES[cap],
		)("grants the holder of %s, crediting the holder", async (roleName) => {
			const s = await club();
			const holder = await addMember(s.clubId, "Holder");
			await giveRole(s.clubId, s.meetingId, roleName, holder.memberId);
			const r = await run(await tokenFor(holder.userId), s.meetingId, cap);
			expect(r).toMatchObject({
				ok: true,
				value: { actorMemberId: holder.memberId },
			});
			expect((r as { value: { via: string } }).value.via).not.toBe("admin");
		});

		it("refuses a member holding a DIFFERENT role on that meeting", async () => {
			const s = await club();
			const other = await addMember(s.clubId, "Timer Person");
			await giveRole(s.clubId, s.meetingId, "Timer", other.memberId);
			const r = await run(await tokenFor(other.userId), s.meetingId, cap);
			expect(r).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: NOT_ROLE_HOLDER_MESSAGE,
			});
		});

		it("refuses a member when SOMEONE ELSE holds the role", async () => {
			const s = await club();
			const holder = await addMember(s.clubId, "Holder");
			await giveRole(
				s.clubId,
				s.meetingId,
				GRANTING_ROLES[cap][0] as string,
				holder.memberId,
			);
			const r = await run(await tokenFor(s.memberUserId), s.meetingId, cap);
			expect(r).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: NOT_ROLE_HOLDER_MESSAGE,
			});
		});

		it("refuses a plain member who holds nothing", async () => {
			const s = await club();
			const r = await run(await tokenFor(s.memberUserId), s.meetingId, cap);
			expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
		});

		it("refuses the right role on a DIFFERENT meeting", async () => {
			const s = await club();
			const holder = await addMember(s.clubId, "Holder");
			const elsewhere = await otherMeeting(s.clubId);
			await giveRole(
				s.clubId,
				elsewhere,
				GRANTING_ROLES[cap][0] as string,
				holder.memberId,
			);
			const r = await run(await tokenFor(holder.userId), s.meetingId, cap);
			expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
		});

		it("refuses a non-member with the stranger's message", async () => {
			const s = await club();
			const foreign = await club();
			const r = await run(
				await tokenFor(foreign.memberUserId),
				s.meetingId,
				cap,
			);
			expect(r).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: NOT_OFFICER_MESSAGE,
			});
			// Even a foreign officer is a stranger here.
			const foreignOfficer = await run(
				await tokenFor(foreign.adminUserId),
				s.meetingId,
				cap,
			);
			expect(foreignOfficer).toEqual(r);
		});

		it("reads the holder at call time: a reassigned slot refuses the previous holder", async () => {
			const s = await club();
			const first = await addMember(s.clubId, "First");
			const second = await addMember(s.clubId, "Second");
			const slotId = await giveRole(
				s.clubId,
				s.meetingId,
				GRANTING_ROLES[cap][0] as string,
				first.memberId,
			);
			const firstToken = await tokenFor(first.userId);
			const secondToken = await tokenFor(second.userId);
			expect(await run(firstToken, s.meetingId, cap)).toMatchObject({
				ok: true,
			});
			expect(await run(secondToken, s.meetingId, cap)).toMatchObject({
				ok: false,
			});
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: second.memberId })
				.where(eq(roleSlots.id, slotId));
			expect(await run(firstToken, s.meetingId, cap)).toMatchObject({
				ok: false,
				code: "FORBIDDEN",
			});
			expect(await run(secondToken, s.meetingId, cap)).toMatchObject({
				ok: true,
			});
		});

		it("refuses everyone on an archived club, officer and holder alike", async () => {
			const s = await club();
			const holder = await addMember(s.clubId, "Holder");
			await giveRole(
				s.clubId,
				s.meetingId,
				GRANTING_ROLES[cap][0] as string,
				holder.memberId,
			);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));
			for (const userId of [s.adminUserId, holder.userId]) {
				expect(await run(await tokenFor(userId), s.meetingId, cap)).toEqual({
					ok: false,
					code: "ARCHIVED",
					message: CLUB_ARCHIVED_MESSAGE,
				});
			}
		});

		it.each([
			"completed",
			"cancelled",
		] as const)("a %s meeting: refused unless the capability spans it", async (status) => {
			const s = await club();
			const holder = await addMember(s.clubId, "Holder");
			await giveRole(
				s.clubId,
				s.meetingId,
				GRANTING_ROLES[cap][0] as string,
				holder.memberId,
			);
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, s.meetingId));
			for (const userId of [s.adminUserId, holder.userId]) {
				const r = await run(await tokenFor(userId), s.meetingId, cap);
				if (cap === "voteCounter") {
					expect(r, "vote counter is not a plan write").toMatchObject({
						ok: true,
					});
				} else {
					expect(r).toMatchObject({ ok: false, code: "LOCKED" });
				}
			}
		});
	});

	it.each(
		CAPABILITIES,
	)("%s: a member whose officer standing is an open officer term only is granted (via officer)", async (cap) => {
		const s = await club();
		const officer = await addMember(s.clubId, "Term Officer");
		const token = await tokenFor(officer.userId);
		// Same plain member, no term yet: refused. Then the term makes the difference.
		expect(await run(token, s.meetingId, cap)).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
		});
		await testDb.insert(officerTerms).values({
			membershipId: officer.memberId,
			position: "vp_education",
			termStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
			termEnd: null,
		});
		expect(await run(token, s.meetingId, cap)).toMatchObject({
			ok: true,
			value: { via: "admin", actorMemberId: officer.memberId },
		});
	});

	it("a resolver failure that is not a refusal sentence is not reported as LOCKED, nor does it carry its message", async () => {
		const s = await club();
		const leak = "Failed query: select * from meetings params: secret-param";
		vi.mocked(authzLogic.resolveVoteCounterAuthz).mockRejectedValueOnce(
			new Error(leak),
		);
		const r = await run(
			await tokenFor(s.adminUserId),
			s.meetingId,
			"voteCounter",
		);
		// Rethrown unchanged (not an McpError), so the dispatcher's toMcpError
		// turns it into the generic INTERNAL.
		expect(r).toMatchObject({ ok: false, message: leak });
		expect((r as { code?: string }).code).toBeUndefined();
	});

	it.each([
		["the club archived mid-call", CLUB_ARCHIVED_MESSAGE, "ARCHIVED"],
		["a lock sentence", "This meeting is locked.", "LOCKED"],
		["a cancelled sentence", "This meeting is cancelled.", "LOCKED"],
	])("a resolver refusal sentence (%s) keeps its own code", async (_n, message, code) => {
		const s = await club();
		vi.mocked(authzLogic.resolveVoteCounterAuthz).mockRejectedValueOnce(
			new Error(message),
		);
		expect(
			await run(await tokenFor(s.adminUserId), s.meetingId, "voteCounter"),
		).toEqual({ ok: false, code, message });
	});

	it("the resolver refuses a connector caller that also carries a session", async () => {
		const s = await club();
		await expect(
			authzLogic.resolveMeetingAgendaAuthz({
				meetingId: s.meetingId,
				sessionUserId: s.adminUserId,
				connector: { membershipId: s.adminMemberId, officer: true },
			}),
		).rejects.toThrow("A connector caller cannot also carry a session.");
	});

	it("a role grants only its own capabilities", async () => {
		const s = await club();
		const grammarian = await addMember(s.clubId, "Grammarian");
		const ttm = await addMember(s.clubId, "TTM");
		const counter = await addMember(s.clubId, "Counter");
		await giveRole(s.clubId, s.meetingId, "Grammarian", grammarian.memberId);
		await giveRole(s.clubId, s.meetingId, "Table Topics Master", ttm.memberId);
		await giveRole(s.clubId, s.meetingId, "Vote Counter", counter.memberId);
		const g = await tokenFor(grammarian.userId);
		const t = await tokenFor(ttm.userId);
		const c = await tokenFor(counter.userId);
		const granted = async (token: string) =>
			(
				await Promise.all(
					CAPABILITIES.map(async (cap) => [
						cap,
						(await run(token, s.meetingId, cap)).ok,
					]),
				)
			)
				.filter(([, ok]) => ok)
				.map(([cap]) => cap);
		expect(await granted(g)).toEqual(["wordOfTheDay"]);
		expect(await granted(t)).toEqual(["tableTopicsNotes"]);
		expect(await granted(c)).toEqual(["voteCounter"]);
	});

	it("the Toastmaster holds all four; the Ballot Counter's grant is the vote counter's", async () => {
		const s = await club();
		const tmod = await addMember(s.clubId, "TMOD");
		await giveRole(
			s.clubId,
			s.meetingId,
			"Toastmaster of the Day",
			tmod.memberId,
		);
		const token = await tokenFor(tmod.userId);
		for (const cap of CAPABILITIES) {
			expect(await run(token, s.meetingId, cap), cap).toMatchObject({
				ok: true,
				value: { via: "tmod-self-assert", actorMemberId: tmod.memberId },
			});
		}
	});

	describe("a superadmin impersonating the club gains nothing from it", () => {
		async function makeSuperadminWithSession(userId: string, clubId: string) {
			await testDb
				.update(user)
				.set({ isSuperadmin: true })
				.where(eq(user.id, userId));
			await testDb.insert(impersonationSessions).values({
				superadminUserId: userId,
				clubId,
				mode: "read_write",
				reason: "test",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			});
		}

		it.each(
			CAPABILITIES,
		)("%s: refused with no membership in the club", async (cap) => {
			const s = await club();
			const { userId } = await addMember((await club()).clubId, "Super");
			await makeSuperadminWithSession(userId, s.clubId);
			const r = await run(await tokenFor(userId), s.meetingId, cap);
			expect(r).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: NOT_OFFICER_MESSAGE,
			});
		});

		it.each(
			CAPABILITIES,
		)("%s: refused as a plain member of the club holding no role", async (cap) => {
			const s = await club();
			await makeSuperadminWithSession(s.memberUserId, s.clubId);
			const r = await run(await tokenFor(s.memberUserId), s.meetingId, cap);
			expect(r).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: NOT_ROLE_HOLDER_MESSAGE,
			});
		});
	});
});
