/**
 * #1341: member ids are public on past agendas, so the refusal for a sessionless
 * claim must not vary with the named member's status. Every member who cannot
 * take roles gets the same message on the asserted path; a signed-in club admin
 * keeps the specific reason.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import {
	MEMBER_NOT_ELIGIBLE_MESSAGE,
	MEMBERSHIP_INACTIVE_MESSAGE,
} from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { requireMemberInClub } = await import("./guards");
const { resolveWriteActorWithProof } = await import("./write-actor-logic");

const exactly = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

describe.skipIf(!hasTestDb)("asserted-proof refusal wording (#1341)", () => {
	let club: SeededClub;
	let other: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		other = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	const setStatus = (status: "inactive" | "former") =>
		testDb.update(members).set({ status }).where(eq(members.id, club.memberId));

	async function assertedMessage(memberId: string): Promise<string> {
		try {
			await resolveWriteActorWithProof({
				clubId: club.clubId,
				sessionUserId: null,
				claimedActorMemberId: memberId,
			});
		} catch (err) {
			return (err as Error).message;
		}
		throw new Error("expected a refusal");
	}

	it("gives one message for unknown, other-club, inactive and former", async () => {
		const unknown = await assertedMessage(crypto.randomUUID());
		const otherClub = await assertedMessage(other.memberId);
		await setStatus("inactive");
		const inactive = await assertedMessage(club.memberId);
		await setStatus("former");
		const former = await assertedMessage(club.memberId);
		expect(new Set([unknown, otherClub, inactive, former]).size).toBe(1);
		expect(unknown).toBe(MEMBER_NOT_ELIGIBLE_MESSAGE);
	});

	it("a signed-in session without admin rights hears the same message", async () => {
		await setStatus("former");
		await expect(
			requireMemberInClub(club.memberId, club.clubId, club.memberUserId),
		).rejects.toThrow(exactly(MEMBER_NOT_ELIGIBLE_MESSAGE));
	});

	it("a signed-in admin still sees the specific reason", async () => {
		await setStatus("inactive");
		await expect(
			requireMemberInClub(club.memberId, club.clubId, club.adminUserId),
		).rejects.toThrow(
			exactly("That member is inactive — reactivate them first."),
		);
		await setStatus("former");
		await expect(
			requireMemberInClub(club.memberId, club.clubId, club.adminUserId),
		).rejects.toThrow(
			exactly("That member is no longer a member of this club."),
		);
		await expect(
			requireMemberInClub(crypto.randomUUID(), club.clubId, club.adminUserId),
		).rejects.toThrow(exactly(MEMBER_NOT_ELIGIBLE_MESSAGE));
	});

	it("an admin of ANOTHER club learns nothing", async () => {
		await setStatus("former");
		await expect(
			requireMemberInClub(club.memberId, club.clubId, other.adminUserId),
		).rejects.toThrow(exactly(MEMBER_NOT_ELIGIBLE_MESSAGE));
	});

	it("the signed-in lapsed-member copy covers lapsed and ended", () => {
		expect(MEMBERSHIP_INACTIVE_MESSAGE).toMatch(/lapsed or ended/);
	});
});
