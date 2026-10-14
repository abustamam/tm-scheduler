/**
 * DB-backed tests for `set_awards` (#1172).
 *
 * The tool plans and APPLIES in one call, so every case asserts both halves:
 * what the caller is told, and what `meeting_awards` now holds. A blocking case
 * asserts the second half hardest, because the promise is that nothing in the
 * call lands and a half-applied refusal looks identical to the caller.
 *
 * Each case carries its card: protects / fails_when / no_claim.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/set-awards.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	guests,
	meetingAwards,
	meetingCandidateDisqualifications,
	meetings,
	meetingVoteSessions,
	members,
	people,
} from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setAwardsTool, recordRefusalItem } = await import(
	"#/server/mcp/tools/set-awards"
);
const { McpError } = await import("#/server/mcp/errors");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { listVoteSessions } = await import("#/server/voting-logic");

type Category = "best_speaker" | "best_evaluator" | "best_table_topics";

interface BlockingItem {
	code: string;
	entryIndex?: number;
	message: string;
	detail?: { category?: Category };
}

interface Applied {
	applied: true;
	meetingId: string;
	clubId: string;
	summary: string;
	plan: {
		category: Category;
		from: string;
		to: string;
		unchanged: boolean;
	}[];
}

describe.skipIf(!hasTestDb)("set_awards (#1172)", () => {
	let seed: SeededClub;
	let token: string;
	let extraClubs: SeededClub[];

	function call(args: Record<string, unknown>, rawToken = token) {
		return setAwardsTool.handler(args, { rawToken });
	}

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	/** Run a call that must be refused; return what it refused with. */
	async function blocked(
		args: Record<string, unknown>,
	): Promise<{ message: string; blocking: BlockingItem[] }> {
		try {
			await call(args);
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const e = err as InstanceType<typeof McpError>;
			expect(e.code).toBe("BLOCKED");
			return {
				message: e.message,
				blocking: (e.detail as { blocking: BlockingItem[] }).blocking,
			};
		}
		throw new Error("expected the call to be BLOCKED, but it applied");
	}

	async function awardRows(meetingId = seed.meetingId) {
		return testDb
			.select()
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, meetingId));
	}

	async function addGuest(clubId: string, name: string): Promise<string> {
		const [row] = await testDb
			.insert(guests)
			.values(await withGuestPerson({ clubId, name }, testDb))
			.returning({ id: guests.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return row!.id;
	}

	async function addMember(
		clubId: string,
		name: string,
		status: "active" | "inactive" = "active",
	): Promise<string> {
		const [person] = await testDb
			.insert(people)
			.values({ name })
			.returning({ id: people.id });
		const [member] = await testDb
			.insert(members)
			.values({
				clubId,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: person!.id,
				name,
				status,
			})
			.returning({ id: members.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return member!.id;
	}

	async function openVote(category: Category) {
		await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category });
	}

	async function setMeetingStatus(status: "completed" | "cancelled") {
		await testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, seed.meetingId));
	}

	beforeEach(async () => {
		seed = await seedClub();
		extraClubs = [];
		token = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const c of extraClubs) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
	});

	it("records a member as Best Speaker and says what changed", async () => {
		// protects=one meeting_awards row for the member and a plan line from none to "<name> (member)"
		// fails_when=no row, a row on another category or member, or a plan that omits the before/after
		// no_claim=none beyond protects
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		})) as Applied;

		expect(res.applied).toBe(true);
		expect(res.clubId).toBe(seed.clubId);
		expect(res.plan).toEqual([
			{
				category: "best_speaker",
				from: "none",
				to: "Member User (member)",
				unchanged: false,
			},
		]);
		expect(res.summary).toBe("Recorded 1 award.");
		const rows = await awardRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			category: "best_speaker",
			memberId: seed.memberId,
			guestId: null,
			writeInName: null,
		});
	});

	it("records a guest winner, by name, in the plan", async () => {
		// protects=a guest winner is written to guest_id and named without contact details
		// fails_when=the guest lands in member_id, or the plan line carries an email or phone
		// no_claim=the fixture guest has no contact; mcp-route's sweep covers a contactful one
		const guestId = await addGuest(seed.clubId, "Visitor Vera");
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_table_topics", guestId }],
		})) as Applied;

		expect(res.plan[0]?.to).toBe("Visitor Vera (guest)");
		const [row] = await awardRows();
		expect(row).toMatchObject({ guestId, memberId: null });
	});

	it("records all three categories in one call", async () => {
		// protects=three entries write three rows and the summary counts them
		// fails_when=only the first entry is written, or the summary miscounts
		// no_claim=none beyond protects
		const guestId = await addGuest(seed.clubId, "Visitor Vera");
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [
				{ category: "best_speaker", memberId: seed.memberId },
				{ category: "best_evaluator", memberId: seed.adminMemberId },
				{ category: "best_table_topics", guestId },
			],
		})) as Applied;

		expect(res.summary).toBe("Recorded 3 awards.");
		expect(res.plan.map((p) => p.category)).toEqual([
			"best_speaker",
			"best_evaluator",
			"best_table_topics",
		]);
		expect(await awardRows()).toHaveLength(3);
	});

	it("writes nothing when the third of three entries is blocked, and lists the item", async () => {
		// protects=all-or-nothing: a blocked entry leaves every row as it was
		// fails_when=the first two rows land while the third is refused
		// no_claim=a blocked entry is not shown to be the LAST processed; the guard is a pre-write collect
		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [
				{ category: "best_speaker", memberId: seed.memberId },
				{ category: "best_evaluator", memberId: seed.adminMemberId },
				{ category: "best_table_topics", guestId: randomUUID() },
			],
		});

		expect(blocking.map((b) => [b.code, b.entryIndex])).toEqual([
			["NOT_A_GUEST", 2],
		]);
		expect(await awardRows()).toHaveLength(0);
	});

	it("accepts a COMPLETED meeting", async () => {
		// protects=minutes are written after the meeting, so a completed one takes awards
		// fails_when=the tool reuses the agenda lock and refuses a completed meeting
		// no_claim=none beyond protects
		await setMeetingStatus("completed");
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		})) as Applied;

		expect(res.applied).toBe(true);
		expect(await awardRows()).toHaveLength(1);
	});

	it("refuses a CANCELLED meeting with MEETING_CANCELLED and writes nothing", async () => {
		// protects=a cancelled meeting takes no award, with the shared cancellation sentence
		// fails_when=the row is written, or the refusal carries another code or sentence
		// no_claim=none beyond protects
		await setMeetingStatus("cancelled");
		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		});

		expect(blocking).toEqual([
			{ code: "MEETING_CANCELLED", message: MEETING_CANCELLED_MESSAGE },
		]);
		expect(await awardRows()).toHaveLength(0);
	});

	it("refuses a set and a clear while that category's vote is open, and leaves other categories alone", async () => {
		// protects=an open vote blocks both a set and a clear of ITS category, and only that one
		// fails_when=either direction writes under an open ballot, or the block spills to a closed category
		// no_claim=the open window is a fixture row; opening one through the vote counter is not exercised
		await openVote("best_speaker");

		const set = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		});
		expect(set.blocking[0]).toMatchObject({
			code: "VOTE_OPEN",
			entryIndex: 0,
		});
		expect(set.blocking[0]?.message).toContain(
			"Best Speaker vote is still open",
		);

		const clear = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", clear: true }],
		});
		expect(clear.blocking.map((b) => b.code)).toEqual(["VOTE_OPEN"]);
		expect(await awardRows()).toHaveLength(0);

		const other = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_evaluator", memberId: seed.memberId }],
		})) as Applied;
		expect(other.applied).toBe(true);
	});

	it("treats a CLOSED vote as no block", async () => {
		// protects=only an open session (closed_at null) blocks
		// fails_when=the presence of a session row at all blocks
		// no_claim=none beyond protects
		await testDb.insert(meetingVoteSessions).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			closedAt: new Date(),
		});
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		})) as Applied;
		expect(res.applied).toBe(true);
	});

	it("refuses a member ruled out of the category, with the reason", async () => {
		// protects=the #786 disqualification gate holds on this surface, naming the reason
		// fails_when=a ruled-out member is recorded, or the reason is dropped
		// no_claim=none beyond protects; that a ruling is scoped to its category is the different-category case below
		await testDb.insert(meetingCandidateDisqualifications).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			candidateMemberId: seed.memberId,
			reason: "Spoke over time",
		});
		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		});

		expect(blocking).toHaveLength(1);
		expect(blocking[0]).toMatchObject({ code: "AWARD_RULED_OUT" });
		expect(blocking[0]?.message).toBe(
			"That candidate was ruled out of this award: Spoke over time",
		);
		expect(await awardRows()).toHaveLength(0);
	});

	it("refuses a guest ruled out of the category", async () => {
		// protects=the gate covers a guest candidate, not only a member
		// fails_when=a ruled-out guest is recorded
		// no_claim=none beyond protects
		const guestId = await addGuest(seed.clubId, "Visitor Vera");
		await testDb.insert(meetingCandidateDisqualifications).values({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			candidateGuestId: guestId,
			reason: "Not eligible",
		});
		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_table_topics", guestId }],
		});

		expect(blocking.map((b) => b.code)).toEqual(["AWARD_RULED_OUT"]);
		expect(await awardRows()).toHaveLength(0);
	});

	it("reports every problem across entries, not just the first", async () => {
		// protects=blocking items are collected across all entries before the throw
		// fails_when=the call stops at the first problem and the caller fixes one at a time
		// no_claim=none beyond protects
		await openVote("best_speaker");
		const { blocking, message } = await blocked({
			meetingId: seed.meetingId,
			awards: [
				{ category: "best_speaker", memberId: seed.memberId },
				{ category: "best_evaluator", guestId: randomUUID() },
			],
		});

		expect(blocking.map((b) => [b.code, b.entryIndex])).toEqual([
			["VOTE_OPEN", 0],
			["NOT_A_GUEST", 1],
		]);
		expect(message).toContain("2 problems");
	});

	it("setting a category to its current winner is unchanged and does not touch updated_at", async () => {
		// protects=a repeated winner writes nothing, says so, and counts it
		// fails_when=the upsert runs anyway and moves updated_at, or the line reads as a change
		// no_claim=identity is member id; two members sharing a name are not exercised
		await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		});
		const [before] = await awardRows();
		await new Promise((r) => setTimeout(r, 20));

		const res = (await call({
			meetingId: seed.meetingId,
			awards: [
				{ category: "best_speaker", memberId: seed.memberId },
				{ category: "best_evaluator", memberId: seed.adminMemberId },
			],
		})) as Applied;

		expect(res.plan[0]).toMatchObject({
			from: "Member User (member)",
			to: "Member User (member)",
			unchanged: true,
		});
		expect(res.plan[1]?.unchanged).toBe(false);
		expect(res.summary).toBe("Recorded 1 award, 1 unchanged.");
		const after = (await awardRows()).find(
			(r) => r.category === "best_speaker",
		);
		expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
	});

	it("changing a winner shows from and to, and replaces the row", async () => {
		// protects=a replacement reports the old winner and leaves one row
		// fails_when=a second row appears, or the old winner is lost from the plan
		// no_claim=none beyond protects
		await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		});
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.adminMemberId }],
		})) as Applied;

		expect(res.plan[0]).toMatchObject({
			from: "Member User (member)",
			to: "Admin User (member)",
			unchanged: false,
		});
		const rows = await awardRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.memberId).toBe(seed.adminMemberId);
	});

	it("refuses an unknown guest id and another club's guest, and mints no guest", async () => {
		// protects=NOT_A_GUEST with the guest-book pointer for a staged or foreign id, and no guest row created
		// fails_when=the id resolves, a guest is minted, or the message loses the confirm-page hint
		// no_claim=a pending guest-book entry is modelled as an id with no row, which is what it is until applied
		const other = await seedClub();
		extraClubs.push(other);
		const foreignGuest = await addGuest(other.clubId, "Foreign Fran");
		const guestsBefore = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));

		for (const guestId of [randomUUID(), foreignGuest]) {
			const { blocking } = await blocked({
				meetingId: seed.meetingId,
				awards: [{ category: "best_speaker", guestId }],
			});
			expect(blocking.map((b) => b.code)).toEqual(["NOT_A_GUEST"]);
			expect(blocking[0]?.message).toContain("record_guest_book");
			expect(blocking[0]?.message).toContain("confirm page");
		}

		const guestsAfter = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(guestsAfter).toHaveLength(guestsBefore.length);
		expect(await awardRows()).toHaveLength(0);
	});

	it("refuses another club's member, and accepts a lapsed member of this club", async () => {
		// protects=NOT_A_MEMBER for a foreign member; membership in THIS club counts at any status
		// fails_when=a foreign member is recorded, or an inactive member is refused (the minutes writer accepts them)
		// no_claim=none beyond protects
		const other = await seedClub();
		extraClubs.push(other);
		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: other.memberId }],
		});
		expect(blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
		expect(await awardRows()).toHaveLength(0);

		const lapsed = await addMember(seed.clubId, "Lapsed Lee", "inactive");
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: lapsed }],
		})) as Applied;
		expect(res.plan[0]?.to).toBe("Lapsed Lee (member)");
	});

	it("refuses the same category twice", async () => {
		// protects=two instructions about one category are refused, not resolved by order
		// fails_when=the later one silently wins
		// no_claim=none beyond protects
		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [
				{ category: "best_speaker", memberId: seed.memberId },
				{ category: "best_speaker", memberId: seed.adminMemberId },
			],
		});

		expect(blocking.map((b) => [b.code, b.entryIndex])).toEqual([
			["DUPLICATE_AWARD_CATEGORY", 1],
		]);
		expect(await awardRows()).toHaveLength(0);
	});

	it("refuses a ruled-out candidate and leaves an existing winner of that category untouched", async () => {
		// protects=a refused set changes nothing: the recorded winner and its updated_at survive
		// fails_when=the old winner is cleared, replaced, or its updated_at moves before the refusal
		// no_claim=none beyond protects
		await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.adminMemberId }],
		});
		const [before] = await awardRows();
		await testDb.insert(meetingCandidateDisqualifications).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			candidateMemberId: seed.memberId,
			reason: "Spoke over time",
		});
		await new Promise((r) => setTimeout(r, 20));

		const { blocking } = await blocked({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		});

		expect(blocking).toHaveLength(1);
		expect(blocking[0]).toMatchObject({ code: "AWARD_RULED_OUT" });
		const rows = await awardRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.memberId).toBe(seed.adminMemberId);
		expect(rows[0]?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
	});

	describe("a row whose member was deleted", () => {
		async function recordThenDeleteWinner(): Promise<void> {
			const gone = await addMember(seed.clubId, "Soon Deleted");
			await call({
				meetingId: seed.meetingId,
				awards: [{ category: "best_speaker", memberId: gone }],
			});
			// `member_id` is ON DELETE SET NULL: the row stays and names nobody.
			await testDb.delete(members).where(eq(members.id, gone));
		}

		it("is removed by a clear, which reports a clear and not unchanged", async () => {
			// protects=a row naming nobody is still a row: clear deletes it and says it cleared
			// fails_when=the clear reports unchanged and leaves the empty row behind
			// no_claim=how the member came to be deleted; a hard delete is the fixture
			await recordThenDeleteWinner();
			const [row] = await awardRows();
			expect(row).toMatchObject({ memberId: null, guestId: null });

			const res = (await call({
				meetingId: seed.meetingId,
				awards: [{ category: "best_speaker", clear: true }],
			})) as Applied;

			expect(res.plan).toEqual([
				{
					category: "best_speaker",
					from: "none",
					to: "none",
					unchanged: false,
				},
			]);
			expect(res.summary).toBe("Cleared 1.");
			expect(await awardRows()).toHaveLength(0);
		});

		it("can be given a new winner", async () => {
			// protects=an empty row is replaced by the upsert like any other
			// fails_when=the row stays empty or the call is refused
			// no_claim=none beyond protects
			await recordThenDeleteWinner();
			await call({
				meetingId: seed.meetingId,
				awards: [{ category: "best_speaker", memberId: seed.memberId }],
			});
			const rows = await awardRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.memberId).toBe(seed.memberId);
		});
	});

	it("shows a winner whose name is empty as that winner, so setting the same one is unchanged", async () => {
		// protects=existence of a winner comes from the id column, not from a truthy name
		// fails_when=an empty-named winner reads as none and is rewritten as a change
		// no_claim=none beyond protects
		const blank = await addMember(seed.clubId, "");
		await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: blank }],
		});

		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: blank }],
		})) as Applied;

		expect(res.plan[0]).toMatchObject({ unchanged: true });
		expect(res.plan[0]?.from).toBe(" (member)");
	});

	describe("recordRefusalItem", () => {
		it("maps each refused status to its own code and sentence", () => {
			// protects=the blocking item is chosen from the policy's refused status
			// fails_when=completed reads as the cancelled sentence, or the reverse
			// no_claim=the completed arm is unreachable through the tool today: the record class accepts it
			expect(recordRefusalItem("cancelled")).toEqual({
				code: "MEETING_CANCELLED",
				message: MEETING_CANCELLED_MESSAGE,
			});
			expect(recordRefusalItem("completed")).toEqual({
				code: "MEETING_LOCKED",
				message: MEETING_LOCKED_MESSAGE,
			});
		});
	});

	describe("the input schema", () => {
		it("rejects a write-in, both ids, an extra key, no entries and a fourth entry", async () => {
			// protects=the strict input has no write-in arm and no ambiguous winner
			// fails_when=writeInName is accepted or ignored, or memberId and guestId travel together
			// no_claim=rejection is by zod before any authorization or write
			const memberId = seed.memberId;
			const bad: unknown[] = [
				[{ category: "best_speaker", writeInName: "Someone" }],
				[{ category: "best_speaker", memberId, guestId: randomUUID() }],
				[{ category: "best_speaker", memberId, clubId: seed.clubId }],
				[{ category: "best_speaker", clear: false }],
				[{ category: "best_nobody", memberId }],
				[],
				[
					{ category: "best_speaker", clear: true },
					{ category: "best_evaluator", clear: true },
					{ category: "best_table_topics", clear: true },
					{ category: "best_speaker", clear: true },
				],
			];
			for (const awards of bad) {
				await expect(
					call({ meetingId: seed.meetingId, awards }),
				).rejects.toThrow();
			}
			expect(await awardRows()).toHaveLength(0);
		});
	});

	it("clear deletes the row, including a write-in winner, and reports none", async () => {
		// protects=clear removes the category's row whatever kind of winner it held
		// fails_when=the row survives, or a write-in winner cannot be cleared
		// no_claim=the write-in row is a fixture; the tool never creates one
		await testDb.insert(meetingAwards).values([
			{
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				category: "best_evaluator",
				writeInName: "Walk-in Wendy",
			},
		]);
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [
				{ category: "best_evaluator", clear: true },
				{ category: "best_table_topics", clear: true },
			],
		})) as Applied;

		expect(res.plan).toEqual([
			{
				category: "best_evaluator",
				from: "Walk-in Wendy (write-in)",
				to: "none",
				unchanged: false,
			},
			{
				category: "best_table_topics",
				from: "none",
				to: "none",
				unchanged: true,
			},
		]);
		expect(res.summary).toBe("Cleared 1, 1 unchanged.");
		const rows = await awardRows();
		expect(rows.map((r) => r.category)).toEqual(["best_speaker"]);
	});

	it("replaces a write-in winner with a roster member without leaving both columns set", async () => {
		// protects=the shared upsert still resets write_in_name when a roster name replaces a write-in
		// fails_when=the row keeps the write-in beside the member, which the check constraint forbids
		// no_claim=none beyond protects
		await testDb.insert(meetingAwards).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			writeInName: "Walk-in Wendy",
		});
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_speaker", memberId: seed.memberId }],
		})) as Applied;

		expect(res.plan[0]?.from).toBe("Walk-in Wendy (write-in)");
		const [row] = await awardRows();
		expect(row).toMatchObject({
			memberId: seed.memberId,
			writeInName: null,
		});
	});

	it("refuses a token whose owner is not an admin or officer of the meeting's club", async () => {
		// protects=authorizeTokenForMeeting gates the write; a plain member's token writes nothing
		// fails_when=any token holder can record awards
		// no_claim=officer-term acceptance is authz-logic's own suite, not repeated here
		const memberToken = await mintToken(seed.memberUserId);
		await expect(
			call(
				{
					meetingId: seed.meetingId,
					awards: [{ category: "best_speaker", memberId: seed.memberId }],
				},
				memberToken,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await awardRows()).toHaveLength(0);
	});

	it("leaves the ruling of a different category out of the way", async () => {
		// protects=a disqualification in one category does not block the same member in another
		// fails_when=the index is read without the category and over-blocks
		// no_claim=none beyond protects
		await testDb.insert(meetingCandidateDisqualifications).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			candidateMemberId: seed.memberId,
			reason: "Spoke over time",
		});
		const res = (await call({
			meetingId: seed.meetingId,
			awards: [{ category: "best_evaluator", memberId: seed.memberId }],
		})) as Applied;
		expect(res.applied).toBe(true);
		expect(
			await testDb
				.select()
				.from(meetingAwards)
				.where(
					and(
						eq(meetingAwards.meetingId, seed.meetingId),
						eq(meetingAwards.category, "best_evaluator"),
					),
				),
		).toHaveLength(1);
	});
});

describe.skipIf(!hasTestDb)(
	"listVoteSessions inside a transaction (#1172)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("reads through the connection it is given, so it sees the transaction's own uncommitted state", async () => {
			// protects=the optional connection argument is used rather than ignored
			// fails_when=the helper still reads on the global client, which cannot see an uncommitted open session
			// no_claim=the default (no argument) path is the one every existing caller uses and is not re-tested here
			class Rollback extends Error {}
			await expect(
				testDb.transaction(async (tx) => {
					await tx.insert(meetingVoteSessions).values({
						meetingId: seed.meetingId,
						category: "best_evaluator",
					});
					const inside = await listVoteSessions(seed.meetingId, tx);
					const outside = await listVoteSessions(seed.meetingId);
					expect(inside.best_evaluator.isOpen).toBe(true);
					expect(inside.best_speaker.isOpen).toBe(false);
					expect(outside.best_evaluator.isOpen).toBe(false);
					throw new Rollback();
				}),
			).rejects.toBeInstanceOf(Rollback);
		});
	},
);
