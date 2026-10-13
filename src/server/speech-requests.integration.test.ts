/**
 * The speech-request queue (#1052), end to end through the REAL server fns.
 *
 * Runs the handlers through the same minimal `createServerFn` adapter
 * `history-import-authz.integration.test.ts` uses, with the cookie -> session
 * lookup faked and nothing else: `requireMembership`, `requireClubAdminView`
 * and `requireClubRole` run for real, so an authorization refusal here is the
 * production refusal.
 *
 * What this pins:
 *  - AC1: only the requester edits or withdraws a request, and the club admin
 *    is not the requester;
 *  - AC2: the VPE schedules a member's request into an open speaker slot, which
 *    copies the request into a Person-owned speech and claims the slot as that
 *    member, atomically;
 *  - a cancelled or completed meeting refuses a requested speech and leaves the
 *    request open.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	speechRequests,
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
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

let sessionUserId: string | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => ({ headers: new Headers() }),
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const fns = await import("./speech-requests");
const { NO_PERMISSION_MESSAGE } = await import("./guards");
const {
	NOT_YOUR_REQUEST_MESSAGE,
	updateSpeechRequest,
	withdrawSpeechRequest,
	REQUEST_NOT_FOUND_MESSAGE,
	REQUEST_NOT_OPEN_MESSAGE,
	REQUEST_SLOT_WRONG_CLUB_MESSAGE,
} = await import("./speech-requests-logic");

type Fn = (input: { data: unknown }) => Promise<unknown>;
// `async` so the validator's synchronous throw reads as a rejection, as it does
// to a client awaiting the fn.
const call = async <T = unknown>(fn: unknown, data: unknown) =>
	(await (fn as Fn)({ data })) as T;

interface RequestRow {
	id: string;
	title: string | null;
	path: string | null;
	projectName: string | null;
	introduction: string | null;
	preferredDates: string[];
	status: string;
	scheduledSlotId: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("speech requests (#1052)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let speakerRoleId: string;
	let otherSpeakerRoleId: string;
	// A second ordinary member of the seeded club, with a sign-in.
	let member2: { userId: string; personId: string; memberId: string };
	const extraUserIds: string[] = [];
	let slotCounter = 0;
	let meetingCounter = 0;

	async function addMember(
		clubId: string,
		name: string,
		status: "active" | "inactive" = "active",
	) {
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name,
			email: `sr-${userId}@test.example`,
			emailVerified: true,
		});
		extraUserIds.push(userId);
		const personId = await seedPerson({ name, userId });
		const [row] = await testDb
			.insert(members)
			.values({ clubId, personId, name, clubRole: "member", status })
			.returning({ id: members.id });
		if (!row) throw new Error("member insert failed");
		return { userId, personId, memberId: row.id };
	}

	async function addMeeting(
		clubId: string,
		status: "scheduled" | "cancelled" | "completed",
		scheduledAt: Date,
	) {
		const [row] = await testDb
			.insert(meetings)
			// A club holds one meeting per instant; the counter keeps two made in the
			// same millisecond apart.
			.values({
				clubId,
				status,
				scheduledAt: new Date(
					scheduledAt.getTime() + ++meetingCounter * 60_000,
				),
			})
			.returning({ id: meetings.id });
		if (!row) throw new Error("meeting insert failed");
		return row.id;
	}

	async function addSpeakerSlot(meetingId: string, roleDefinitionId: string) {
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId,
				slotIndex: ++slotCounter,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		if (!row) throw new Error("slot insert failed");
		return row.id;
	}

	/** An open speaker slot on a fresh upcoming meeting. */
	async function openSlot(
		clubId = seed.clubId,
		roleId = speakerRoleId,
		status: "scheduled" | "cancelled" | "completed" = "scheduled",
	) {
		const meetingId = await addMeeting(
			clubId,
			status,
			new Date(Date.now() + 14 * DAY),
		);
		return addSpeakerSlot(meetingId, roleId);
	}

	async function requestRow(id: string) {
		const [row] = await testDb
			.select()
			.from(speechRequests)
			.where(eq(speechRequests.id, id));
		if (!row) throw new Error("request row missing");
		return row;
	}

	const submit = (fields: Record<string, unknown> = {}, clubId = seed.clubId) =>
		call<RequestRow>(fns.submitSpeechRequest, { clubId, ...fields });

	/** Insert a request straight into the table, bypassing the fns. */
	async function insertRequest(
		memberId: string,
		over: Partial<typeof speechRequests.$inferInsert> = {},
	) {
		const [row] = await testDb
			.insert(speechRequests)
			.values({ clubId: seed.clubId, membershipId: memberId, ...over })
			.returning({ id: speechRequests.id });
		if (!row) throw new Error("request insert failed");
		return row.id;
	}

	async function speechesOf(personId: string) {
		return testDb
			.select()
			.from(speeches)
			.where(eq(speeches.personId, personId));
	}

	beforeEach(async () => {
		slotCounter = 0;
		meetingCounter = 0;
		seed = await seedClub();
		other = await seedClub();
		member2 = await addMember(seed.clubId, "Second Member");
		const [role] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		const [otherRole] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: other.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		if (!role || !otherRole) throw new Error("role insert failed");
		speakerRoleId = role.id;
		otherSpeakerRoleId = otherRole.id;
		sessionUserId = seed.memberUserId;
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		await testDb.delete(user).where(inArray(user.id, extraUserIds));
		extraUserIds.length = 0;
	});

	it("covers every fn the module exports", () => {
		expect(Object.keys(fns).sort()).toEqual(
			[
				"editSpeechRequest",
				"getMySpeechRequests",
				"getSchedulableSpeakerSlots",
				"getSpeechRequestQueue",
				"scheduleRequestedSpeech",
				"submitSpeechRequest",
				"withdrawMySpeechRequest",
			].sort(),
		);
	});

	// -----------------------------------------------------------------------
	describe("creating a request", () => {
		it("stores the dates in the order given and the fields trimmed", async () => {
			const created = await submit({
				title: "  Ice Breaker  ",
				path: "Presentation Mastery",
				projectName: "Ice Breaker",
				introduction: "Hello",
				preferredDates: ["2026-12-10", "2026-12-03", "2026-12-17"],
			});
			const row = await requestRow(created.id);
			expect(row.preferredDates).toEqual([
				"2026-12-10",
				"2026-12-03",
				"2026-12-17",
			]);
			expect(row.title).toBe("Ice Breaker");
			expect(row.path).toBe("Presentation Mastery");
			expect(row.projectName).toBe("Ice Breaker");
			expect(row.introduction).toBe("Hello");
			expect(row.status).toBe("open");
			expect(row.membershipId).toBe(seed.memberId);
			expect(row.clubId).toBe(seed.clubId);
		});

		it("stores a blank field as null, not the empty string", async () => {
			const created = await submit({
				title: "   ",
				path: "",
				introduction: null,
			});
			const row = await requestRow(created.id);
			expect(row.title).toBeNull();
			expect(row.path).toBeNull();
			expect(row.projectName).toBeNull();
			expect(row.introduction).toBeNull();
			expect(row.preferredDates).toEqual([]);
		});

		it("refuses a fourth date, a duplicate and an impossible day, storing nothing", async () => {
			await expect(
				submit({
					preferredDates: [
						"2026-12-01",
						"2026-12-02",
						"2026-12-03",
						"2026-12-04",
					],
				}),
			).rejects.toThrow(/at most 3/);
			await expect(
				submit({ preferredDates: ["2026-12-01", "2026-12-01"] }),
			).rejects.toThrow(/once/);
			await expect(submit({ preferredDates: ["2026-02-31"] })).rejects.toThrow(
				/calendar/,
			);
			const rows = await testDb
				.select()
				.from(speechRequests)
				.where(eq(speechRequests.clubId, seed.clubId));
			expect(rows).toEqual([]);
		});

		it("the table's check constraint refuses a fourth date even past the fn", async () => {
			const error = await insertRequest(seed.memberId, {
				preferredDates: [
					"2026-12-01",
					"2026-12-02",
					"2026-12-03",
					"2026-12-04",
				],
			}).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			const text = `${(error as Error).message} ${String((error as { cause?: unknown }).cause)}`;
			expect(text).toContain("speech_requests_max_three_dates");
		});

		it("is refused for a club the caller does not belong to, storing nothing", async () => {
			sessionUserId = other.memberUserId;
			await expect(submit({ title: "Sneaky" })).rejects.toThrow();
			const rows = await testDb
				.select()
				.from(speechRequests)
				.where(eq(speechRequests.clubId, seed.clubId));
			expect(rows).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	describe("my requests", () => {
		it("lists open and scheduled requests, not withdrawn, with the club's timezone", async () => {
			const open = await submit({ title: "Open one" });
			const gone = await submit({ title: "Gone" });
			await call(fns.withdrawMySpeechRequest, { requestId: gone.id });
			const mine = await call<Array<RequestRow & { timezone: string }>>(
				fns.getMySpeechRequests,
				{ clubId: seed.clubId },
			);
			expect(mine.map((r) => r.id)).toEqual([open.id]);
			expect(mine[0]?.timezone).toBe("America/Chicago");
		});

		it("does not list another member's requests", async () => {
			await insertRequest(member2.memberId, { title: "Theirs" });
			const mine = await call<RequestRow[]>(fns.getMySpeechRequests, {
				clubId: seed.clubId,
			});
			expect(mine).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	describe("editing and withdrawing (AC1)", () => {
		it("the owner can edit their open request", async () => {
			const created = await submit({ title: "Before" });
			const edited = await call<RequestRow>(fns.editSpeechRequest, {
				requestId: created.id,
				title: "After",
				preferredDates: ["2026-12-24"],
			});
			expect(edited.title).toBe("After");
			const row = await requestRow(created.id);
			expect(row.title).toBe("After");
			expect(row.preferredDates).toEqual(["2026-12-24"]);
		});

		it("the owner can withdraw their open request", async () => {
			const created = await submit({ title: "Mine" });
			await call(fns.withdrawMySpeechRequest, { requestId: created.id });
			expect((await requestRow(created.id)).status).toBe("withdrawn");
		});

		it("another member cannot edit or withdraw it; the row is untouched", async () => {
			const id = await insertRequest(seed.memberId, {
				title: "Original",
				preferredDates: ["2026-12-01"],
			});
			sessionUserId = member2.userId;
			await expect(
				call(fns.editSpeechRequest, { requestId: id, title: "Hijacked" }),
			).rejects.toThrow(NOT_YOUR_REQUEST_MESSAGE);
			await expect(
				call(fns.withdrawMySpeechRequest, { requestId: id }),
			).rejects.toThrow(NOT_YOUR_REQUEST_MESSAGE);
			const row = await requestRow(id);
			expect(row.title).toBe("Original");
			expect(row.preferredDates).toEqual(["2026-12-01"]);
			expect(row.status).toBe("open");
		});

		it("the club admin cannot edit or withdraw a member's request either", async () => {
			const id = await insertRequest(seed.memberId, { title: "Original" });
			sessionUserId = seed.adminUserId;
			await expect(
				call(fns.editSpeechRequest, { requestId: id, title: "Admin edit" }),
			).rejects.toThrow(NOT_YOUR_REQUEST_MESSAGE);
			await expect(
				call(fns.withdrawMySpeechRequest, { requestId: id }),
			).rejects.toThrow(NOT_YOUR_REQUEST_MESSAGE);
			const row = await requestRow(id);
			expect(row.title).toBe("Original");
			expect(row.status).toBe("open");
		});

		it("control: the admin CAN edit their own request, so the refusals are about ownership", async () => {
			const id = await insertRequest(seed.adminMemberId, { title: "Admin's" });
			sessionUserId = seed.adminUserId;
			const edited = await call<RequestRow>(fns.editSpeechRequest, {
				requestId: id,
				title: "Admin's, edited",
			});
			expect(edited.title).toBe("Admin's, edited");
		});

		describe("the write's own ownership predicate (a stale ownership read)", () => {
			/**
			 * A connection whose ownership SELECT reads the row as the attacker's, as it
			 * would if a membership merge re-pointed `membership_id` between the check
			 * and the write. The check then passes; only the UPDATE's own
			 * `membership_id` predicate stands between the attacker and the row.
			 */
			function staleReadConn(staleRow: object) {
				return new Proxy(testDb, {
					get(target, prop) {
						if (prop === "select") {
							return () => ({
								from: () => ({
									where: () => ({ limit: async () => [staleRow] }),
								}),
							});
						}
						const value = Reflect.get(target, prop, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				}) as unknown as typeof testDb;
			}

			it("an edit that passed a stale check still cannot write the victim's row", async () => {
				const id = await insertRequest(seed.memberId, { title: "Original" });
				const stale = {
					...(await requestRow(id)),
					membershipId: member2.memberId,
				};
				await expect(
					updateSpeechRequest(staleReadConn(stale), {
						requestId: id,
						actorMembershipId: member2.memberId,
						fields: {
							title: "Hijacked",
							path: null,
							projectName: null,
							introduction: null,
							preferredDates: [],
						},
					}),
				).rejects.toThrow(REQUEST_NOT_OPEN_MESSAGE);
				expect((await requestRow(id)).title).toBe("Original");
			});

			it("a withdraw that passed a stale check still cannot withdraw the victim's row", async () => {
				const id = await insertRequest(seed.memberId, { title: "Original" });
				const stale = {
					...(await requestRow(id)),
					membershipId: member2.memberId,
				};
				await expect(
					withdrawSpeechRequest(staleReadConn(stale), {
						requestId: id,
						actorMembershipId: member2.memberId,
					}),
				).rejects.toThrow(REQUEST_NOT_OPEN_MESSAGE);
				expect((await requestRow(id)).status).toBe("open");
			});
		});

		it("a member of another club is refused and the row is untouched", async () => {
			const id = await insertRequest(seed.memberId, { title: "Original" });
			sessionUserId = other.memberUserId;
			await expect(
				call(fns.editSpeechRequest, { requestId: id, title: "x" }),
			).rejects.toThrow();
			await expect(
				call(fns.withdrawMySpeechRequest, { requestId: id }),
			).rejects.toThrow();
			const row = await requestRow(id);
			expect(row.title).toBe("Original");
			expect(row.status).toBe("open");
		});

		it.each([
			"scheduled",
			"withdrawn",
		] as const)("a %s request can no longer be edited or withdrawn", async (status) => {
			const id = await insertRequest(seed.memberId, { title: "Done", status });
			await expect(
				call(fns.editSpeechRequest, { requestId: id, title: "Late" }),
			).rejects.toThrow(REQUEST_NOT_OPEN_MESSAGE);
			await expect(
				call(fns.withdrawMySpeechRequest, { requestId: id }),
			).rejects.toThrow(REQUEST_NOT_OPEN_MESSAGE);
			const row = await requestRow(id);
			expect(row.title).toBe("Done");
			expect(row.status).toBe(status);
		});

		it("an unknown request id is not found", async () => {
			await expect(
				call(fns.editSpeechRequest, { requestId: randomUUID(), title: "x" }),
			).rejects.toThrow(REQUEST_NOT_FOUND_MESSAGE);
			await expect(
				call(fns.withdrawMySpeechRequest, { requestId: randomUUID() }),
			).rejects.toThrow(REQUEST_NOT_FOUND_MESSAGE);
		});
	});

	// -----------------------------------------------------------------------
	describe("the VPE's queue", () => {
		type QueueRow = { id: string; memberName: string };
		const queue = () =>
			call<QueueRow[]>(fns.getSpeechRequestQueue, { clubId: seed.clubId });

		/** The member spoke in `daysAgo` days on a completed past meeting. */
		async function spokeDaysAgo(memberId: string, daysAgo: number) {
			const meetingId = await addMeeting(
				seed.clubId,
				"completed",
				new Date(Date.now() - daysAgo * DAY),
			);
			const slotId = await addSpeakerSlot(meetingId, speakerRoleId);
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: memberId, status: "claimed" })
				.where(eq(roleSlots.id, slotId));
		}

		it("orders never-spoken first, then longest since last spoke, then the oldest request", async () => {
			const m3 = await addMember(seed.clubId, "Third Member");
			const m4 = await addMember(seed.clubId, "Fourth Member");
			// member2 spoke 200 days ago, seed.memberId 30 days ago, m3 and m4 never.
			await spokeDaysAgo(member2.memberId, 200);
			await spokeDaysAgo(seed.memberId, 30);
			const at = (n: number) => new Date(Date.UTC(2026, 0, n));
			const recentSpeaker = await insertRequest(seed.memberId, {
				createdAt: at(1),
			});
			const longAgoSpeaker = await insertRequest(member2.memberId, {
				createdAt: at(2),
			});
			const neverNewer = await insertRequest(m4.memberId, { createdAt: at(4) });
			const neverOlder = await insertRequest(m3.memberId, { createdAt: at(3) });
			sessionUserId = seed.adminUserId;
			expect((await queue()).map((r) => r.id)).toEqual([
				neverOlder,
				neverNewer,
				longAgoSpeaker,
				recentSpeaker,
			]);
		});

		it("lists only OPEN requests of ACTIVE members", async () => {
			const lapsed = await addMember(seed.clubId, "Lapsed", "inactive");
			const open = await insertRequest(seed.memberId);
			await insertRequest(member2.memberId, { status: "withdrawn" });
			await insertRequest(member2.memberId, { status: "scheduled" });
			await insertRequest(lapsed.memberId);
			sessionUserId = seed.adminUserId;
			expect((await queue()).map((r) => r.id)).toEqual([open]);
		});

		it("does not list a request of another club", async () => {
			const [foreign] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, other.clubId))
				.limit(1);
			await testDb
				.insert(speechRequests)
				.values({ clubId: other.clubId, membershipId: foreign?.id as string });
			sessionUserId = seed.adminUserId;
			expect(await queue()).toEqual([]);
		});

		it("a plain member cannot read the queue or the open slots", async () => {
			await insertRequest(member2.memberId);
			await expect(queue()).rejects.toThrow();
			await expect(
				call(fns.getSchedulableSpeakerSlots, { clubId: seed.clubId }),
			).rejects.toThrow();
		});

		it("the admin sees the open speaker slots, a control for the refusal above", async () => {
			const slotId = await openSlot();
			sessionUserId = seed.adminUserId;
			const slots = await call<Array<{ slotId?: string; id?: string }>>(
				fns.getSchedulableSpeakerSlots,
				{ clubId: seed.clubId },
			);
			expect(JSON.stringify(slots)).toContain(slotId);
		});
	});

	// -----------------------------------------------------------------------
	describe("scheduling a request (AC1, AC2)", () => {
		const schedule = (requestId: string, slotId: string) =>
			call<{ speechId: string; slotId: string }>(fns.scheduleRequestedSpeech, {
				requestId,
				slotId,
			});

		it("copies the request into a speech and claims the slot as the requester", async () => {
			const id = await insertRequest(seed.memberId, {
				title: "My Ice Breaker",
				introduction: "Please welcome...",
				path: "Presentation Mastery",
				projectName: "Ice Breaker",
				preferredDates: ["2026-12-10"],
			});
			const slotId = await openSlot();
			sessionUserId = seed.adminUserId;
			const result = await schedule(id, slotId);

			const [speech] = await speechesOf(seed.personId);
			expect(speech?.id).toBe(result.speechId);
			expect(speech?.title).toBe("My Ice Breaker");
			expect(speech?.introduction).toBe("Please welcome...");
			expect(speech?.pathwayPath).toBe("Presentation Mastery");
			expect(speech?.projectName).toBe("Ice Breaker");

			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.speechId).toBe(result.speechId);
			expect(slot?.status).toBe("claimed");

			const row = await requestRow(id);
			expect(row.status).toBe("scheduled");
			expect(row.scheduledSlotId).toBe(slotId);
		});

		it("an untitled request becomes a TBA speech", async () => {
			const id = await insertRequest(seed.memberId, { title: null });
			const slotId = await openSlot();
			sessionUserId = seed.adminUserId;
			await schedule(id, slotId);
			const [speech] = await speechesOf(seed.personId);
			expect(speech?.title).toBe("TBA");
		});

		it("a plain member cannot schedule, even their own request", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const slotId = await openSlot();
			sessionUserId = seed.memberUserId;
			await expect(schedule(id, slotId)).rejects.toThrow(NO_PERMISSION_MESSAGE);
			expect((await requestRow(id)).status).toBe("open");
			expect(await speechesOf(seed.personId)).toEqual([]);
		});

		it.each([
			"cancelled",
			"completed",
		] as const)("a %s meeting refuses it: request open, slot open, no speech", async (status) => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const slotId = await openSlot(seed.clubId, speakerRoleId, status);
			sessionUserId = seed.adminUserId;
			await expect(schedule(id, slotId)).rejects.toThrow();
			const row = await requestRow(id);
			expect(row.status).toBe("open");
			expect(row.scheduledSlotId).toBeNull();
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
			expect(slot?.speechId).toBeNull();
			expect(await speechesOf(seed.personId)).toEqual([]);
		});

		it("a slot already taken rolls the speech back and leaves the request open", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const slotId = await openSlot();
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: member2.memberId, status: "claimed" })
				.where(eq(roleSlots.id, slotId));
			sessionUserId = seed.adminUserId;
			await expect(schedule(id, slotId)).rejects.toThrow(/already taken/);
			const row = await requestRow(id);
			expect(row.status).toBe("open");
			expect(row.scheduledSlotId).toBeNull();
			expect(await speechesOf(seed.personId)).toEqual([]);
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(slot?.assignedMemberId).toBe(member2.memberId);
		});

		it("refuses another club's slot", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const foreignSlot = await openSlot(other.clubId, otherSpeakerRoleId);
			sessionUserId = seed.adminUserId;
			await expect(schedule(id, foreignSlot)).rejects.toThrow(
				REQUEST_SLOT_WRONG_CLUB_MESSAGE,
			);
			expect((await requestRow(id)).status).toBe("open");
			expect(await speechesOf(seed.personId)).toEqual([]);
		});

		it("another club's admin cannot schedule this club's request", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const slotId = await openSlot();
			sessionUserId = other.adminUserId;
			await expect(schedule(id, slotId)).rejects.toThrow();
			expect((await requestRow(id)).status).toBe("open");
			expect(await speechesOf(seed.personId)).toEqual([]);
		});

		it("a withdrawn request cannot be scheduled", async () => {
			const id = await insertRequest(seed.memberId, { status: "withdrawn" });
			const slotId = await openSlot();
			sessionUserId = seed.adminUserId;
			await expect(schedule(id, slotId)).rejects.toThrow(
				REQUEST_NOT_OPEN_MESSAGE,
			);
			expect(await speechesOf(seed.personId)).toEqual([]);
		});

		it("scheduling an already-scheduled request is refused and makes no second speech", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const first = await openSlot();
			const second = await openSlot();
			sessionUserId = seed.adminUserId;
			await schedule(id, first);
			await expect(schedule(id, second)).rejects.toThrow(
				REQUEST_NOT_OPEN_MESSAGE,
			);
			expect(await speechesOf(seed.personId)).toHaveLength(1);
			expect((await requestRow(id)).scheduledSlotId).toBe(first);
		});

		it("two concurrent schedules of one request: exactly one wins, one speech", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const a = await openSlot();
			const b = await openSlot();
			sessionUserId = seed.adminUserId;
			const results = await Promise.allSettled([
				schedule(id, a),
				schedule(id, b),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const loser = results.find((r) => r.status === "rejected");
			expect((loser as PromiseRejectedResult).reason.message).toBe(
				REQUEST_NOT_OPEN_MESSAGE,
			);
			expect(await speechesOf(seed.personId)).toHaveLength(1);
			const row = await requestRow(id);
			expect(row.status).toBe("scheduled");
			expect([a, b]).toContain(row.scheduledSlotId);
			const claimed = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(
					and(inArray(roleSlots.id, [a, b]), eq(roleSlots.status, "claimed")),
				);
			expect(claimed).toHaveLength(1);
		});

		it("deleting the slot afterwards leaves the request scheduled with no slot", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const slotId = await openSlot();
			sessionUserId = seed.adminUserId;
			await schedule(id, slotId);
			await testDb.delete(roleSlots).where(eq(roleSlots.id, slotId));
			const row = await requestRow(id);
			expect(row.status).toBe("scheduled");
			expect(row.scheduledSlotId).toBeNull();
			sessionUserId = seed.memberUserId;
			const mine = await call<RequestRow[]>(fns.getMySpeechRequests, {
				clubId: seed.clubId,
			});
			expect(mine.map((r) => r.id)).toEqual([id]);
		});
	});
});
