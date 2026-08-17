/**
 * DB-backed tests for the meeting_attendance_plan store.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-logic.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, meetingAttendancePlan, members } from "#/db/schema";
import {
	clearPlanStatus,
	getPlanStatus,
	listNotComingForMeetings,
	listNotComingWithNames,
	listPlanForMeetings,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "#/server/attendance-plan-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

describe.skipIf(!hasTestDb)("meeting_attendance_plan table", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("stores each of the three statuses", async () => {
		for (const status of ["reached_out", "coming", "not_coming"] as const) {
			await testDb
				.insert(meetingAttendancePlan)
				.values({
					memberId: club.memberId,
					meetingId: club.meetingId,
					status,
				})
				.onConflictDoUpdate({
					target: [
						meetingAttendancePlan.memberId,
						meetingAttendancePlan.meetingId,
					],
					set: { status },
				});
			const [row] = await testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, club.memberId),
						eq(meetingAttendancePlan.meetingId, club.meetingId),
					),
				);
			expect(row?.status).toBe(status);
		}
	});

	it("allows at most one row per (member, meeting)", async () => {
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "coming",
		});
		// Assert the Postgres unique-violation specifically (SQLSTATE 23505), not
		// merely "threw something" — a renamed column or an unrelated constraint
		// would also satisfy a bare `.rejects.toThrow()`. Drizzle wraps the raw pg
		// error in a `DrizzleQueryError` whose own `.message` is just
		// "Failed query: insert into ..."; the SQLSTATE and the
		// "duplicate key value violates unique constraint" text live on `.cause`,
		// the underlying `pg` error — verified against the real error shape here,
		// not guessed.
		await expect(
			testDb.insert(meetingAttendancePlan).values({
				memberId: club.memberId,
				meetingId: club.meetingId,
				status: "not_coming",
			}),
		).rejects.toMatchObject({
			cause: { code: "23505" },
		});
	});
});

describe.skipIf(!hasTestDb)("attendance-plan seam", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("upserts rather than duplicating on a second write", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "reached_out",
			actorMemberId: club.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, club.memberId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("coming");
	});

	it("clearing removes the row entirely, not sets a status", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, club.memberId));
		expect(rows).toHaveLength(0);
	});

	it("logs plan_set with the status in the detail, attributed to the acting officer", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
			via: "manual",
		});
		const [entry] = await testDb
			.select({
				action: activityLog.action,
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.action).toBe("plan_set");
		// Actor = the officer who acted; subject (detail.memberId) = the member
		// whose plan changed. These must NOT collapse to the same thing — a
		// regression that hardcoded or dropped actorMemberId would still pass an
		// assertion that only looks at detail.
		expect(entry?.actorMemberId).toBe(club.adminMemberId);
		expect(entry?.detail).toMatchObject({
			memberId: club.memberId,
			status: "coming",
			via: "manual",
		});
	});

	it("records WHICH authorization arm admitted the write", async () => {
		// #576: the TMOD arm is honour-system — a self-asserted member id, verified
		// against the meeting's slot but not proved. The defence for granting it is
		// that the write is auditable afterwards, which is only true if the ARM is
		// persisted: without `grantedVia` an unverified Toastmaster write and a
		// session-authenticated officer's are byte-identical in the feed.
		//
		// Asserted here rather than through a source guard because `setPlanStatus`
		// is a plain exported function — the arm is decided in `resolveActor`
		// (unreachable from vitest), but whether the seam PERSISTS what it is told
		// is executable, and that is the half that can silently drop a field.
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "reached_out",
			actorMemberId: club.adminMemberId,
			via: "nudge",
			grantedVia: "tmod",
		});
		const [entry] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.detail).toMatchObject({ via: "nudge", grantedVia: "tmod" });
	});

	it("omits grantedVia entirely when the caller does not supply one", async () => {
		// The field is optional so the pre-#576 callers (`setAvailability`, the
		// self-claim path) need no change. Writing `grantedVia: undefined` into the
		// JSON would be worse than omitting it: a reader filtering the feed for
		// unverified writes would see the key present and have to special-case null.
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		const [entry] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.detail).not.toHaveProperty("grantedVia");
	});

	it("logs a clear as plan_set with a null status, attributed to the acting officer", async () => {
		// Seed the row this clear removes. Clearing nothing logs nothing now (see
		// the case below), so a fixture with no row would assert the absence of a
		// feed entry while looking like it asserts its content.
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: club.memberId,
		});
		await testDb.delete(activityLog).where(eq(activityLog.clubId, club.clubId));

		await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const [entry] = await testDb
			.select({
				action: activityLog.action,
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.action).toBe("plan_set");
		expect(entry?.actorMemberId).toBe(club.adminMemberId);
		expect(entry?.detail).toMatchObject({ status: null });
	});

	it("clearing a row that was never there logs nothing", async () => {
		// "Idempotent" used to mean the DELETE matched nothing but the feed got a
		// row anyway, so the activity log accumulated clears for answers nobody
		// ever gave. The delete is still idempotent; the LOG now follows the row.
		const res = await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(res.cleared).toBe(false);
		const entries = await testDb
			.select({ id: activityLog.id })
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entries).toEqual([]);
	});

	it("logs a null actor as null, not the subject — the impersonation path", async () => {
		// actorMemberId: null is a decision, not an omission (see setPlanStatus's
		// jsdoc): it's what an impersonated write resolves to before `logActivity`
		// stamps the real superadmin via the request-scoped marker. Outside a
		// request context (as in this test) that marker is unset, so the row
		// should land with actor_member_id NULL rather than silently falling back
		// to the subject member.
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: null,
		});
		const [entry] = await testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.actorMemberId).toBe(null);
		expect(entry?.detail).toMatchObject({ memberId: club.memberId });
	});

	it("getPlanStatus returns null for no answer and the rung once set", async () => {
		expect(
			await getPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
			}),
		).toBe(null);
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: club.adminMemberId,
		});
		expect(
			await getPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
			}),
		).toBe("not_coming");
	});

	it("getPlanStatus reads its own transaction's uncommitted write", async () => {
		// It takes a DbOrTx for exactly this: `markComingOnSelfClaim` calls it
		// inside the claim's transaction, and a read through the pool client there
		// would see the world as it was before the claim.
		await testDb.transaction(async (tx) => {
			await setPlanStatus(tx, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "coming",
				actorMemberId: club.memberId,
			});
			expect(
				await getPlanStatus(tx, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe("coming");
		});
	});

	it("listNotComingForMeetings returns ONLY not_coming rows", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: club.adminMemberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: club.adminMemberId,
		});
		const out = await listNotComingForMeetings(testDb, [club.meetingId]);
		expect(out).toEqual([
			{ memberId: club.adminMemberId, meetingId: club.meetingId },
		]);
	});

	// The positive call FIRST is not decoration. This asserts a NEGATIVE — that a
	// query did not happen — and a spy that stopped intercepting anything reports
	// zero calls in both directions, so the guard could be deleted with the test
	// still green. Proving the spy can still see this loader is what makes the
	// `not.toHaveBeenCalled()` below able to fail. CLAUDE.md states the rule as
	// "assert the list is non-empty before trusting a count".
	it("listNotComingForMeetings skips the round-trip on an empty id list", async () => {
		const spy = vi.spyOn(testDb, "select");
		await listNotComingForMeetings(testDb, [club.meetingId]);
		expect(
			spy,
			"control: the spy no longer observes this loader, so the assertion " +
				"below cannot fail and this test proves nothing",
		).toHaveBeenCalled();
		spy.mockClear();

		const out = await listNotComingForMeetings(testDb, []);
		expect(out).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	// Same shape, same reason: Drizzle compiles an empty `inArray` to `false`, so
	// asserting the RESULT passes whether the guard runs or not. The observable
	// the guard controls is the round-trip, so that is what gets asserted. The
	// season grid calls this one unconditionally now — the `meetingIds.length`
	// check that used to sit at the call site lives here instead.
	it("listPlanForMeetings skips the round-trip on an empty id list", async () => {
		const spy = vi.spyOn(testDb, "select");
		await listPlanForMeetings(testDb, [club.meetingId]);
		expect(
			spy,
			"control: the spy no longer observes this loader, so the assertion " +
				"below cannot fail and this test proves nothing",
		).toHaveBeenCalled();
		spy.mockClear();

		const out = await listPlanForMeetings(testDb, []);
		expect(out).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("listNotComingWithNames returns only not_coming, ordered by name", async () => {
		// Names chosen so alphabetical order is the OPPOSITE of insertion order —
		// otherwise dropping the ORDER BY leaves this green. A `coming` member sits
		// in the same fixture so the status filter and the ordering are pinned by
		// one case; asserting against a single-member fixture could not see either.
		await testDb
			.update(members)
			.set({ name: "Zoe Zander" })
			.where(eq(members.id, club.memberId));
		await testDb
			.update(members)
			.set({ name: "Aaron Abbott" })
			.where(eq(members.id, club.adminMemberId));
		for (const [memberId, status] of [
			[club.memberId, "not_coming"],
			[club.adminMemberId, "not_coming"],
		] as const) {
			await setPlanStatus(testDb, {
				memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status,
				actorMemberId: memberId,
			});
		}
		const out = await listNotComingWithNames(testDb, club.meetingId);
		expect(out.map((r) => r.name)).toEqual(["Aaron Abbott", "Zoe Zander"]);

		// Flip the alphabetically-first member to `coming` and they must drop out —
		// a row is no longer proof of absence.
		await setPlanStatus(testDb, {
			memberId: club.adminMemberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		const after = await listNotComingWithNames(testDb, club.meetingId);
		expect(after.map((r) => r.name)).toEqual(["Zoe Zander"]);
	});

	describe("status predicates", () => {
		// The consolidation put an officer's "I asked them" in the same row as the
		// member's own answer. These are the two predicates that keep one from
		// silently destroying the other, and each is asserted from BOTH sides —
		// blocked when it should be, allowed when it should be — because a
		// predicate that blocks everything would pass a one-sided test.

		it("demoteFrom refuses to overwrite a rung outside the list, and logs nothing", async () => {
			await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "not_coming",
				actorMemberId: club.memberId,
			});
			const before = await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId));

			// What `setContacted` does: tick "contacted" on someone who has already
			// declined. The decline must survive.
			const res = await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "reached_out",
				actorMemberId: club.adminMemberId,
				demoteFrom: ["reached_out"],
			});
			expect(res.changed).toBe(false);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe("not_coming");

			// A refused write must not leave a `plan_set` row claiming it happened.
			const after = await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId));
			expect(after.length).toBe(before.length);
		});

		it("demoteFrom still allows the transitions it names", async () => {
			await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "reached_out",
				actorMemberId: club.adminMemberId,
			});
			// `markComingOnSelfClaim`'s list: a claim supersedes an officer's ask.
			const res = await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "coming",
				actorMemberId: club.memberId,
				demoteFrom: ["reached_out", "not_coming"],
			});
			expect(res.changed).toBe(true);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe("coming");

			// And the same call is now a no-op, which is the claim de-dup: a member
			// taking three roles must not file three "said they're coming" rows.
			const again = await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "coming",
				actorMemberId: club.memberId,
				demoteFrom: ["reached_out", "not_coming"],
			});
			expect(again.changed).toBe(false);
		});

		it("an unrestricted write still moves any rung — the ladder must not be blocked", async () => {
			await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "reached_out",
				actorMemberId: club.adminMemberId,
			});
			// `setAvailability` passes no `demoteFrom` on purpose: the officer asked,
			// the member answered. Restricting this would DISCARD the answer, which
			// is a worse loss than the "we asked them" bit it would preserve.
			const res = await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "not_coming",
				actorMemberId: club.memberId,
			});
			expect(res.changed).toBe(true);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe("not_coming");
		});

		it("onlyFrom refuses to delete a rung outside the list", async () => {
			await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "reached_out",
				actorMemberId: club.adminMemberId,
			});
			// THE regression this closes: before the consolidation, deleting the
			// officer's outreach row took `requireUser()` + `requireClubRole(admin)`.
			// The session-less callers pass SELF_SERVICE_RUNGS so they cannot.
			const res = await clearPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				actorMemberId: club.memberId,
				onlyFrom: SELF_SERVICE_RUNGS,
			});
			expect(res.cleared).toBe(false);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe("reached_out");
		});

		it("onlyFrom still clears the member's own rungs, and an officer clears any", async () => {
			await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "not_coming",
				actorMemberId: club.memberId,
			});
			const own = await clearPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				actorMemberId: club.memberId,
				onlyFrom: SELF_SERVICE_RUNGS,
			});
			expect(own.cleared).toBe(true);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe(null);

			// The officer arm passes no `onlyFrom` and may remove its own mark.
			await setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "reached_out",
				actorMemberId: club.adminMemberId,
			});
			const officer = await clearPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				actorMemberId: club.adminMemberId,
			});
			expect(officer.cleared).toBe(true);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe(null);
		});
	});
});
