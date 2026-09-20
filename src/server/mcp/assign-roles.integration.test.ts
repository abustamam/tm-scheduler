/**
 * DB-backed tests for `assign_roles` (#809).
 *
 * The tool plans and APPLIES in one call, so every case here asserts both
 * halves: what the caller is told, and what the database now holds. A blocking
 * case asserts the second half hardest — the promise is that nothing in the
 * batch lands, and a refusal that half-applied would look identical to the
 * caller.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/assign-roles.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	guests,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * The guest seam, wrapped rather than replaced.
 *
 * Two things need it and neither can be done with real rows. The tool is
 * supposed to reach `applyAssignGuestToSlot` rather than re-issue its query
 * (AC5), and the only way to see WHICH function ran is to watch it. And the
 * atomicity case needs a failure at the LAST assignment — which cannot happen
 * for real, because every validation runs up front and refuses the whole batch
 * before a single write. That is the design working; it also means an injected
 * throw is the only way to reach the rollback path, and the rollback is the
 * half of "one transaction or none of it" that nothing else proves.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above every import, so a
 * plain `let` in this module's body would still be in its temporal dead zone.
 */
const spy = vi.hoisted(() => ({
	/** Fail the Nth guest assignment of the current call. 0 = never. */
	failOnCall: 0,
	calls: [] as { slotId: string; conn: unknown }[],
}));

vi.mock("#/server/guests-logic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/server/guests-logic")>();
	return {
		...actual,
		applyAssignGuestToSlot: async (
			input: Parameters<typeof actual.applyAssignGuestToSlot>[0],
			conn?: Parameters<typeof actual.applyAssignGuestToSlot>[1],
		) => {
			spy.calls.push({ slotId: input.slotId, conn });
			if (spy.failOnCall !== 0 && spy.calls.length === spy.failOnCall) {
				throw new Error("injected failure at the last assignment");
			}
			return actual.applyAssignGuestToSlot(input, conn);
		},
	};
});

const { assignRolesTool } = await import("#/server/mcp/tools/assign-roles");
const { MEETING_LOCKED_BLOCKING_MESSAGE } = await import(
	"#/server/mcp/tools/assign-roles"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyAssignGuestToSlot } = await import("#/server/guests-logic");

interface BlockingItem {
	code: string;
	entryIndex?: number;
	message: string;
	detail?: unknown;
}

interface PlanLine {
	index: number;
	slotId: string;
	role: string;
	from: string;
	to: string;
	change: string;
	speech?: string;
}

interface Applied {
	applied: true;
	meetingId: string;
	clubId: string;
	summary: { members: number; guests: number; cleared: number };
	plan: PlanLine[];
}

describe.skipIf(!hasTestDb)("assign_roles (#809)", () => {
	let seed: SeededClub;
	let token: string;
	/** A second active member, so a reassign has somewhere to go. */
	let otherMemberId: string;
	let otherPersonId: string;
	let speakerRoleId: string;

	function call(args: Record<string, unknown>) {
		return assignRolesTool.handler(args, { rawToken: token });
	}

	/** Mint a token for a user, the way the transport resolves one. */
	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	async function slotState(slotId: string) {
		const [row] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				assignedGuestId: roleSlots.assignedGuestId,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		return row;
	}

	/** Activity rows for one slot, newest first. Club-scoped: vitest runs files
	 *  in parallel against one `tm_test`. */
	async function actionsFor(slotId: string): Promise<string[]> {
		const rows = await testDb
			.select({ action: activityLog.action })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.targetId, slotId),
				),
			);
		return rows.map((r) => r.action);
	}

	/** Another Timer slot on the seeded meeting. */
	async function addSlot(slotIndex: number): Promise<string> {
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				slotIndex,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return row!.id;
	}

	/** A Speaker slot held by `memberId`, with a linked speech owned by `personId`. */
	async function addSpeakerSlotWithSpeech(
		memberId: string,
		personId: string,
		slotIndex: number,
	): Promise<{ slotId: string; speechId: string }> {
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				slotIndex,
				status: "claimed",
				assignedMemberId: memberId,
			})
			.returning({ id: roleSlots.id });
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId, title: "Ice Breaker" })
			.returning({ id: speeches.id });
		// biome-ignore lint/style/noNonNullAssertion: inserts return rows
		await testDb
			.update(roleSlots)
			.set({ speechId: speech!.id })
			.where(eq(roleSlots.id, slot!.id));
		// biome-ignore lint/style/noNonNullAssertion: inserts return rows
		return { slotId: slot!.id, speechId: speech!.id };
	}

	async function addGuest(
		clubId: string,
		name: string,
		convertedMembershipId?: string,
	): Promise<string> {
		const [row] = await testDb
			.insert(guests)
			.values({
				clubId,
				name,
				...(convertedMembershipId ? { convertedMembershipId } : {}),
			})
			.returning({ id: guests.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return row!.id;
	}

	beforeEach(async () => {
		spy.failOnCall = 0;
		spy.calls.length = 0;
		seed = await seedClub();
		token = await mintToken(seed.adminUserId);

		const [person] = await testDb
			.insert(people)
			.values({ name: "Sam Second" })
			.returning({ id: people.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		otherPersonId = person!.id;
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: otherPersonId,
				name: "Sam Second",
				status: "active",
			})
			.returning({ id: members.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		otherMemberId = member!.id;

		const [speakerRole] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		speakerRoleId = speakerRole!.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("each kind applies and says what it did", () => {
		it("fills an OPEN slot with a member, and logs it as a claim", async () => {
			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
			})) as Applied;

			expect(res.applied).toBe(true);
			expect(res.clubId).toBe(seed.clubId);
			expect(res.plan).toHaveLength(1);
			expect(res.plan[0]).toMatchObject({
				index: 0,
				slotId: seed.slotId,
				role: "Timer",
				from: "open",
				to: "Member User",
				change: "open → Member User",
			});
			expect(res.summary).toEqual({ members: 1, guests: 0, cleared: 0 });

			const row = await slotState(seed.slotId);
			expect(row?.assignedMemberId).toBe(seed.memberId);
			expect(row?.status).toBe("claimed");
			// An open slot taken is a CLAIM. Logging it as `reassign` renders as
			// "reassigned Timer: someone → Member User" — a sentence with a `from`
			// that never existed.
			expect(await actionsFor(seed.slotId)).toEqual(["claim"]);
		});

		it("moves a HELD slot to another member, and logs it as a reassign", async () => {
			await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
			});

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, memberId: otherMemberId }],
			})) as Applied;

			expect(res.plan[0]?.change).toBe("Member User → Sam Second");
			expect((await slotState(seed.slotId))?.assignedMemberId).toBe(
				otherMemberId,
			);
			expect(await actionsFor(seed.slotId)).toEqual(["claim", "reassign"]);
		});

		it("assigns a guest through applyAssignGuestToSlot, not a second query", async () => {
			const guestId = await addGuest(seed.clubId, "Visitor Vera");

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, guestId }],
			})) as Applied;

			expect(res.plan[0]?.change).toBe("open → Visitor Vera");
			expect(res.summary).toEqual({ members: 0, guests: 1, cleared: 0 });
			const row = await slotState(seed.slotId);
			expect(row?.assignedGuestId).toBe(guestId);
			expect(row?.assignedMemberId).toBeNull();
			// AC5: the seam ran. A hand-rolled UPDATE in the tool would reach the
			// same end state with this list empty, which is the only thing that
			// tells the two implementations apart.
			expect(spy.calls.map((c) => c.slotId)).toEqual([seed.slotId]);
			expect(await actionsFor(seed.slotId)).toEqual(["reassign"]);
		});

		it("clears a slot and logs it as a release", async () => {
			await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
			});

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, clear: true }],
			})) as Applied;

			expect(res.plan[0]?.change).toBe("Member User → open");
			expect(res.summary).toEqual({ members: 0, guests: 0, cleared: 1 });
			const row = await slotState(seed.slotId);
			expect(row?.assignedMemberId).toBeNull();
			expect(row?.status).toBe("open");
			expect(await actionsFor(seed.slotId)).toEqual(["claim", "release"]);
		});

		it("applies members, guests and clears in one call", async () => {
			const guestId = await addGuest(seed.clubId, "Visitor Vera");
			const second = await addSlot(1);
			const third = await addSlot(2);
			await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: third, memberId: seed.memberId }],
			});

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [
					{ slotId: seed.slotId, memberId: otherMemberId },
					{ slotId: second, guestId },
					{ slotId: third, clear: true },
				],
			})) as Applied;

			expect(res.summary).toEqual({ members: 1, guests: 1, cleared: 1 });
			expect(res.plan.map((l) => l.change)).toEqual([
				"open → Sam Second",
				"open → Visitor Vera",
				"Member User → open",
			]);
			expect((await slotState(seed.slotId))?.assignedMemberId).toBe(
				otherMemberId,
			);
			expect((await slotState(second))?.assignedGuestId).toBe(guestId);
			expect((await slotState(third))?.status).toBe("open");
		});
	});

	describe("a speech survives the slot it was on (ADR-0009)", () => {
		it("release unlinks the speech, keeps it Person-owned, and the plan says so", async () => {
			const { slotId, speechId } = await addSpeakerSlotWithSpeech(
				seed.memberId,
				seed.personId,
				0,
			);

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId, clear: true }],
			})) as Applied;

			expect(res.plan[0]?.speech).toBe(
				`Member User's speech "Ice Breaker" returns to Member User's unscheduled speeches.`,
			);
			expect((await slotState(slotId))?.speechId).toBeNull();
			// The speech row persists, still owned by the same Person. A plan that
			// said nothing would read like data loss to the only person who could
			// notice.
			const [persisted] = await testDb
				.select({ personId: speeches.personId })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			expect(persisted?.personId).toBe(seed.personId);
		});

		it("reassign to a DIFFERENT person unlinks it and says so", async () => {
			const { slotId } = await addSpeakerSlotWithSpeech(
				seed.memberId,
				seed.personId,
				1,
			);

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId, memberId: otherMemberId }],
			})) as Applied;

			expect(res.plan[0]?.speech).toContain("returns to");
			expect((await slotState(slotId))?.speechId).toBeNull();
		});

		it("reassign to the SAME person keeps it, and the plan stays silent", async () => {
			const { slotId, speechId } = await addSpeakerSlotWithSpeech(
				seed.memberId,
				seed.personId,
				2,
			);

			const res = (await call({
				meetingId: seed.meetingId,
				assignments: [{ slotId, memberId: seed.memberId }],
			})) as Applied;

			// The plan is computed from the same two Person ids that decide the
			// write, so it cannot claim a move the write did not make.
			expect(res.plan[0]?.speech).toBeUndefined();
			expect((await slotState(slotId))?.speechId).toBe(speechId);
		});
	});

	describe("a blocked call writes nothing", () => {
		/** Run a batch expected to block, and return its items. */
		async function blockingFrom(
			assignments: unknown[],
			meetingId = seed.meetingId,
		): Promise<BlockingItem[]> {
			try {
				await call({ meetingId, assignments });
			} catch (err) {
				const e = err as {
					code?: string;
					detail?: { blocking?: BlockingItem[] };
				};
				expect(e.code).toBe("BLOCKED");
				return e.detail?.blocking ?? [];
			}
			throw new Error("expected the call to block");
		}

		it("SLOT_NOT_IN_MEETING — a slot from another meeting, and the good one is untouched", async () => {
			const [other] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			const [strayRow] = await testDb
				.insert(roleSlots)
				.values({
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					meetingId: other!.id,
					roleDefinitionId: seed.roleDefinitionId,
					status: "open",
				})
				.returning({ id: roleSlots.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			const stray = strayRow!.id;

			const blocking = await blockingFrom([
				{ slotId: seed.slotId, memberId: seed.memberId },
				{ slotId: stray, memberId: seed.memberId },
			]);

			expect(blocking).toHaveLength(1);
			expect(blocking[0]?.code).toBe("SLOT_NOT_IN_MEETING");
			expect(blocking[0]?.entryIndex).toBe(1);
			// The half that was fine did not land either.
			expect((await slotState(seed.slotId))?.assignedMemberId).toBeNull();
			expect((await slotState(stray))?.assignedMemberId).toBeNull();
		});

		it("SLOT_NOT_IN_MEETING — a slot id that exists nowhere", async () => {
			const blocking = await blockingFrom([
				{ slotId: randomUUID(), memberId: seed.memberId },
			]);
			expect(blocking.map((b) => b.code)).toEqual(["SLOT_NOT_IN_MEETING"]);
		});

		it("NOT_A_MEMBER — an inactive member", async () => {
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(eq(members.id, otherMemberId));

			const blocking = await blockingFrom([
				{ slotId: seed.slotId, memberId: otherMemberId },
			]);
			expect(blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
			expect((await slotState(seed.slotId))?.assignedMemberId).toBeNull();
		});

		it("NOT_A_MEMBER — a member of another club", async () => {
			const [otherClub] = await testDb
				.insert(clubs)
				.values({ name: "Other Club", slug: `other-${randomUUID()}` })
				.returning({ id: clubs.id });
			const [person] = await testDb
				.insert(people)
				.values({ name: "Outside Olivia" })
				.returning({ id: people.id });
			const [outsider] = await testDb
				.insert(members)
				.values({
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					clubId: otherClub!.id,
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					personId: person!.id,
					name: "Outside Olivia",
					status: "active",
				})
				.returning({ id: members.id });

			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			const blocking = await blockingFrom([
				{ slotId: seed.slotId, memberId: outsider!.id },
			]);
			expect(blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);

			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			await cleanup(otherClub!.id, []);
		});

		it("NOT_A_GUEST — a guest of another club, and one who has since joined", async () => {
			const [otherClub] = await testDb
				.insert(clubs)
				.values({ name: "Other Club", slug: `other-${randomUUID()}` })
				.returning({ id: clubs.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			const outsider = await addGuest(otherClub!.id, "Elsewhere Eve");
			// #637: a guest who joined is a member now and must be assigned as one.
			const joined = await addGuest(seed.clubId, "Joined Jo", otherMemberId);

			expect(
				(await blockingFrom([{ slotId: seed.slotId, guestId: outsider }])).map(
					(b) => b.code,
				),
			).toEqual(["NOT_A_GUEST"]);

			const joinedBlocking = await blockingFrom([
				{ slotId: seed.slotId, guestId: joined },
			]);
			expect(joinedBlocking.map((b) => b.code)).toEqual(["NOT_A_GUEST"]);
			expect(joinedBlocking[0]?.message).toContain("member of this club now");
			// The tool made its own check rather than letting the seam's prose
			// become an INTERNAL error (`errors.ts`: nothing maps by message text).
			expect(spy.calls).toHaveLength(0);

			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			await cleanup(otherClub!.id, []);
		});

		it("MEETING_LOCKED — a completed meeting, in the tool's own words", async () => {
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, seed.meetingId));

			const blocking = await blockingFrom([
				{ slotId: seed.slotId, memberId: seed.memberId },
			]);
			expect(blocking.map((b) => b.code)).toEqual(["MEETING_LOCKED"]);
			// The blocking item belongs to the CALL, not to one line.
			expect(blocking[0]?.entryIndex).toBeUndefined();
			// Two refusals exist and they must be distinguishable: this one, and
			// `assertMeetingNotLocked` under the slot's row lock. Sharing a
			// sentence would make it impossible to say which ran (#806's lesson).
			expect(blocking[0]?.message).toBe(MEETING_LOCKED_BLOCKING_MESSAGE);
			expect(blocking[0]?.message).not.toBe(MEETING_LOCKED_MESSAGE);
			expect((await slotState(seed.slotId))?.assignedMemberId).toBeNull();
		});

		it("DUPLICATE_SLOT — the same slot twice, naming both lines", async () => {
			const blocking = await blockingFrom([
				{ slotId: seed.slotId, memberId: seed.memberId },
				{ slotId: seed.slotId, memberId: otherMemberId },
			]);
			expect(blocking.map((b) => b.code)).toEqual(["DUPLICATE_SLOT"]);
			expect(blocking[0]?.detail).toMatchObject({
				slotId: seed.slotId,
				indexes: [0, 1],
			});
			// Last-write-wins is what this refuses; neither instruction landed.
			expect((await slotState(seed.slotId))?.assignedMemberId).toBeNull();
		});

		it("reports every problem in one answer rather than the first", async () => {
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(eq(members.id, otherMemberId));
			const second = await addSlot(1);

			const blocking = await blockingFrom([
				{ slotId: second, memberId: otherMemberId },
				{ slotId: randomUUID(), clear: true },
			]);
			expect(blocking.map((b) => b.code).sort()).toEqual([
				"NOT_A_MEMBER",
				"SLOT_NOT_IN_MEETING",
			]);
		});
	});

	describe("authorization comes from the meeting", () => {
		it("takes no clubId, so no input can change what is checked", () => {
			// AC8, asserted at the contract rather than by passing a stray field:
			// the schema has no `clubId` to pair with someone else's meeting.
			expect(
				Object.keys(assignRolesTool.config.inputSchema ?? {}).sort(),
			).toEqual(["assignments", "meetingId"]);
		});

		it("refuses an admin of a DIFFERENT club, meeting and all", async () => {
			// The shape AC8 is about: a caller with real authority somewhere else.
			// They are checked against the club this MEETING belongs to, which is
			// the only club id in play — so their own is never consulted and there
			// is nothing for it to override.
			const outsiderUserId = randomUUID();
			await testDb.insert(user).values({
				id: outsiderUserId,
				name: "Outside Admin",
				email: `outside-${outsiderUserId}@test.example`,
				emailVerified: true,
			});
			const [otherClub] = await testDb
				.insert(clubs)
				.values({ name: "Other Club", slug: `other-${randomUUID()}` })
				.returning({ id: clubs.id });
			const [person] = await testDb
				.insert(people)
				.values({ name: "Outside Admin", userId: outsiderUserId })
				.returning({ id: people.id });
			await testDb.insert(members).values({
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				clubId: otherClub!.id,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: person!.id,
				name: "Outside Admin",
				clubRole: "admin",
				status: "active",
			});
			const outsiderToken = await mintToken(outsiderUserId);

			await expect(
				assignRolesTool.handler(
					{
						meetingId: seed.meetingId,
						assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
					},
					{ rawToken: outsiderToken },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect((await slotState(seed.slotId))?.assignedMemberId).toBeNull();

			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			await cleanup(otherClub!.id, [outsiderUserId]);
		});

		it("refuses an archived club", async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(
				call({
					meetingId: seed.meetingId,
					assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
				}),
			).rejects.toMatchObject({ code: "ARCHIVED" });
			expect((await slotState(seed.slotId))?.assignedMemberId).toBeNull();
		});
	});

	describe("one transaction, or none of it", () => {
		it("rolls back 99 applied assignments when the 100th fails", async () => {
			const guestId = await addGuest(seed.clubId, "Visitor Vera");
			const slotIds = [seed.slotId];
			for (let i = 1; i < 100; i++) slotIds.push(await addSlot(i));
			// Give the clears something to clear.
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, status: "claimed" })
				.where(eq(roleSlots.meetingId, seed.meetingId));

			const assignments = slotIds.map((slotId, i) => {
				if (i === 98 || i === 99) return { slotId, guestId };
				return i % 2 === 0
					? { slotId, memberId: otherMemberId }
					: { slotId, clear: true };
			});
			// The SECOND guest assignment is the last line of the batch.
			spy.failOnCall = 2;

			await expect(
				call({ meetingId: seed.meetingId, assignments }),
			).rejects.toThrow(/injected failure/);

			// Nothing landed — including the guest assignment that SUCCEEDED
			// before the failure, which is what proves the guest seam ran inside
			// the caller's transaction rather than opening its own.
			expect(spy.calls).toHaveLength(2);
			for (const slotId of slotIds) {
				const row = await slotState(slotId);
				expect(row?.assignedMemberId).toBe(seed.memberId);
				expect(row?.assignedGuestId).toBeNull();
				expect(row?.status).toBe("claimed");
			}
			// And no activity row survived either.
			expect(await actionsFor(slotIds[0] as string)).toEqual([]);
		});
	});

	describe("the seams take the caller's connection (AC10)", () => {
		/**
		 * Measured at the POOL, which is the only place the difference shows.
		 *
		 * `statementsDuring` spies on `db.$client.query` — the node-postgres
		 * Pool. Statements issued inside a transaction go to a checked-out
		 * `PoolClient` whose `query` is a different function object, so they are
		 * INVISIBLE here. That blindness is exactly the measurement: anything the
		 * apply seams run on `db` instead of on the caller's `tx` takes a second
		 * pooled connection, and only those statements appear.
		 *
		 * `role_slots`, `guests` and `clubs` are the tables to watch, and the
		 * third is the one that matters most: threading `conn` into
		 * `applyAssignGuestToSlot` is necessary but NOT sufficient, because it
		 * also calls `loadClubDefaultCountryCode`, and `releaseSlotCore` calls
		 * `assertClubNotArchived` — both of which queried `db` directly until
		 * this issue. MEASURED: on a correct call the pool sees five statements,
		 * reading `meetings`, `api_tokens`, `user` and `members`; the club row
		 * arrives on a JOIN off `members`, so `from "clubs"` appears nowhere and
		 * a hit is unambiguously a seam reaching past its `conn`.
		 *
		 * The batch below runs all THREE apply seams for that reason. The pool is
		 * 10 and nothing bounds a pool wait, so a second connection taken here is
		 * a self-DoS shape rather than an inefficiency.
		 */
		it("issues no pooled read of role_slots, guests or clubs while the batch holds its locks", async () => {
			const guestId = await addGuest(seed.clubId, "Visitor Vera");
			const second = await addSlot(1);
			const third = await addSlot(2);
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, status: "claimed" })
				.where(eq(roleSlots.id, third));

			const statements = await statementsDuring(() =>
				call({
					meetingId: seed.meetingId,
					assignments: [
						{ slotId: seed.slotId, memberId: seed.memberId },
						{ slotId: second, guestId },
						{ slotId: third, clear: true },
					],
				}),
			);

			// Floor: the spy saw SOMETHING, so an empty list cannot pass this
			// vacuously — `query-spy.ts` warns about exactly that.
			expect(statements.length).toBeGreaterThan(0);
			expect(readsOf(statements, "role_slots")).toEqual([]);
			expect(readsOf(statements, "guests")).toEqual([]);
			expect(readsOf(statements, "clubs")).toEqual([]);
		});

		it("CONTROL: the same seam called with no conn does reach the pool, and still works", async () => {
			const guestId = await addGuest(seed.clubId, "Visitor Vera");

			// The vacuity control for the case above: it proves the spy can see
			// these tables at all, so "no reads" there is a real absence. It is
			// also AC10's other half — an existing caller passes nothing and
			// behaves exactly as before, opening its own transaction.
			const statements = await statementsDuring(() =>
				applyAssignGuestToSlot({
					slotId: seed.slotId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			);

			expect(readsOf(statements, "role_slots").length).toBeGreaterThan(0);
			// `loadClubDefaultCountryCode` too, which is the half of the threading
			// that a `conn` on the transaction alone would have missed.
			expect(readsOf(statements, "clubs").length).toBeGreaterThan(0);
			expect((await slotState(seed.slotId))?.assignedGuestId).toBe(guestId);
		});
	});
});
