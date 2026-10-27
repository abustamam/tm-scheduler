/**
 * #1341: member ids are public on past agendas, so the refusal for a sessionless
 * claim must not vary with the named member's status. Every member who cannot
 * take roles gets the same message, for every caller.
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
const { resolveSessionActor, resolveWriteActorWithProof } = await import(
	"./write-actor-logic"
);

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

	it("a signed-in admin hears the same message, for every status", async () => {
		// Maintainer decision on #1341: one message everywhere, officers included.
		const unknown = await requireMemberInClub(
			crypto.randomUUID(),
			club.clubId,
		).catch((e: Error) => e.message);
		await setStatus("inactive");
		const inactive = await requireMemberInClub(
			club.memberId,
			club.clubId,
		).catch((e: Error) => e.message);
		await setStatus("former");
		const former = await requireMemberInClub(club.memberId, club.clubId).catch(
			(e: Error) => e.message,
		);
		expect(new Set([unknown, inactive, former])).toEqual(
			new Set([MEMBER_NOT_ELIGIBLE_MESSAGE]),
		);
	});

	it("the signed-in lapsed-member copy reaches an ENDED member's own session", async () => {
		await setStatus("former");
		await expect(
			resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: club.memberUserId,
			}),
		).rejects.toThrow(exactly(MEMBERSHIP_INACTIVE_MESSAGE));
	});
});
