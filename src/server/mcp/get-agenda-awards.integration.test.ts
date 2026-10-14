/**
 * DB-backed tests for `get_agenda`'s `awards` field (#1172).
 *
 * `set_awards` is only usable if an assistant can first tell what is already
 * recorded, so these pin the shape it reads: always three entries in
 * `AWARD_CATEGORIES` order, a guest as a name only, and a write-in (#582) as a
 * winner with no id.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/get-agenda-awards.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, guests, meetingAwards, members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getAgendaTool } = await import("#/server/mcp/tools/get-agenda");
const { hashApiToken } = await import("#/server/api-tokens-logic");

interface AgendaOut {
	awards: {
		category: string;
		winner: { kind: string; id: string | null; name: string } | null;
	}[];
}

describe.skipIf(!hasTestDb)("get_agenda awards (#1172)", () => {
	let seed: SeededClub;
	let token: string;

	const getAgenda = async () =>
		(await getAgendaTool.handler(
			{ meetingId: seed.meetingId },
			{ rawToken: token },
		)) as AgendaOut;

	beforeEach(async () => {
		seed = await seedClub();
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;
	});

	afterEach(async () => {
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("returns all three categories in order with winner null when nothing is recorded", async () => {
		// protects=an unrecorded meeting reads as three explicit nulls, not an empty list
		// fails_when=a category is missing or out of order, so a caller cannot tell "none" from "not loaded"
		// no_claim=none beyond protects
		const out = await getAgenda();
		expect(out.awards).toEqual([
			{ category: "best_speaker", winner: null },
			{ category: "best_evaluator", winner: null },
			{ category: "best_table_topics", winner: null },
		]);
	});

	it("reads a member, a guest and a write-in winner in their own shapes", async () => {
		// protects=kind and id per arm, with the write-in carrying a null id
		// fails_when=a write-in reads as null (blank), or a guest reads as a member
		// no_claim=none beyond protects
		const [guest] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name: "Visitor Vera" },
					testDb,
				),
			)
			.returning({ id: guests.id });
		await testDb.insert(meetingAwards).values([
			{
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				category: "best_evaluator",
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				guestId: guest!.id,
			},
			{
				meetingId: seed.meetingId,
				category: "best_table_topics",
				writeInName: "Walk-in Wendy",
			},
		]);

		const out = await getAgenda();
		expect(out.awards).toEqual([
			{
				category: "best_speaker",
				winner: { kind: "member", id: seed.memberId, name: "Member User" },
			},
			{
				category: "best_evaluator",
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				winner: { kind: "guest", id: guest!.id, name: "Visitor Vera" },
			},
			{
				category: "best_table_topics",
				winner: { kind: "writeIn", id: null, name: "Walk-in Wendy" },
			},
		]);
	});

	it("a guest winner carries a name only, never a contact", async () => {
		// protects=an agenda in a transcript names the guest winner and nothing else
		// fails_when=the guest's email or phone appears anywhere in the winner object
		// no_claim=the whole-response sweep is mcp-route.integration.test.ts
		const [guest] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{
						clubId: seed.clubId,
						name: "Contactful Guest",
						email: "raw.winner@example.com",
						phone: "+15557654321",
					},
					testDb,
				),
			)
			.returning({ id: guests.id });
		await testDb.insert(meetingAwards).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			guestId: guest!.id,
		});

		const out = await getAgenda();
		const winner = out.awards[0]?.winner;
		expect(winner?.name).toBe("Contactful Guest");
		expect(Object.keys(winner ?? {}).sort()).toEqual(["id", "kind", "name"]);
		const raw = JSON.stringify(out);
		expect(raw).not.toContain("raw.winner@example.com");
		expect(raw).not.toContain("5557654321");
	});

	it("reads a row whose member was deleted as no winner, and a blank-named winner as a winner", async () => {
		// protects=an award row naming nobody reads null; a winner with an empty name is still shown
		// fails_when=the deleted-member row reads as a winner, or the blank-named winner reads as none
		// no_claim=none beyond protects
		const [person] = await testDb
			.insert(people)
			.values({ name: "Blank" })
			.returning({ id: people.id });
		const [blank] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: person!.id,
				name: "",
				status: "active",
			})
			.returning({ id: members.id });
		await testDb.insert(meetingAwards).values([
			{
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				category: "best_evaluator",
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				memberId: blank!.id,
			},
		]);
		// ON DELETE SET NULL: the best_speaker row stays, naming nobody.
		await testDb.delete(members).where(eq(members.id, seed.memberId));

		const out = await getAgenda();
		expect(out.awards).toEqual([
			{ category: "best_speaker", winner: null },
			{
				category: "best_evaluator",
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				winner: { kind: "member", id: blank!.id, name: "" },
			},
			{ category: "best_table_topics", winner: null },
		]);
	});
});
