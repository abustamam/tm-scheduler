/**
 * The award WRITER is an enforcement point for disqualification (#786).
 *
 * #723 put the rule in two places: the public ballot hides a ruled-out name,
 * and `castVote` refuses a vote for one. Confirming the WINNER was left a
 * deliberate human tap, and the writer behind that tap consulted neither — so a
 * request naming a ruled-out candidate wrote `meeting_awards`, and from there
 * the name reached the minutes, the emailed minutes and the public minutes PDF,
 * where it reads as the club's official result.
 *
 * Every test here calls `setAward` DIRECTLY, with no UI and no poll. That is
 * the shape a hand-crafted POST has, and it is also the shape a Vote Counter's
 * console has while its 5s poll is still in flight — a ruling made seconds ago
 * leaves a tappable winner button on someone else's screen. Each refusal
 * carries an eligible neighbour beside it, because a bug that rules out the
 * whole category is indistinguishable from a correct gate without one.
 *
 * WHO may write an award at all is a different question, asked by a different
 * layer: `minutes-authz.guard.test.ts` proves `setMinutesAward` gates, and
 * `vote-counter-capability.integration.test.ts` proves what that gate decides.
 * This file exercises the seam once the gate has said yes, which is why it
 * holds regardless of how #752 resolves.
 *
 * Skipped wholesale when TEST_DATABASE_URL is unset.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAwards,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
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

const { setAward } = await import("#/server/minutes-logic");
const { castVote, disqualifyCandidate, openVote, undoDisqualification } =
	await import("#/server/voting-logic");

describe.skipIf(!hasTestDb)("award writer vs disqualification (#786)", () => {
	let seed: SeededClub;
	let secondMemberId: string;

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				sortOrder: 99,
			})
			.returning({ id: roleDefinitions.id });
		const personId = await seedPerson({ name: "Second Speaker" });
		const [m2] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: "Second Speaker",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		secondMemberId = m2.id;
		await testDb.insert(roleSlots).values([
			{
				meetingId: seed.meetingId,
				roleDefinitionId: def.id,
				slotIndex: 0,
				assignedMemberId: seed.adminMemberId,
			},
			{
				meetingId: seed.meetingId,
				roleDefinitionId: def.id,
				slotIndex: 1,
				assignedMemberId: secondMemberId,
			},
		]);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const rule = (
		candidate: Parameters<typeof disqualifyCandidate>[0]["candidate"],
		category:
			| "best_speaker"
			| "best_evaluator"
			| "best_table_topics" = "best_speaker",
		meetingId = seed.meetingId,
	) =>
		disqualifyCandidate({
			meetingId,
			clubId: seed.clubId,
			category,
			candidate,
			reason: "Outside the qualifying window",
			actorMemberId: seed.adminMemberId,
		});

	const unrule = (
		candidate: Parameters<typeof undoDisqualification>[0]["candidate"],
		category:
			| "best_speaker"
			| "best_evaluator"
			| "best_table_topics" = "best_speaker",
	) =>
		undoDisqualification({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			category,
			candidate,
			actorMemberId: seed.adminMemberId,
		});

	/** Awards on THIS meeting only — ~50 DB-backed suites share one Postgres. */
	const myAwards = () =>
		testDb
			.select({
				category: meetingAwards.category,
				m: meetingAwards.memberId,
				g: meetingAwards.guestId,
				w: meetingAwards.writeInName,
			})
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, seed.meetingId));

	const newGuest = async (name: string, email?: string) => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name, email: email ?? null })
			.returning({ id: guests.id });
		return g.id;
	};

	// The headline case. `meeting_awards` is the table the minutes PDF renders,
	// so a write that lands here is already the club's published result.
	it("refuses a disqualified MEMBER, and writes nothing", async () => {
		await rule({ kind: "member", id: seed.adminMemberId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.adminMemberId,
			}),
		).rejects.toThrow(/disqualified/i);
		expect(await myAwards()).toHaveLength(0);
	});

	// The control that makes the refusal above mean something: it has to be
	// about THIS candidate, not about the category holding a ruling at all.
	it("still crowns the eligible neighbour in the same category", async () => {
		await rule({ kind: "member", id: seed.adminMemberId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: secondMemberId,
			}),
		).resolves.toBeUndefined();
		expect(await myAwards()).toEqual([
			{ category: "best_speaker", m: secondMemberId, g: null, w: null },
		]);
	});

	// A ruling is per CATEGORY. Someone barred from Best Speaker for speaking
	// outside the window can still win Best Evaluator the same night.
	it("still crowns that same member in a DIFFERENT category", async () => {
		await rule({ kind: "member", id: seed.adminMemberId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_evaluator",
				memberId: seed.adminMemberId,
			}),
		).resolves.toBeUndefined();
		expect(await myAwards()).toEqual([
			{ category: "best_evaluator", m: seed.adminMemberId, g: null, w: null },
		]);
	});

	it("refuses a disqualified GUEST", async () => {
		const guestId = await newGuest("Visiting Speaker");
		await rule({ kind: "guest", id: guestId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				guestId,
			}),
		).rejects.toThrow(/disqualified/i);
		expect(await myAwards()).toHaveLength(0);
	});

	/**
	 * The inline-new-guest arm, which is the reason the check sits AFTER the
	 * candidate is resolved rather than over the raw input.
	 *
	 * `resolveGuestId` does not always mint a row: since #773 it first matches a
	 * RETURNING visitor by email, so `newGuest` can resolve to an existing guest
	 * — including one already ruled out. A check written over `input.guestId`
	 * would see nothing to check here and let that write through.
	 */
	it("refuses an inline newGuest that resolves to a disqualified guest", async () => {
		const guestId = await newGuest("Visiting Speaker", "visitor@test.example");
		await rule({ kind: "guest", id: guestId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				newGuest: { name: "Visiting Speaker", email: "visitor@test.example" },
			}),
		).rejects.toThrow(/disqualified/i);
		expect(await myAwards()).toHaveLength(0);
	});

	/**
	 * The write-in arm, matched through the SHARED fold.
	 *
	 * A write-in has no row to key on: its identity is the typed string, and the
	 * ruling stores `writeInKey(name)`. Confirming a winner from the console
	 * sends whatever spelling that surface is holding, which is the first one
	 * cast rather than the one the Vote Counter ruled out — so a writer matching
	 * raw would let a ruled-out name back in through its own capitals.
	 */
	it("refuses a disqualified WRITE-IN, including a case and spacing variant", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "writeIn", name: "Bo Smith" },
		});
		await rule({ kind: "writeIn", name: "Bo Smith" }, "best_table_topics");

		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_table_topics",
				writeInName: "  bo   smith ",
			}),
		).rejects.toThrow(/disqualified/i);
		expect(await myAwards()).toHaveLength(0);

		// And an unrelated typed name is untouched by that ruling.
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_table_topics",
				writeInName: "Rehanna Khan",
			}),
		).resolves.toBeUndefined();
		expect(await myAwards()).toEqual([
			{
				category: "best_table_topics",
				m: null,
				g: null,
				w: "Rehanna Khan",
			},
		]);
	});

	// Rulings are scoped to a meeting. A club runs these every two weeks with
	// the same roster, so an unscoped check would bar last fortnight's
	// ruled-out speaker from winning ever again.
	it("ignores a ruling made on a DIFFERENT meeting", async () => {
		const [other] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		await rule(
			{ kind: "member", id: seed.adminMemberId },
			"best_speaker",
			other.id,
		);
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.adminMemberId,
			}),
		).resolves.toBeUndefined();
		expect(await myAwards()).toEqual([
			{ category: "best_speaker", m: seed.adminMemberId, g: null, w: null },
		]);
	});

	// The check reads CURRENT state; it does not remember that a ruling once
	// existed. Undo is the correction path for a mis-tapped ruling, and it has
	// to put the winner back within reach of the same tap that was refused.
	it("crowns the candidate once the ruling is undone", async () => {
		await rule({ kind: "member", id: seed.adminMemberId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.adminMemberId,
			}),
		).rejects.toThrow(/disqualified/i);

		await unrule({ kind: "member", id: seed.adminMemberId });
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.adminMemberId,
			}),
		).resolves.toBeUndefined();
		expect(await myAwards()).toEqual([
			{ category: "best_speaker", m: seed.adminMemberId, g: null, w: null },
		]);
	});

	// The happy path, unchanged: nobody is ruled out, and the offline replay
	// that reuses a client-supplied guest id still converges on ONE guest row
	// rather than minting an orphan (#176 slice 5).
	it("leaves the undisqualified inline-guest replay converging on one row", async () => {
		const op = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			newGuestId: crypto.randomUUID(),
			newGuest: { name: "Replayed Visitor" },
		};
		await setAward(op);
		await setAward(op);
		const rows = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(rows).toHaveLength(1);
		expect(await myAwards()).toEqual([
			{ category: "best_speaker", m: null, g: rows[0].id, w: null },
		]);
	});
});
