/**
 * DB-backed tests for the lineup blast (#1024): who may draft one, what the
 * draft is built from, and that the button's draft and `get_lineup_blast`'s
 * are the same text.
 *
 * The `createServerFn` handlers in `lineup-blast.ts` cannot run under vitest,
 * so the refusals are proven here against `requireLineupBlastAccess`, the one
 * call each handler makes before it reads anything, and against the MCP tool's
 * handler, which CAN run.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	impersonationSessions,
	meetings,
	members,
	officerTerms,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	loadPublicLineupBlastData,
	requirePublicLineupBlastAccess,
	resolvePublicLineupBlastAccess,
} = await import("./lineup-blast-logic");
const { getLineupBlastTool } = await import(
	"#/server/mcp/tools/get-lineup-blast"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { buildLineupBlast, LINEUP_BLAST_REFUSED_MESSAGE } = await import(
	"#/lib/lineup-blast"
);
const { appBaseUrl } = await import("#/lib/app-base-url");

interface ToolResult {
	text: string;
	html: string;
	subject: string;
	openCount: number;
}

describe.skipIf(!hasTestDb)("lineup blast (#1024)", () => {
	let seed: SeededClub;
	/** A roster member with no account, holding the Toastmaster slot. */
	let tmodMemberId: string;
	let tmodSlotId: string;

	async function tokenFor(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	function access(sessionUserId: string | null, selfMemberId: string | null) {
		return resolvePublicLineupBlastAccess({
			meetingId: seed.meetingId,
			sessionUserId,
			selfMemberId,
		});
	}

	beforeEach(async () => {
		seed = await seedClub();
		const personId = await seedPerson({ name: "Lauren Keeler" });
		const [tm] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: "Lauren Keeler",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		tmodMemberId = tm?.id ?? "";

		const [tmodDef, speakerDef] = await testDb
			.insert(roleDefinitions)
			.values([
				{
					clubId: seed.clubId,
					name: "Toastmaster",
					key: "toastmaster_of_the_day",
					category: "leadership",
					sortOrder: 1,
				},
				{
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
					sortOrder: 2,
				},
			])
			.returning({ id: roleDefinitions.id });
		// The seeded Timer sorts last.
		await testDb
			.update(roleDefinitions)
			.set({ sortOrder: 9 })
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));

		const [tmodSlot] = await testDb
			.insert(roleSlots)
			.values([
				{
					meetingId: seed.meetingId,
					roleDefinitionId: tmodDef?.id ?? "",
					status: "confirmed",
					assignedMemberId: tmodMemberId,
				},
				{
					meetingId: seed.meetingId,
					roleDefinitionId: speakerDef?.id ?? "",
					slotIndex: 0,
					status: "claimed",
					assignedMemberId: seed.memberId,
				},
				{
					meetingId: seed.meetingId,
					roleDefinitionId: speakerDef?.id ?? "",
					slotIndex: 1,
					status: "open",
				},
			])
			.returning({ id: roleSlots.id });
		tmodSlotId = tmodSlot?.id ?? "";

		// A video-call link on the meeting, so the "never in the draft" assertion
		// below has something to leak.
		await testDb
			.update(meetings)
			.set({ joinUrl: "https://zoom.example/j/424242" })
			.where(eq(meetings.id, seed.meetingId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("who may draft", () => {
		it("a club admin", async () => {
			expect(await access(seed.adminUserId, seed.adminMemberId)).toEqual({
				allowed: true,
			});
		});

		it("an officer who is not a stored admin", async () => {
			await testDb
				.insert(officerTerms)
				.values({ membershipId: seed.memberId, position: "secretary" });
			expect(await access(seed.memberUserId, seed.memberId)).toEqual({
				allowed: true,
			});
		});

		it("the meeting's Toastmaster, with no account (the roster pick)", async () => {
			expect(await access(null, tmodMemberId)).toEqual({ allowed: true });
		});

		it("a signed-in Toastmaster, on their own membership", async () => {
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId })
				.where(eq(roleSlots.id, tmodSlotId));
			expect(await access(seed.memberUserId, seed.memberId)).toEqual({
				allowed: true,
			});
		});

		it("REFUSES a plain member", async () => {
			expect(await access(seed.memberUserId, seed.memberId)).toEqual({
				allowed: false,
			});
			await expect(
				requirePublicLineupBlastAccess({
					meetingId: seed.meetingId,
					sessionUserId: seed.memberUserId,
					selfMemberId: seed.memberId,
				}),
			).rejects.toThrow(LINEUP_BLAST_REFUSED_MESSAGE);
		});

		it("REFUSES a signed-in member asserting the Toastmaster's id", async () => {
			// #747: a self-assert never overrides a session.
			expect(await access(seed.memberUserId, tmodMemberId)).toEqual({
				allowed: false,
			});
		});

		it("REFUSES an anonymous caller who is not the Toastmaster", async () => {
			expect((await access(null, seed.memberId)).allowed).toBe(false);
			expect((await access(null, null)).allowed).toBe(false);
		});

		it("REFUSES an officer whose term has ended", async () => {
			await testDb.insert(officerTerms).values({
				membershipId: seed.memberId,
				position: "secretary",
				termEnd: new Date(Date.now() - 86_400_000),
			});
			expect((await access(seed.memberUserId, seed.memberId)).allowed).toBe(
				false,
			);
		});

		it("REFUSES an admin whose membership is inactive", async () => {
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(eq(members.id, seed.adminMemberId));
			expect((await access(seed.adminUserId, null)).allowed).toBe(false);
		});

		it("refuses EVERYONE in an archived club, admin included", async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			expect(await access(seed.adminUserId, null)).toEqual({ allowed: false });
			expect(await access(null, tmodMemberId)).toEqual({ allowed: false });
			await expect(
				requirePublicLineupBlastAccess({
					meetingId: seed.meetingId,
					sessionUserId: seed.adminUserId,
					selfMemberId: null,
				}),
			).rejects.toThrow(LINEUP_BLAST_REFUSED_MESSAGE);
			expect(await loadPublicLineupBlastData(seed.meetingId)).toBeNull();
		});

		it("answers an archived club EXACTLY as it answers an unknown meeting", async () => {
			// CODING_STANDARDS: a public reader must not tell a taken-down club
			// from one that never existed. Same result, same thrown message, same
			// loader shape, for the same caller.
			const unknown = randomUUID();
			const unknownAccess = await resolvePublicLineupBlastAccess({
				meetingId: unknown,
				sessionUserId: seed.adminUserId,
				selfMemberId: null,
			});
			const unknownThrow = await requirePublicLineupBlastAccess({
				meetingId: unknown,
				sessionUserId: seed.adminUserId,
				selfMemberId: null,
			}).catch((e: Error) => e.message);
			const unknownData = await loadPublicLineupBlastData(unknown);

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			const archivedAccess = await access(seed.adminUserId, null);
			const archivedThrow = await requirePublicLineupBlastAccess({
				meetingId: seed.meetingId,
				sessionUserId: seed.adminUserId,
				selfMemberId: null,
			}).catch((e: Error) => e.message);
			const archivedData = await loadPublicLineupBlastData(seed.meetingId);

			expect(archivedAccess).toEqual(unknownAccess);
			expect(archivedAccess).toEqual({ allowed: false });
			expect(archivedThrow).toBe(unknownThrow);
			expect(archivedThrow).toBe(LINEUP_BLAST_REFUSED_MESSAGE);
			expect(archivedData).toBe(unknownData);
			expect(archivedData).toBeNull();
		});

		describe("a superadmin viewing through impersonation", () => {
			let superadminId: string;

			beforeEach(async () => {
				superadminId = randomUUID();
				await testDb.insert(user).values({
					id: superadminId,
					name: "Super Admin",
					email: `super-${superadminId}@test.example`,
					emailVerified: true,
					isSuperadmin: true,
				});
			});

			afterEach(async () => {
				await testDb.delete(user).where(eq(user.id, superadminId));
			});

			it("is allowed with an active session", async () => {
				await testDb.insert(impersonationSessions).values({
					superadminUserId: superadminId,
					clubId: seed.clubId,
					mode: "read_only",
					expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				});
				expect(await access(superadminId, null)).toEqual({ allowed: true });
			});

			it("is REFUSED once the session has expired", async () => {
				await testDb.insert(impersonationSessions).values({
					superadminUserId: superadminId,
					clubId: seed.clubId,
					mode: "read_only",
					startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
					expiresAt: new Date(Date.now() - 60 * 1000),
				});
				expect(await access(superadminId, null)).toEqual({ allowed: false });
			});

			it("is REFUSED with no session at all", async () => {
				expect(await access(superadminId, null)).toEqual({ allowed: false });
			});
		});
	});

	describe("the draft", () => {
		it("lists every slot in agenda order with its status and holder", async () => {
			const data = await loadPublicLineupBlastData(seed.meetingId);
			if (!data) throw new Error("expected lineup data");
			expect(
				data.slots.map((s) => [s.roleName, s.status, s.assigneeName]),
			).toEqual([
				["Toastmaster", "confirmed", "Lauren Keeler"],
				["Speaker", "claimed", "Member User"],
				["Speaker", "open", null],
				["Timer", "open", null],
			]);
			const blast = buildLineupBlast(data);
			expect(blast.text).toContain(
				"Toastmaster – Lauren Keeler – ✅ Confirmed",
			);
			expect(blast.text).toContain("Speaker 1 – Member User –\n");
			expect(blast.text).toContain("Speaker 2 – 🙋 Need a Speaker");
			expect(blast.text).toContain("2 roles still open");
			expect(blast.text).toContain(
				`/club/${`test-club-${seed.clubId}`}/meeting/${data.meeting.urlKey}`,
			);
		});

		it("never carries the meeting's video-call link", async () => {
			const data = await loadPublicLineupBlastData(seed.meetingId);
			if (!data) throw new Error("expected lineup data");
			expect(JSON.stringify(data)).not.toContain("zoom.example");
			const blast = buildLineupBlast(data);
			expect(blast.text).not.toContain("zoom.example");
			expect(blast.html).not.toContain("zoom.example");
		});
	});

	describe("get_lineup_blast", () => {
		it("returns the SAME draft the button builds, from the shared builder", async () => {
			const token = await tokenFor(seed.adminUserId);
			const res = (await getLineupBlastTool.handler(
				{ meetingId: seed.meetingId },
				{ rawToken: token },
			)) as ToolResult;
			const data = await loadPublicLineupBlastData(seed.meetingId);
			if (!data) throw new Error("expected lineup data");
			// The footer origin is the server's, on BOTH surfaces.
			expect(data.origin).toBe(appBaseUrl());
			const expected = buildLineupBlast(data);
			expect(res.text).toBe(expected.text);
			expect(res.html).toBe(expected.html);
			expect(res.subject).toBe(expected.subject);
			expect(res.openCount).toBe(2);
			expect(JSON.stringify(res)).not.toContain("zoom.example");
		});

		it("admits an officer", async () => {
			await testDb
				.insert(officerTerms)
				.values({ membershipId: seed.memberId, position: "vp_education" });
			const token = await tokenFor(seed.memberUserId);
			const res = (await getLineupBlastTool.handler(
				{ meetingId: seed.meetingId },
				{ rawToken: token },
			)) as ToolResult;
			expect(res.openCount).toBe(2);
		});

		it("REFUSES a plain member", async () => {
			const token = await tokenFor(seed.memberUserId);
			await expect(
				getLineupBlastTool.handler(
					{ meetingId: seed.meetingId },
					{ rawToken: token },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("refuses an archived club", async () => {
			const token = await tokenFor(seed.adminUserId);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			await expect(
				getLineupBlastTool.handler(
					{ meetingId: seed.meetingId },
					{ rawToken: token },
				),
			).rejects.toMatchObject({ code: "ARCHIVED" });
		});
	});
});
