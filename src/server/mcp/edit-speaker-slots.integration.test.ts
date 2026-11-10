/**
 * DB-backed tests for `edit_speaker_slots` (#1576).
 *
 * Card: protects=a speaker line-up edited from the connector ends up exactly as
 * the app's own "+ / − speaker" and arrow controls would leave it (paired
 * evaluators, dense numbering, held slots never destroyed), all steps or none;
 * fails_when=a preview writes, a held pair is removed, a later step's failure
 * leaves an earlier one applied, an evaluator stops pointing at its speaker
 * after a move, or the wrong caller is served;
 * no_claim=the app's own removal races (`speaker-pair-removal-race`) and the
 * authorization table (`delegate-authz`).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
	activityLog,
	apiTokens,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { editSpeakerSlotsTool } = await import(
	"#/server/mcp/tools/edit-speaker-slots"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const slotsLogic = await import("#/server/slots-logic");
const { applyAddSpeakerSlot, SPEAKER_CLAIMED_MESSAGE } = slotsLogic;
const { MAX_MOVES, MAX_SPEAKER_COUNT } = await import(
	"#/lib/speaker-slot-limits"
);

type Blocking = {
	code: string;
	entryIndex?: number;
	message: string;
	detail?: { holder?: string | null; slotId?: string | null };
};
type Line = {
	slotId: string;
	position: number;
	holder: { name: string } | null;
	evaluates?: number | null;
};
type Preview = {
	applied: false;
	planHash: string;
	blocking: Blocking[];
	plan: {
		before: { speakers: Line[]; evaluators: Line[] };
		after: { speakers: unknown[]; evaluators: unknown[] };
	};
};

describe.skipIf(!hasTestDb)("edit_speaker_slots (#1576)", () => {
	let seed: SeededClub;
	let token: string;
	let speakerRoleId: string;
	let evaluatorRoleId: string;
	const extraUsers: string[] = [];

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	const call = (args: Record<string, unknown>, raw = token) =>
		editSpeakerSlotsTool.handler(args, { rawToken: raw });

	const preview = async (
		args: Record<string, unknown>,
		meetingId = seed.meetingId,
		raw = token,
	): Promise<Preview> => (await call({ meetingId, ...args }, raw)) as Preview;

	async function outcome(p: Promise<unknown>) {
		try {
			return { ok: true as const, value: await p };
		} catch (err) {
			const e = err as { code?: string; message: string; detail?: unknown };
			return {
				ok: false as const,
				err,
				code: e.code,
				message: e.message,
				detail: e.detail as { blocking?: Blocking[] } | undefined,
			};
		}
	}

	/** The first zod issue of a schema refusal (the route maps it to VALIDATION). */
	const schemaIssue = (err: unknown) => {
		expect(err).toBeInstanceOf(ZodError);
		const i = (err as ZodError).issues[0];
		return { path: i?.path, code: i?.code };
	};

	/** The stored line-ups, read straight from the rows. */
	async function stored(meetingId = seed.meetingId) {
		const rows = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, meetingId))
			.orderBy(asc(roleSlots.slotIndex), asc(roleSlots.id));
		return {
			speakers: rows.filter((r) => r.roleDefinitionId === speakerRoleId),
			evaluators: rows.filter((r) => r.roleDefinitionId === evaluatorRoleId),
		};
	}

	/** Assert Evaluator N evaluates Speaker N and numbering is dense. */
	async function expectPaired(meetingId = seed.meetingId) {
		const { speakers, evaluators } = await stored(meetingId);
		expect(speakers.map((s) => s.slotIndex)).toEqual(speakers.map((_, i) => i));
		expect(evaluators.map((e) => e.slotIndex)).toEqual(
			evaluators.map((_, i) => i),
		);
		for (const [i, e] of evaluators.entries()) {
			expect(e.evaluatesSlotId).toBe(speakers[i]?.id ?? null);
		}
	}

	async function seedPairs(n: number) {
		for (let i = 0; i < n; i++) {
			await applyAddSpeakerSlot({
				meetingId: seed.meetingId,
				actorMemberId: null,
			});
		}
	}

	async function addUserMember(name: string) {
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
				clubId: seed.clubId,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: person!.id,
				name,
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return { userId, memberId: member!.id };
	}

	async function hold(slotId: string, memberId: string) {
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: memberId, status: "confirmed" })
			.where(eq(roleSlots.id, slotId));
	}

	async function makeToastmaster(meetingId: string, name: string) {
		const m = await addUserMember(name);
		let [def] = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, seed.clubId),
					eq(roleDefinitions.name, "Toastmaster of the Day"),
				),
			);
		if (!def) {
			[def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Toastmaster of the Day",
					category: "functionary",
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
		}
		await testDb.insert(roleSlots).values({
			meetingId,
			// biome-ignore lint/style/noNonNullAssertion: def exists
			roleDefinitionId: def!.id,
			assignedMemberId: m.memberId,
			status: "confirmed",
		});
		return m;
	}

	async function otherMeeting() {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return m!.id;
	}

	const countRows = async () =>
		(
			await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, seed.meetingId))
		).length;
	const countLogs = async () =>
		(
			await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, seed.clubId))
		).length;

	beforeEach(async () => {
		seed = await seedClub();
		token = await mintToken(seed.adminUserId);
		const [sp] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				defaultCount: 3,
				sortOrder: 1,
			})
			.returning({ id: roleDefinitions.id });
		const [ev] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Evaluator",
				category: "evaluator",
				isSpeakerRole: false,
				defaultCount: 3,
				sortOrder: 2,
			})
			.returning({ id: roleDefinitions.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		speakerRoleId = sp!.id;
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		evaluatorRoleId = ev!.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const id of extraUsers.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	it("a preview writes nothing and shows the line-up before and after", async () => {
		await seedPairs(1);
		const rows = await countRows();
		const logs = await countLogs();
		const p = await preview({ addSpeakers: 2 });
		expect(p.applied).toBe(false);
		expect(p.blocking).toEqual([]);
		expect(p.plan.before.speakers).toHaveLength(1);
		expect(p.plan.after.speakers).toHaveLength(3);
		expect(p.plan.after.evaluators).toHaveLength(3);
		expect(await countRows()).toBe(rows);
		expect(await countLogs()).toBe(logs);
	});

	it("addSpeakers: 2 adds two speaker slots and two paired evaluators", async () => {
		const p = await preview({ addSpeakers: 2 });
		const r = (await call({
			meetingId: seed.meetingId,
			addSpeakers: 2,
			planHash: p.planHash,
		})) as { applied: boolean; lineup: { speakers: unknown[] } };
		expect(r.applied).toBe(true);
		expect(r.lineup.speakers).toHaveLength(2);
		const s = await stored();
		expect(s.speakers).toHaveLength(2);
		expect(s.evaluators).toHaveLength(2);
		await expectPaired();
	});

	it("each step logs meeting_edit crediting the caller", async () => {
		const tm = await makeToastmaster(seed.meetingId, "Tess Master");
		const raw = await mintToken(tm.userId);
		const p = await preview({ addSpeakers: 1 }, seed.meetingId, raw);
		await call(
			{ meetingId: seed.meetingId, addSpeakers: 1, planHash: p.planHash },
			raw,
		);
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.every((l) => l.actorMemberId === tm.memberId)).toBe(true);
	});

	describe("removeSpeakers", () => {
		it("removes unclaimed pairs, taking the app's pair", async () => {
			await seedPairs(3);
			const before = await stored();
			const sp1 = before.speakers[0];
			const m = await addUserMember("Holder One");
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(sp1!.id, m.memberId);
			const p = await preview({ removeSpeakers: 2 });
			expect(p.blocking).toEqual([]);
			await call({
				meetingId: seed.meetingId,
				removeSpeakers: 2,
				planHash: p.planHash,
			});
			const after = await stored();
			expect(after.speakers.map((s) => s.id)).toEqual([sp1?.id]);
			expect(after.evaluators).toHaveLength(1);
			await expectPaired();
		});

		it("a held speaker blocks the whole call when it is last, and nothing is written", async () => {
			await seedPairs(2);
			const { speakers } = await stored();
			const m = await addUserMember("Last Speaker");
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(speakers[1]!.id, m.memberId);
			const before = await stored();
			const p = await preview({ removeSpeakers: 2 });
			expect(p.blocking).toHaveLength(1);
			expect(p.blocking[0]).toMatchObject({
				code: "SLOT_HELD",
				detail: { holder: "Last Speaker" },
			});
			expect(p.blocking[0]?.message).toContain(SPEAKER_CLAIMED_MESSAGE);
			const applied = await outcome(
				call({
					meetingId: seed.meetingId,
					removeSpeakers: 2,
					planHash: p.planHash,
				}),
			);
			expect(applied).toMatchObject({ ok: false, code: "BLOCKED" });
			expect(await stored()).toEqual(before);
		});

		it("a held speaker blocks the whole call when it is not last, and nothing is written", async () => {
			await seedPairs(2);
			const { speakers } = await stored();
			const m = await addUserMember("First Speaker");
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(speakers[0]!.id, m.memberId);
			const before = await stored();
			const p = await preview({ removeSpeakers: 2 });
			expect(p.blocking[0]).toMatchObject({
				code: "SLOT_HELD",
				detail: { holder: "First Speaker" },
			});
			const applied = await outcome(
				call({
					meetingId: seed.meetingId,
					removeSpeakers: 2,
					planHash: p.planHash,
				}),
			);
			expect(applied).toMatchObject({ ok: false, code: "BLOCKED" });
			expect(await stored()).toEqual(before);
		});

		it("a held evaluator of the pair blocks and names its holder", async () => {
			await seedPairs(2);
			const { evaluators } = await stored();
			const m = await addUserMember("Eva Luator");
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(evaluators[1]!.id, m.memberId);
			const before = await stored();
			const p = await preview({ removeSpeakers: 1 });
			expect(p.blocking[0]).toMatchObject({
				code: "SLOT_HELD",
				detail: { holder: "Eva Luator" },
			});
			expect(p.blocking[0]?.message).toContain("Release the evaluator");
			expect(await stored()).toEqual(before);
		});

		it("a held speaker that is not last is skipped for removeSpeakers: 1, and nothing is blocked", async () => {
			await seedPairs(3);
			const { speakers } = await stored();
			const m = await addUserMember("Middle Speaker");
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(speakers[1]!.id, m.memberId);
			const p = await preview({ removeSpeakers: 1 });
			expect(p.blocking).toEqual([]);
			await call({
				meetingId: seed.meetingId,
				removeSpeakers: 1,
				planHash: p.planHash,
			});
			const after = await stored();
			// The app takes the highest unclaimed pair: the last one. The holder's
			// slot is intact.
			expect(after.speakers.map((x) => x.id)).toEqual([
				speakers[0]?.id,
				speakers[1]?.id,
			]);
			expect(after.speakers[1]?.assignedMemberId).toBe(m.memberId);
			expect(after.evaluators).toHaveLength(2);
			await expectPaired();
		});

		it("names the evaluator of the pair the app would take, not another held evaluator", async () => {
			await seedPairs(3);
			const { speakers, evaluators } = await stored();
			const sp3 = await addUserMember("Speaker Three");
			const ev3 = await addUserMember("Evaluator Three");
			const ev2 = await addUserMember("Evaluator Two");
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(speakers[2]!.id, sp3.memberId);
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(evaluators[2]!.id, ev3.memberId);
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			await hold(evaluators[1]!.id, ev2.memberId);
			// Speaker 3 is held, so the app's pair is Speaker 2 with Evaluator 2.
			const p = await preview({ removeSpeakers: 1 });
			expect(p.blocking).toHaveLength(1);
			expect(p.blocking[0]).toMatchObject({
				code: "SLOT_HELD",
				detail: { holder: "Evaluator Two", slotId: evaluators[1]?.id },
			});
		});

		describe("a meeting whose speaker slotIndex values have a gap", () => {
			/** Speakers at slotIndex 0 and 2 (the middle pair was deleted). */
			async function gapped() {
				await seedPairs(3);
				const { speakers, evaluators } = await stored();
				// biome-ignore lint/style/noNonNullAssertion: seeded above
				await testDb
					.delete(roleSlots)
					.where(eq(roleSlots.id, evaluators[1]!.id));
				// biome-ignore lint/style/noNonNullAssertion: seeded above
				await testDb.delete(roleSlots).where(eq(roleSlots.id, speakers[1]!.id));
				const now = await stored();
				expect(now.speakers.map((x) => x.slotIndex)).toEqual([0, 2]);
				return now;
			}

			it("a held evaluator of the pair is a blocking item naming its holder, not INTERNAL", async () => {
				const { evaluators } = await gapped();
				const m = await addUserMember("Gap Evaluator");
				// biome-ignore lint/style/noNonNullAssertion: seeded above
				await hold(evaluators[1]!.id, m.memberId);
				const before = await stored();
				const p = await preview({ removeSpeakers: 1 });
				expect(p.blocking).toHaveLength(1);
				expect(p.blocking[0]).toMatchObject({
					code: "SLOT_HELD",
					detail: { holder: "Gap Evaluator", slotId: evaluators[1]?.id },
				});
				const applied = await outcome(
					call({
						meetingId: seed.meetingId,
						removeSpeakers: 1,
						planHash: p.planHash,
					}),
				);
				expect(applied).toMatchObject({ ok: false, code: "BLOCKED" });
				expect(await stored()).toEqual(before);
			});

			it("a held speaker names the speaker's holder", async () => {
				const { speakers } = await gapped();
				const a = await addUserMember("Gap One");
				const b = await addUserMember("Gap Two");
				// biome-ignore lint/style/noNonNullAssertion: seeded above
				await hold(speakers[0]!.id, a.memberId);
				// biome-ignore lint/style/noNonNullAssertion: seeded above
				await hold(speakers[1]!.id, b.memberId);
				const p = await preview({ removeSpeakers: 1 });
				expect(p.blocking).toHaveLength(1);
				expect(p.blocking[0]?.code).toBe("SLOT_HELD");
				const names = (
					p.blocking[0]?.detail as { holders: { holder: string }[] }
				).holders.map((h) => h.holder);
				expect(names.sort()).toEqual(["Gap One", "Gap Two"]);
			});
		});

		it("a meeting with no speaker slots is blocked, not an error", async () => {
			const p = await preview({ removeSpeakers: 1 });
			expect(p.blocking).toHaveLength(1);
			expect(p.blocking[0]?.code).toBe("ROLE_NOT_EDITABLE");
		});
	});

	describe("moves", () => {
		it("moves a speaker and keeps every evaluator on the right speaker, read from the final rows", async () => {
			await seedPairs(3);
			const before = await stored();
			const [a, b, c] = before.speakers.map((s) => s.id);
			const p = await preview({
				moveSpeakers: [
					// biome-ignore lint/style/noNonNullAssertion: seeded above
					{ slotId: a!, direction: "down" },
					// biome-ignore lint/style/noNonNullAssertion: seeded above
					{ slotId: c!, direction: "up" },
				],
			});
			expect(p.blocking).toEqual([]);
			await call({
				meetingId: seed.meetingId,
				moveSpeakers: [
					{ slotId: a, direction: "down" },
					{ slotId: c, direction: "up" },
				],
				planHash: p.planHash,
			});
			const after = await stored();
			// a down: b a c; then c up: b c a.
			expect(after.speakers.map((s) => s.id)).toEqual([b, c, a]);
			await expectPaired();
		});

		it("reorders evaluators, after the speakers move", async () => {
			await seedPairs(2);
			const before = await stored();
			const [e1, e2] = before.evaluators.map((e) => e.id);
			const args = {
				moveSpeakers: [
					// biome-ignore lint/style/noNonNullAssertion: seeded above
					{ slotId: before.speakers[0]!.id, direction: "down" },
				],
				// biome-ignore lint/style/noNonNullAssertion: seeded above
				moveEvaluators: [{ slotId: e1!, direction: "down" }],
			};
			const p = await preview(args);
			expect(p.blocking).toEqual([]);
			await call({ meetingId: seed.meetingId, ...args, planHash: p.planHash });
			const after = await stored();
			expect(after.evaluators.map((e) => e.id)).toEqual([e2, e1]);
			await expectPaired();
		});

		it("a move past either end is a blocking item", async () => {
			await seedPairs(2);
			const { speakers } = await stored();
			const p = await preview({
				moveSpeakers: [
					// biome-ignore lint/style/noNonNullAssertion: seeded above
					{ slotId: speakers[0]!.id, direction: "up" },
					// biome-ignore lint/style/noNonNullAssertion: seeded above
					{ slotId: speakers[1]!.id, direction: "down" },
				],
			});
			expect(p.blocking.map((b) => [b.code, b.entryIndex])).toEqual([
				["ROLE_NOT_EDITABLE", 0],
				["ROLE_NOT_EDITABLE", 1],
			]);
		});

		it("a slot that is not a speaker slot of this meeting is blocked", async () => {
			await seedPairs(2);
			const { evaluators } = await stored();
			const otherId = await otherMeeting();
			await testDb.insert(roleSlots).values({
				meetingId: otherId,
				roleDefinitionId: speakerRoleId,
				slotIndex: 0,
			});
			const [foreign] = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, otherId));
			const p = await preview({
				moveSpeakers: [
					// biome-ignore lint/style/noNonNullAssertion: inserted above
					{ slotId: foreign!.id, direction: "down" },
					// An evaluator slot in the speaker list.
					// biome-ignore lint/style/noNonNullAssertion: seeded above
					{ slotId: evaluators[0]!.id, direction: "down" },
					// The meeting's Timer slot.
					{ slotId: seed.slotId, direction: "down" },
				],
			});
			expect(p.blocking.map((b) => b.code)).toEqual([
				"SLOT_NOT_IN_MEETING",
				"SLOT_NOT_IN_MEETING",
				"SLOT_NOT_IN_MEETING",
			]);
		});
	});

	it("a step that throws mid-apply rolls back the earlier steps, rows and activity log", async () => {
		await seedPairs(2);
		const { speakers } = await stored();
		const args = {
			addSpeakers: 1,
			// biome-ignore lint/style/noNonNullAssertion: seeded above
			moveSpeakers: [{ slotId: speakers[1]!.id, direction: "up" }],
		};
		const p = await preview(args);
		expect(p.blocking).toEqual([]);
		const rowsBefore = await stored();
		const logsBefore = await countLogs();
		// The add runs first and succeeds; the move then genuinely throws.
		const spy = vi
			.spyOn(slotsLogic, "applyMoveSpeakerSlot")
			.mockRejectedValueOnce(new Error("disk on fire"));
		let applied: Awaited<ReturnType<typeof outcome>>;
		try {
			applied = await outcome(
				call({ meetingId: seed.meetingId, ...args, planHash: p.planHash }),
			);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
		expect(applied.ok ? null : applied.message).toContain("disk on fire");
		expect(applied).not.toMatchObject({ code: "PLAN_STALE" });
		expect(await stored()).toEqual(rowsBefore);
		expect(await countLogs()).toBe(logsBefore);
	});

	it("a stale planHash returns PLAN_STALE with the fresh plan", async () => {
		const p = await preview({ addSpeakers: 1 });
		await seedPairs(1);
		const rowsBefore = await countRows();
		const applied = await outcome(
			call({ meetingId: seed.meetingId, addSpeakers: 1, planHash: p.planHash }),
		);
		expect(applied).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect(await countRows()).toBe(rowsBefore);
	});

	it("a disabled Speaker role blocks an add", async () => {
		await testDb
			.update(roleDefinitions)
			.set({ enabled: false })
			.where(eq(roleDefinitions.id, speakerRoleId));
		const p = await preview({ addSpeakers: 1 });
		expect(p.blocking.map((b) => b.code)).toEqual(["ROLE_NOT_EDITABLE"]);
		expect(p.blocking[0]?.message).toContain("disabled");
	});

	describe("who may use it", () => {
		it("the meeting's Toastmaster succeeds", async () => {
			const tm = await makeToastmaster(seed.meetingId, "Tess Master");
			const raw = await mintToken(tm.userId);
			const p = await preview({ addSpeakers: 1 }, seed.meetingId, raw);
			expect(p.applied).toBe(false);
		});

		it("a plain member is refused", async () => {
			const raw = await mintToken(seed.memberUserId);
			expect(
				await outcome(call({ meetingId: seed.meetingId, addSpeakers: 1 }, raw)),
			).toMatchObject({ ok: false, code: "FORBIDDEN" });
		});

		it("the Toastmaster of another meeting is refused", async () => {
			const otherId = await otherMeeting();
			const tm = await makeToastmaster(otherId, "Other Master");
			const raw = await mintToken(tm.userId);
			expect(
				await outcome(call({ meetingId: seed.meetingId, addSpeakers: 1 }, raw)),
			).toMatchObject({ ok: false, code: "FORBIDDEN" });
			expect(await countRows()).toBe(1);
		});
	});

	describe("lifecycle and input", () => {
		it.each([
			"completed",
			"cancelled",
		])("a %s meeting is refused", async (status) => {
			await testDb
				.update(meetings)
				.set({ status: status as "completed" })
				.where(eq(meetings.id, seed.meetingId));
			expect(
				await outcome(call({ meetingId: seed.meetingId, addSpeakers: 1 })),
			).toMatchObject({ ok: false, code: "LOCKED" });
		});

		it("needs at least one change, and refuses add with remove", async () => {
			expect(await outcome(call({ meetingId: seed.meetingId }))).toMatchObject({
				ok: false,
				code: "VALIDATION",
			});
			expect(
				await outcome(
					call({
						meetingId: seed.meetingId,
						addSpeakers: 1,
						removeSpeakers: 1,
					}),
				),
			).toMatchObject({ ok: false, code: "VALIDATION" });
		});

		it("bounds addSpeakers and removeSpeakers to 1..MAX_SPEAKER_COUNT, refusing at the schema", async () => {
			for (const n of [0, MAX_SPEAKER_COUNT + 1]) {
				for (const key of ["addSpeakers", "removeSpeakers"]) {
					const r = await outcome(
						call({ meetingId: seed.meetingId, [key]: n }),
					);
					expect(r.ok ? null : schemaIssue(r.err)).toEqual({
						path: [key],
						code: n === 0 ? "too_small" : "too_big",
					});
				}
			}
			const p = await preview({ addSpeakers: MAX_SPEAKER_COUNT });
			expect(p.blocking).toEqual([]);
		});

		it("bounds each move list to MAX_MOVES, refusing at the schema", async () => {
			const moves = (n: number) =>
				Array.from({ length: n }, () => ({
					slotId: randomUUID(),
					direction: "up",
				}));
			for (const key of ["moveSpeakers", "moveEvaluators"]) {
				const over = await outcome(
					call({ meetingId: seed.meetingId, [key]: moves(MAX_MOVES + 1) }),
				);
				expect(over.ok ? null : schemaIssue(over.err)).toEqual({
					path: [key],
					code: "too_big",
				});
				// At the boundary it passes validation (the slots are not this
				// meeting's, so they come back as blocking items, not an error).
				const at = await preview({ [key]: moves(MAX_MOVES) });
				expect(at.blocking).toHaveLength(MAX_MOVES);
			}
		});
	});
});
