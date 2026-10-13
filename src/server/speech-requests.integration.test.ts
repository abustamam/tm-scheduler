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
	clubs,
	impersonationSessions,
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
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
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
const { releaseSlotCore, reassignSlotCore } = await import("./slots-logic");
const { loadSpeakerRotation } = await import("./reporting-logic");
const { NO_PERMISSION_MESSAGE } = await import("./guards");
const {
	NOT_YOUR_REQUEST_MESSAGE,
	updateSpeechRequest,
	withdrawSpeechRequest,
	REQUEST_NOT_FOUND_MESSAGE,
	REQUEST_MEETING_PAST_MESSAGE,
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

	/**
	 * A request in the state Schedule leaves: `scheduled`, pointing at a slot the
	 * member holds on an upcoming meeting. LIVE, unlike a bare `status:
	 * "scheduled"` row, which has no slot behind it.
	 */
	async function insertLiveScheduledRequest(memberId: string) {
		const slotId = await openSlot();
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: memberId, status: "claimed" })
			.where(eq(roleSlots.id, slotId));
		return insertRequest(memberId, {
			status: "scheduled",
			scheduledSlotId: slotId,
		});
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
			const id =
				status === "scheduled"
					? await insertLiveScheduledRequest(seed.memberId)
					: await insertRequest(seed.memberId, { status });
			await testDb
				.update(speechRequests)
				.set({ title: "Done" })
				.where(eq(speechRequests.id, id));
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
		type QueueRow = {
			id: string;
			memberName: string;
			lastSpokeAt: Date | null;
		};
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

		/**
		 * One speaker slot for the member, `daysFromNow` days away (negative = past),
		 * on a meeting and a slot in the given statuses. Returns the meeting's instant.
		 */
		async function speakerSlot(
			memberId: string,
			daysFromNow: number,
			opts: {
				meetingStatus?: "scheduled" | "cancelled" | "completed";
				slotStatus?: "open" | "claimed" | "confirmed";
			} = {},
		): Promise<Date> {
			const meetingId = await addMeeting(
				seed.clubId,
				opts.meetingStatus ?? "completed",
				new Date(Date.now() + daysFromNow * DAY),
			);
			const slotId = await addSpeakerSlot(meetingId, speakerRoleId);
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: memberId,
					status: opts.slotStatus ?? "claimed",
				})
				.where(eq(roleSlots.id, slotId));
			const [m] = await testDb
				.select({ at: meetings.scheduledAt })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			if (!m) throw new Error("meeting missing");
			return m.at;
		}

		describe("last spoke ignores what is not a past, held, non-cancelled speaker slot", () => {
			const lastSpoke = async (memberId: string) => {
				sessionUserId = seed.adminUserId;
				const row = (await queue()).find(
					(r) => r.id === requestIds.get(memberId),
				);
				return row?.lastSpokeAt ?? null;
			};
			const requestIds = new Map<string, string>();
			beforeEach(async () => {
				requestIds.clear();
				requestIds.set(seed.memberId, await insertRequest(seed.memberId));
			});

			it("control: a past held slot on a completed meeting is the last spoke", async () => {
				const at = await speakerSlot(seed.memberId, -30);
				expect(await lastSpoke(seed.memberId)).toEqual(at);
			});

			it("a FUTURE held slot is not a speech yet", async () => {
				const older = await speakerSlot(seed.memberId, -100);
				await speakerSlot(seed.memberId, 20, { meetingStatus: "scheduled" });
				expect(await lastSpoke(seed.memberId)).toEqual(older);
			});

			it("a future held slot alone leaves the member never-spoken", async () => {
				await speakerSlot(seed.memberId, 20, { meetingStatus: "scheduled" });
				expect(await lastSpoke(seed.memberId)).toBeNull();
			});

			it("a CANCELLED meeting's held slot never happened", async () => {
				const older = await speakerSlot(seed.memberId, -100);
				await speakerSlot(seed.memberId, -10, { meetingStatus: "cancelled" });
				expect(await lastSpoke(seed.memberId)).toEqual(older);
			});

			it("a past slot that is merely open (not held) is not a speech", async () => {
				const older = await speakerSlot(seed.memberId, -100);
				await speakerSlot(seed.memberId, -10, { slotStatus: "open" });
				expect(await lastSpoke(seed.memberId)).toEqual(older);
			});

			it("a confirmed slot counts, like a claimed one", async () => {
				const at = await speakerSlot(seed.memberId, -10, {
					slotStatus: "confirmed",
				});
				expect(await lastSpoke(seed.memberId)).toEqual(at);
			});

			it("a past held slot in a NON-speaker role is not a speech", async () => {
				const [timer] = await testDb
					.insert(roleDefinitions)
					.values({
						clubId: seed.clubId,
						name: "Timer",
						category: "functionary",
						isSpeakerRole: false,
					})
					.returning({ id: roleDefinitions.id });
				if (!timer) throw new Error("role insert failed");
				const meetingId = await addMeeting(
					seed.clubId,
					"completed",
					new Date(Date.now() - 10 * DAY),
				);
				const slotId = await addSpeakerSlot(meetingId, timer.id);
				await testDb
					.update(roleSlots)
					.set({ assignedMemberId: seed.memberId, status: "claimed" })
					.where(eq(roleSlots.id, slotId));
				expect(await lastSpoke(seed.memberId)).toBeNull();
			});

			it("agrees with the speaker rotation, member by member, on one mixed fixture", async () => {
				const m3 = await addMember(seed.clubId, "Third Member");
				// seed.memberId: a valid old spoke plus every kind of decoy.
				const mine = await speakerSlot(seed.memberId, -100);
				await speakerSlot(seed.memberId, 20, { meetingStatus: "scheduled" });
				await speakerSlot(seed.memberId, -10, { meetingStatus: "cancelled" });
				await speakerSlot(seed.memberId, -5, { slotStatus: "open" });
				// member2: one valid spoke, newer.
				const theirs = await speakerSlot(member2.memberId, -20);
				// m3: only decoys, so never-spoken on both sides.
				await speakerSlot(m3.memberId, -3, { meetingStatus: "cancelled" });
				requestIds.set(member2.memberId, await insertRequest(member2.memberId));
				requestIds.set(m3.memberId, await insertRequest(m3.memberId));

				const rotation = new Map(
					(await loadSpeakerRotation(seed.clubId)).map((r) => [
						r.memberId,
						r.lastSpokenAt,
					]),
				);
				for (const [memberId, expected] of [
					[seed.memberId, mine],
					[member2.memberId, theirs],
					[m3.memberId, null],
				] as const) {
					expect(rotation.get(memberId) ?? null).toEqual(expected);
					expect(await lastSpoke(memberId)).toEqual(rotation.get(memberId));
				}
			});
		});

		it("lists only OPEN requests of ACTIVE members", async () => {
			const lapsed = await addMember(seed.clubId, "Lapsed", "inactive");
			const open = await insertRequest(seed.memberId);
			await insertRequest(member2.memberId, { status: "withdrawn" });
			await insertLiveScheduledRequest(member2.memberId);
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

	// -----------------------------------------------------------------------
	describe("/me under an impersonation session (#1052)", () => {
		let superadminId: string;
		const GRANT = () => new Date(Date.now() + 60 * 60 * 1000);

		beforeEach(async () => {
			superadminId = randomUUID();
			await testDb.insert(user).values({
				id: superadminId,
				name: "Super",
				email: `super-${superadminId}@test.example`,
				emailVerified: true,
				isSuperadmin: true,
			});
			extraUserIds.push(superadminId);
			await insertRequest(seed.memberId, { title: "Mine" });
		});

		const mine = (clubId = seed.clubId) =>
			call<RequestRow[]>(fns.getMySpeechRequests, { clubId });

		it.each([
			["read_only", null],
			["read_write", "Looking into a support request"],
		] as const)("a %s session on the club lists nothing instead of refusing, so /me still loads", async (mode, reason) => {
			await testDb.insert(impersonationSessions).values({
				superadminUserId: superadminId,
				clubId: seed.clubId,
				mode,
				reason,
				expiresAt: GRANT(),
			});
			sessionUserId = superadminId;
			await expect(mine()).resolves.toEqual([]);
		});

		it("a real member still gets their own requests (the control)", async () => {
			const rows = await mine();
			expect(rows.map((r) => r.title)).toEqual(["Mine"]);
		});

		// /me loads this beside the commitments in one Promise.all: a refusal here
		// takes the whole page down. The fn lists the caller's OWN rows, so anyone
		// who owns none in the club reads [] and learns nothing about it.
		it("a user with no membership in the club lists nothing, and sees none of its rows", async () => {
			await insertRequest(other.memberId, {
				clubId: other.clubId,
				title: "Theirs",
			});
			sessionUserId = other.memberUserId;
			await expect(mine(seed.clubId)).resolves.toEqual([]);
			// The control: asked for their own club they get their own row, so the
			// empty answer above is about the club asked for.
			expect((await mine(other.clubId)).map((r) => r.title)).toEqual([
				"Theirs",
			]);
		});

		it("a LAPSED member lists nothing instead of refusing", async () => {
			const lapsed = await addMember(seed.clubId, "Lapsed", "inactive");
			await insertRequest(lapsed.memberId, { title: "Old ask" });
			sessionUserId = lapsed.userId;
			await expect(mine()).resolves.toEqual([]);
			// The same person, active again, reads it: the empty answer is the status.
			await testDb
				.update(members)
				.set({ status: "active" })
				.where(eq(members.id, lapsed.memberId));
			expect((await mine()).map((r) => r.title)).toEqual(["Old ask"]);
		});

		it("an ARCHIVED club lists nothing instead of refusing (as loadMyCommitments leaves an archived club out)", async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			await expect(mine()).resolves.toEqual([]);
		});

		it("a session on ANOTHER club does not open this one: it lists nothing", async () => {
			await testDb.insert(impersonationSessions).values({
				superadminUserId: superadminId,
				clubId: other.clubId,
				mode: "read_only",
				expiresAt: GRANT(),
			});
			sessionUserId = superadminId;
			await expect(mine()).resolves.toEqual([]);
		});

		it("is still refused with no session at all", async () => {
			sessionUserId = null;
			await expect(mine()).rejects.toThrow(/signed in/i);
		});
	});

	// -----------------------------------------------------------------------
	describe("a scheduled request is live only while its slot is held (#1052)", () => {
		type QueueRow = { id: string };
		type MineRow = RequestRow & {
			backInQueue: boolean;
			scheduledFor: Date | null;
		};
		const schedule = (requestId: string, slotId: string) =>
			call<{ speechId: string; slotId: string }>(fns.scheduleRequestedSpeech, {
				requestId,
				slotId,
			});
		const queueIds = async () => {
			sessionUserId = seed.adminUserId;
			const rows = await call<QueueRow[]>(fns.getSpeechRequestQueue, {
				clubId: seed.clubId,
			});
			sessionUserId = seed.memberUserId;
			return rows.map((r) => r.id);
		};
		const mine = () =>
			call<MineRow[]>(fns.getMySpeechRequests, { clubId: seed.clubId });

		/** A request scheduled into a fresh slot by the admin; the session ends as the member. */
		async function scheduled() {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const slotId = await openSlot();
			// The member also holds ANOTHER speaker slot, as a member with a busy
			// term does: "the slot is gone" must be about THE request's slot, not
			// about the member holding nothing.
			const heldElsewhere = await openSlot();
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, status: "claimed" })
				.where(eq(roleSlots.id, heldElsewhere));
			sessionUserId = seed.adminUserId;
			await schedule(id, slotId);
			sessionUserId = seed.memberUserId;
			return { id, slotId };
		}

		const causes: Array<[string, (slotId: string) => Promise<void>]> = [
			[
				"the slot is released",
				async (slotId) => {
					await releaseSlotCore(testDb, {
						slotId,
						actorMemberId: seed.adminMemberId,
						proof: "session",
					});
				},
			],
			[
				"the slot is reassigned to another member",
				async (slotId) => {
					await reassignSlotCore(testDb, {
						slotId,
						memberId: member2.memberId,
						actorMemberId: seed.adminMemberId,
						proof: "session",
					});
				},
			],
			[
				"the slot is deleted",
				async (slotId) => {
					await testDb.delete(roleSlots).where(eq(roleSlots.id, slotId));
				},
			],
			[
				"the meeting is cancelled",
				async (slotId) => {
					const [slot] = await testDb
						.select({ meetingId: roleSlots.meetingId })
						.from(roleSlots)
						.where(eq(roleSlots.id, slotId));
					await testDb
						.update(meetings)
						.set({ status: "cancelled" })
						.where(eq(meetings.id, slot?.meetingId as string));
				},
			],
		];

		it("a LIVE one is not in the queue and can be neither edited nor withdrawn (the control)", async () => {
			const { id, slotId } = await scheduled();
			expect(await queueIds()).not.toContain(id);
			const [row] = await mine();
			expect(row).toMatchObject({
				id,
				status: "scheduled",
				scheduledSlotId: slotId,
				backInQueue: false,
			});
			expect(row?.scheduledFor).toBeInstanceOf(Date);
			await expect(
				call(fns.editSpeechRequest, { requestId: id, title: "x" }),
			).rejects.toThrow(REQUEST_NOT_OPEN_MESSAGE);
			await expect(
				call(fns.withdrawMySpeechRequest, { requestId: id }),
			).rejects.toThrow(REQUEST_NOT_OPEN_MESSAGE);
			expect((await requestRow(id)).status).toBe("scheduled");
		});

		it.each(
			causes,
		)("when %s the request is back in the VPE's queue and on /me as open", async (_label, cause) => {
			const { id, slotId } = await scheduled();
			await cause(slotId);
			expect(await queueIds()).toContain(id);
			const [row] = await mine();
			expect(row).toMatchObject({
				id,
				status: "open",
				scheduledSlotId: null,
				scheduledFor: null,
				backInQueue: true,
			});
		});

		it.each(
			causes,
		)("when %s the member can withdraw it", async (_label, cause) => {
			const { id, slotId } = await scheduled();
			await cause(slotId);
			await call(fns.withdrawMySpeechRequest, { requestId: id });
			expect((await requestRow(id)).status).toBe("withdrawn");
			expect(await queueIds()).not.toContain(id);
			expect(await mine()).toEqual([]);
		});

		it.each(
			causes,
		)("when %s the member can edit it, and it is an ordinary open request again", async (_label, cause) => {
			const { id, slotId } = await scheduled();
			await cause(slotId);
			await call(fns.editSpeechRequest, { requestId: id, title: "Reworded" });
			const row = await requestRow(id);
			expect(row).toMatchObject({
				title: "Reworded",
				status: "open",
				scheduledSlotId: null,
			});
			const [listed] = await mine();
			expect(listed).toMatchObject({ id, status: "open", backInQueue: false });
		});

		it.each(
			causes,
		)("when %s the VPE can schedule it again into a new slot", async (_label, cause) => {
			const { id, slotId } = await scheduled();
			await cause(slotId);
			const fresh = await openSlot();
			sessionUserId = seed.adminUserId;
			await schedule(id, fresh);
			const row = await requestRow(id);
			expect(row).toMatchObject({
				status: "scheduled",
				scheduledSlotId: fresh,
			});
			sessionUserId = seed.memberUserId;
			const [listed] = await mine();
			expect(listed).toMatchObject({
				id,
				status: "scheduled",
				backInQueue: false,
			});
		});

		it("a released slot can take the same request again (it is live the moment it is refilled)", async () => {
			const { id, slotId } = await scheduled();
			await causes[0]?.[1](slotId);
			sessionUserId = seed.adminUserId;
			await schedule(id, slotId);
			expect(await requestRow(id)).toMatchObject({
				status: "scheduled",
				scheduledSlotId: slotId,
			});
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(slot?.assignedMemberId).toBe(seed.memberId);
		});

		it("a slot that still names the member but is no longer held is not live", async () => {
			const { id, slotId } = await scheduled();
			await testDb
				.update(roleSlots)
				.set({ status: "open" })
				.where(eq(roleSlots.id, slotId));
			expect(await queueIds()).toContain(id);
			const [row] = await mine();
			expect(row).toMatchObject({ id, status: "open", backInQueue: true });
		});

		it("a LIVE request is refused a second Schedule", async () => {
			const { id } = await scheduled();
			const other2 = await openSlot();
			sessionUserId = seed.adminUserId;
			await expect(schedule(id, other2)).rejects.toThrow(
				REQUEST_NOT_OPEN_MESSAGE,
			);
		});

		// -------------------------------------------------------------------
		// A write that WAITED on the request row decides on a fresh snapshot.
		// -------------------------------------------------------------------
		it.each([
			"edit",
			"withdraw",
		] as const)("an %s that waited on the request lock re-reads liveness AFTER it: the re-schedule's new slot is seen, the write refused, the request stays live", async (kind) => {
			const { id, slotId } = await scheduled();
			await causes[0]?.[1](slotId); // released: scheduled but not live
			const fresh = await openSlot();
			// A re-Schedule that has filled a new slot and not yet committed, holding the row.
			const rescheduler = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: speechRequests.id })
					.from(speechRequests)
					.where(eq(speechRequests.id, id))
					.for("update");
				await tx
					.update(roleSlots)
					.set({ assignedMemberId: seed.memberId, status: "claimed" })
					.where(eq(roleSlots.id, fresh));
				await tx
					.update(speechRequests)
					.set({ status: "scheduled", scheduledSlotId: fresh })
					.where(eq(speechRequests.id, id));
			});
			const attempt =
				kind === "edit"
					? () =>
							call(fns.editSpeechRequest, { requestId: id, title: "Reworded" })
					: () => call(fns.withdrawMySpeechRequest, { requestId: id });
			let outcome: Promise<string | null> | undefined;
			try {
				outcome = attempt().then(
					() => null,
					(e: unknown) => (e instanceof Error ? e.message : String(e)),
				);
				// Parked on the row, BEHIND the re-Schedule. Matches both the
				// locking select and, were there none, the UPDATE itself.
				await waitForLockWait("speech_requests", rescheduler.pid);
			} finally {
				await rescheduler.commit();
			}
			expect(await outcome).toBe(REQUEST_NOT_OPEN_MESSAGE);
			expect(await requestRow(id)).toMatchObject({
				title: "Mine",
				status: "scheduled",
				scheduledSlotId: fresh,
			});
			const [held] = await testDb
				.select({ assigned: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, fresh));
			expect(held?.assigned).toBe(seed.memberId);
		});

		// -------------------------------------------------------------------
		// One ask is one speech: a re-Schedule reuses the speech the first made.
		// -------------------------------------------------------------------
		it("Schedule records the speech it made on the request", async () => {
			const { id } = await scheduled();
			const [speech] = await speechesOf(seed.personId);
			expect((await requestRow(id)).speechId).toBe(speech?.id);
		});

		it.each([causes[0], causes[1], causes[2]] as Array<
			[string, (slotId: string) => Promise<void>]
		>)("when %s, scheduling again REUSES the same speech, updated from the request: one speech, not two", async (_label, cause) => {
			const { id, slotId } = await scheduled();
			const [first] = await speechesOf(seed.personId);
			await cause(slotId);
			await call(fns.editSpeechRequest, {
				requestId: id,
				title: "Reworded",
				path: "Presentation Mastery",
			});
			const fresh = await openSlot();
			sessionUserId = seed.adminUserId;
			const result = await schedule(id, fresh);
			expect(result.speechId).toBe(first?.id);
			const all = await speechesOf(seed.personId);
			expect(all.map((sp) => sp.id)).toEqual([first?.id]);
			expect(all[0]).toMatchObject({
				title: "Reworded",
				pathwayPath: "Presentation Mastery",
			});
			expect(await requestRow(id)).toMatchObject({
				speechId: first?.id,
				scheduledSlotId: fresh,
			});
			const [slot] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, fresh));
			expect(slot?.speechId).toBe(first?.id);
		});

		it("when the meeting is cancelled the speech stays on its slot as history, so scheduling again makes a NEW speech", async () => {
			const { id, slotId } = await scheduled();
			const [first] = await speechesOf(seed.personId);
			await causes[3]?.[1](slotId);
			const fresh = await openSlot();
			sessionUserId = seed.adminUserId;
			const result = await schedule(id, fresh);
			expect(result.speechId).not.toBe(first?.id);
			expect(await speechesOf(seed.personId)).toHaveLength(2);
			expect(await requestRow(id)).toMatchObject({ speechId: result.speechId });
			const [old] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(old?.speechId).toBe(first?.id);
		});

		it("a speech that is not the requester's own is never reused or rewritten, whatever the link says", async () => {
			const [theirs] = await testDb
				.insert(speeches)
				.values({ personId: member2.personId, title: "Not yours" })
				.returning({ id: speeches.id });
			const id = await insertRequest(seed.memberId, {
				title: "Mine",
				speechId: theirs?.id,
			});
			const slotId = await openSlot();
			sessionUserId = seed.adminUserId;
			const result = await schedule(id, slotId);
			expect(result.speechId).not.toBe(theirs?.id);
			const [untouched] = await speechesOf(member2.personId);
			expect(untouched).toMatchObject({ id: theirs?.id, title: "Not yours" });
			expect(await speechesOf(seed.personId)).toHaveLength(1);
		});

		it("a speech that was deleted is not reused: the request lost the link, and a new one is made", async () => {
			const { id, slotId } = await scheduled();
			const [first] = await speechesOf(seed.personId);
			await causes[0]?.[1](slotId);
			await testDb.delete(speeches).where(eq(speeches.id, first?.id as string));
			expect((await requestRow(id)).speechId).toBeNull();
			const fresh = await openSlot();
			sessionUserId = seed.adminUserId;
			const result = await schedule(id, fresh);
			expect(result.speechId).not.toBe(first?.id);
			expect(await speechesOf(seed.personId)).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	describe("Schedule and the meeting's own state (#1052)", () => {
		const schedule = (requestId: string, slotId: string) =>
			call<{ speechId: string; slotId: string }>(fns.scheduleRequestedSpeech, {
				requestId,
				slotId,
			});

		async function expectNothingWritten(id: string, slotId: string) {
			expect((await requestRow(id)).status).toBe("open");
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
			expect(await speechesOf(seed.personId)).toEqual([]);
		}

		it("refuses a meeting whose time has passed even while its status still reads scheduled", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const meetingId = await addMeeting(
				seed.clubId,
				"scheduled",
				new Date(Date.now() - 2 * DAY),
			);
			const slotId = await addSpeakerSlot(meetingId, speakerRoleId);
			sessionUserId = seed.adminUserId;
			await expect(schedule(id, slotId)).rejects.toThrow(
				REQUEST_MEETING_PAST_MESSAGE,
			);
			await expectNothingWritten(id, slotId);
		});

		it("takes the meeting lock before it reads the status: a cancel in flight is waited for, then refused", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const meetingId = await addMeeting(
				seed.clubId,
				"scheduled",
				new Date(Date.now() + 14 * DAY),
			);
			const slotId = await addSpeakerSlot(meetingId, speakerRoleId);
			sessionUserId = seed.adminUserId;
			// A cancel that has written but not committed, holding the meeting row.
			const cancel = await openBlockingTx(async (tx) => {
				await tx
					.update(meetings)
					.set({ status: "cancelled" })
					.where(eq(meetings.id, meetingId));
			});
			let outcome: Promise<string | null> | undefined;
			try {
				outcome = schedule(id, slotId).then(
					() => null,
					(e: unknown) => (e instanceof Error ? e.message : String(e)),
				);
				// Schedule is parked on the meeting row, BEHIND the cancel.
				await waitForLockWait("for no key update", cancel.pid);
			} finally {
				await cancel.commit();
			}
			expect(await outcome).toMatch(/cancelled/i);
			await expectNothingWritten(id, slotId);
		});

		it("a Schedule that waited on the request lock re-reads liveness AFTER it: the winner's slot is seen, the loser refused, one speech", async () => {
			const id = await insertRequest(seed.memberId, { title: "Mine" });
			const first = await openSlot();
			const second = await openSlot();
			sessionUserId = seed.adminUserId;
			// The winning Schedule, written and not yet committed, holding the row.
			const winner = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: speechRequests.id })
					.from(speechRequests)
					.where(eq(speechRequests.id, id))
					.for("update");
				await tx
					.update(roleSlots)
					.set({ assignedMemberId: seed.memberId, status: "claimed" })
					.where(eq(roleSlots.id, first));
				await tx
					.update(speechRequests)
					.set({ status: "scheduled", scheduledSlotId: first })
					.where(eq(speechRequests.id, id));
			});
			let outcome: Promise<string | null> | undefined;
			try {
				outcome = schedule(id, second).then(
					() => null,
					(e: unknown) => (e instanceof Error ? e.message : String(e)),
				);
				// Parked on the request's `for update`, BEHIND the winner.
				await waitForLockWait("for update", winner.pid);
			} finally {
				await winner.commit();
			}
			expect(await outcome).toBe(REQUEST_NOT_OPEN_MESSAGE);
			expect(await speechesOf(seed.personId)).toHaveLength(0);
			expect((await requestRow(id)).scheduledSlotId).toBe(first);
			const [loserSlot] = await testDb
				.select({ status: roleSlots.status })
				.from(roleSlots)
				.where(eq(roleSlots.id, second));
			expect(loserSlot?.status).toBe("open");
		});
	});
});
