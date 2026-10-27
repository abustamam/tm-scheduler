/**
 * DB-backed tests for the meeting_attendance_plan store.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	impersonationSessions,
	meetingAttendance,
	meetingAttendancePlan,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	resolveActor,
	SELF_ONLY_MESSAGE,
} from "#/server/attendance-actor-logic";
import {
	ASSERTED_OVERWRITE_MESSAGE,
	CLEARABLE_ASK,
	clearFloor,
	clearPlanStatus,
	getPlanStatus,
	IMPORT_PLAN_STATUS_MESSAGE,
	importPlanAnswers,
	isMemberUnavailable,
	listNotComingForMeetings,
	listPlanForMeetings,
	listUnavailableWithNames,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "#/server/attendance-plan-logic";
import { clearPlannedAttendanceCore } from "#/server/availability-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * The session mocks `availability.integration.test.ts` uses, for the same
 * reason: `resolveActor`'s officer arm reads the SESSION off the current
 * request, which vitest has none of. Only the cookie -> session lookup better-auth
 * would do is faked; `getSessionUser` and `requireClubRole` run for real against
 * the seeded rows. Every case that does not set `sessionUserId` stays the
 * anonymous caller it always was, and the `afterEach` below resets it.
 */
let sessionUserId: string | null = null;
/** One stable object per case, because the impersonation marker is keyed on
 *  identity. `let` so a case that makes an impersonated write can swap it for a
 *  fresh one afterwards, or the marker outlives the case. */
let request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

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
			onlyFrom: SELF_SERVICE_RUNGS,
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
			onlyFrom: SELF_SERVICE_RUNGS,
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
			onlyFrom: SELF_SERVICE_RUNGS,
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

	describe("unavailability: the roll record wins over the plan (#1257)", () => {
		// One fresh member per case, so a case cannot ride on another's rows.
		const CASES: [
			string,
			"absent" | "present" | "excused" | null,
			"coming" | "not_coming" | null,
			boolean,
		][] = [
			["absent, no plan", "absent", null, true],
			["absent, coming", "absent", "coming", true],
			["present, not_coming", "present", "not_coming", false],
			["excused, not_coming", "excused", "not_coming", true],
			["excused, no plan", "excused", null, false],
			["no record, not_coming", null, "not_coming", true],
			["no record, coming", null, "coming", false],
		];

		async function seedCase(
			name: string,
			record: "absent" | "present" | "excused" | null,
			plan: "coming" | "not_coming" | null,
		) {
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: club.clubId,
					personId: await seedPerson({ name }),
					name,
				})
				.returning({ id: members.id });
			if (!m) throw new Error("member insert failed");
			if (record)
				await testDb.insert(meetingAttendance).values({
					memberId: m.id,
					meetingId: club.meetingId,
					status: record,
				});
			if (plan)
				await testDb.insert(meetingAttendancePlan).values({
					memberId: m.id,
					meetingId: club.meetingId,
					status: plan,
				});
			return m.id;
		}

		for (const [label, record, plan, expected] of CASES) {
			it(`${label}: ${expected ? "unavailable" : "available"}`, async () => {
				// protects=the decision table of #1257 for this row, through both the list and the single-member check; fails_when=the plan alone decides, or the record is ignored/inverted; no_claim=none beyond protects (real rows, real join)
				const id = await seedCase(`Case ${label}`, record, plan);
				const listed = (
					await listUnavailableWithNames(testDb, club.meetingId)
				).map((r) => r.id);
				expect(listed.includes(id)).toBe(expected);
				expect(
					await isMemberUnavailable(testDb, {
						memberId: id,
						meetingId: club.meetingId,
					}),
				).toBe(expected);
			});
		}

		it("lists {id, name} ordered by name", async () => {
			// protects=the shape and order the loader field kept; fails_when=ORDER BY dropped (insertion order is the opposite); no_claim=none beyond protects
			const z = await seedCase("Zed Zulu", "absent", null);
			const a = await seedCase("Abe Alpha", null, "not_coming");
			const out = await listUnavailableWithNames(testDb, club.meetingId);
			expect(out).toEqual([
				{ id: a, name: "Abe Alpha" },
				{ id: z, name: "Zed Zulu" },
			]);
		});
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

		describe("onlyIfAbsent — fill a blank and nothing else (#762)", () => {
			// ADR-0026's line, in the seam. `demoteFrom` above narrows WHICH rows
			// may be overwritten; this one refuses to overwrite at all, and it is
			// the mode every session-less answer write runs in. All three outcomes
			// are asserted, because the middle one is what keeps it a fill-blank
			// rule rather than a one-shot one — and a two-case test (blank
			// succeeds, different refuses) passes just as well with the equal case
			// throwing at the member who gave the answer.

			it("inserts and logs when there is no row", async () => {
				const res = await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
					proof: "asserted",
					onlyIfAbsent: true,
				});
				expect(res.changed).toBe(true);
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe("coming");
				const logs = await testDb
					.select({ detail: activityLog.detail })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));
				expect(logs).toHaveLength(1);
				expect(logs[0]?.detail).toMatchObject({
					status: "coming",
					proof: "asserted",
				});
			});

			it("is a silent no-op when the row already says the same thing", async () => {
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
				});
				const before = await testDb
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));

				const res = await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
					proof: "asserted",
					onlyIfAbsent: true,
				});
				expect(res.changed).toBe(false);

				const after = await testDb
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));
				expect(
					after.length,
					"a re-sent answer must not file a second plan_set — the feed would show a change that did not happen",
				).toBe(before.length);
			});

			it("REFUSES, with the sign-in message, when the row says anything else", async () => {
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
				});
				const before = await testDb
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));

				await expect(
					setPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status: "not_coming",
						actorMemberId: club.memberId,
						proof: "asserted",
						onlyIfAbsent: true,
					}),
					// The MESSAGE, not merely that it threw: `SIGN_IN_REQUIRED_MESSAGE`
					// IS the wire format an `Error` survives a createServerFn round trip
					// as, and it is what makes the client's toast offer "Sign in"
					// instead of rendering a bare string (#761).
				).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);

				// Refused, not partially applied, and silent in the feed.
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe("coming");
				const after = await testDb
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));
				expect(after.length).toBe(before.length);
			});

			it("treats an officer's `reached_out` as still blank — the nudge round trip", async () => {
				// THE regression #762's review caught, and it kills the feature the
				// ladder exists for. The officer taps the member's WhatsApp draft,
				// which INSERTs `reached_out` onto a blank row; the member then opens
				// the session-less personal meeting page to answer. With
				// `reached_out` counted as "answered", BOTH of their answers refuse —
				// the officer asked and the member cannot reply.
				//
				// `reached_out` is the officer's record of having ASKED, never a
				// reply, which is the same sentence CLEARABLE_ASK and
				// SELF_SERVICE_RUNGS are built on. So it is a blank for this purpose.
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "reached_out",
					actorMemberId: club.adminMemberId,
				});

				const res = await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
					proof: "asserted",
					onlyIfAbsent: true,
				});
				expect(res.changed).toBe(true);
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe("coming");
				// And it LOGS, because something changed — the silent-no-op branch is
				// for a row that already said the same thing.
				const logs = await testDb
					.select({ detail: activityLog.detail })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));
				expect(logs).toHaveLength(2);
				expect(logs[1]?.detail).toMatchObject({
					status: "coming",
					proof: "asserted",
				});
			});

			it("the other direction too — declining over the ask", async () => {
				// Both answers, because the bug refused both and a one-answer test
				// would leave half the round trip broken.
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "reached_out",
					actorMemberId: club.adminMemberId,
				});
				const res = await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "not_coming",
					actorMemberId: club.memberId,
					proof: "asserted",
					onlyIfAbsent: true,
				});
				expect(res.changed).toBe(true);
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe("not_coming");
			});

			it("stays atomic when two first answers race", async () => {
				// The property the single-statement form buys, and the reason the
				// conflict arm is an UPDATE with a floor rather than a read followed
				// by a write. Both requests see no row; exactly one may land, and the
				// loser must be refused rather than overwrite the winner.
				//
				// Two DIFFERENT statuses on purpose: with the same one, a broken
				// implementation that let both through would still leave the right
				// row behind and only the log count would notice.
				const answer = (status: "coming" | "not_coming") =>
					setPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status,
						actorMemberId: club.memberId,
						proof: "asserted" as const,
						onlyIfAbsent: true as const,
					});
				const results = await Promise.allSettled([
					answer("coming"),
					answer("not_coming"),
				]);
				const landed = results.filter((r) => r.status === "fulfilled");
				const refused = results.filter((r) => r.status === "rejected");
				expect(landed).toHaveLength(1);
				expect(refused).toHaveLength(1);
				expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
					message: SIGN_IN_REQUIRED_MESSAGE,
				});
				// One row, one log — not two of either.
				const logs = await testDb
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId));
				expect(logs).toHaveLength(1);
			});

			it("REFUSES an unfloored asserted overwrite as a programming error", async () => {
				// The invariant the union cannot state (ASSERTED_OVERWRITE_MESSAGE).
				// `onlyIfAbsent: true` implies `proof: "asserted"` structurally, but
				// the converse does not fit — one legitimate asserted write is the
				// `reached_out` exemption, which carries a floor. So the residue is
				// checked here: asserted, no floor, not fill-blank is a miswired
				// caller, and it must fail loudly rather than write.
				await expect(
					setPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status: "not_coming",
						actorMemberId: club.memberId,
						proof: "asserted",
					}),
				).rejects.toThrow(ASSERTED_OVERWRITE_MESSAGE);
				// Refused BEFORE the database was touched.
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBeNull();
			});

			it("still allows the asserted write that names a floor — the Phase 2 exemption", async () => {
				// The control beside it, and the reason the invariant is stated as
				// "fill a blank OR name a floor" rather than a flat ban: an asserted
				// Toastmaster writing `reached_out` carries `["reached_out"]` and is
				// the debt ADR-0026 dates rather than closes (#747). Without this, a
				// stricter rule would look equally correct and would break the panel.
				const res = await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "reached_out",
					actorMemberId: club.memberId,
					proof: "asserted",
					demoteFrom: ["reached_out"],
				});
				expect(res.changed).toBe(true);
			});

			it("does NOT block an unrestricted write over the same row — the control", async () => {
				// Without this the three cases above pass with `setPlanStatus`
				// permanently refusing every overwrite, which would break the officer
				// correcting a wrong answer and the member correcting their own from
				// a signed-in device.
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
				});
				const res = await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "not_coming",
					actorMemberId: club.memberId,
					proof: "session",
				});
				expect(res.changed).toBe(true);
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe("not_coming");
			});
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

		it("onlyFrom still clears the member's own rungs, and an officer clears the ask", async () => {
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

			// The officer arm passes `CLEARABLE_ASK` and may remove its own mark.
			// It used to pass NOTHING and could remove any rung — see the #573 block
			// below for why that was the defect.
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
				onlyFrom: CLEARABLE_ASK,
			});
			expect(officer.cleared).toBe(true);
			expect(
				await getPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe(null);
		});

		/**
		 * The officer's "No answer" must never erase an ANSWER (#573).
		 *
		 * The rail is a sticky panel that stays open while members reply from their
		 * phones, and plan data has no poll — it refreshes on a write or a
		 * navigation. So a row can still read `Asked` while the server already holds
		 * `not_coming`. The officer taps "No answer" meaning *un-ask*, and before
		 * this the delete took whatever was there: the member's decline vanished,
		 * they dropped off `unavailableMembers` and out of the recruit picker's
		 * warning, and they could then be handed a role they had said they could not
		 * take. Recoverable (they can reply again) and narrow (the window is
		 * seconds for an officer actively working the rail, arbitrary for an idle
		 * tab) — worth fixing because the fix is a floor, not because it is common.
		 *
		 * ASSERT THE SURVIVING ROW, not just `cleared`. A `WHERE`-refused delete and
		 * a delete that found nothing return the identical `{ ok, cleared: false }`,
		 * so a result-only assertion is CLAUDE.md's "guard whose only effect is
		 * avoiding work" trap: it passes with the floor deleted. Read the row back.
		 */
		describe("an officer's clear cannot erase an answer (#573)", () => {
			it.each([
				"not_coming",
				"coming",
			] as const)("refuses to clear a %s row, and the row survives", async (status) => {
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status,
					actorMemberId: club.memberId,
				});

				const res = await clearPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					actorMemberId: club.adminMemberId,
					onlyFrom: CLEARABLE_ASK,
				});

				expect(res.cleared).toBe(false);
				// The half that fails when the floor is removed.
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe(status);
			});

			it("still clears a reached_out row, so un-asking keeps working", async () => {
				await setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "reached_out",
					actorMemberId: club.adminMemberId,
				});

				const res = await clearPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					actorMemberId: club.adminMemberId,
					onlyFrom: CLEARABLE_ASK,
				});

				expect(res.cleared).toBe(true);
				expect(
					await getPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
					}),
				).toBe(null);
			});

			/**
			 * An officer's OWN row is self-service (the floor is `clearFloor`'s, the
			 * same call `clearPlannedAttendance` makes with the resolved arm and actor).
			 * The officer arm used to apply `CLEARABLE_ASK` to its own row too, so the
			 * personal strip's "undo" deleted nothing and the answer came back with no
			 * error. Read the row back for the same reason as above: a refused delete
			 * and a delete that found nothing both report `cleared: false`.
			 */
			describe("an officer clearing their own row vs another member's", () => {
				const officerClear = (subjectMemberId: string) =>
					clearPlanStatus(testDb, {
						memberId: subjectMemberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						actorMemberId: club.adminMemberId,
						onlyFrom: clearFloor({
							via: "officer",
							actorMemberId: club.adminMemberId,
							memberId: subjectMemberId,
						}),
					});
				const rowOf = (memberId: string) =>
					getPlanStatus(testDb, { memberId, meetingId: club.meetingId });

				it.each([
					"coming",
					"not_coming",
					"reached_out",
				] as const)("clears their own %s row", async (status) => {
					await setPlanStatus(testDb, {
						memberId: club.adminMemberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status,
						actorMemberId: club.adminMemberId,
					});

					const res = await officerClear(club.adminMemberId);

					expect(res.cleared).toBe(true);
					expect(await rowOf(club.adminMemberId)).toBe(null);
				});

				it.each([
					"coming",
					"not_coming",
				] as const)("still keeps ANOTHER member's %s row (#573)", async (status) => {
					await setPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status,
						actorMemberId: club.memberId,
					});

					const res = await officerClear(club.memberId);

					expect(res.cleared).toBe(false);
					expect(await rowOf(club.memberId)).toBe(status);
				});

				it("clears another member's reached_out, so un-asking keeps working", async () => {
					await setPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status: "reached_out",
						actorMemberId: club.adminMemberId,
					});

					const res = await officerClear(club.memberId);

					expect(res.cleared).toBe(true);
					expect(await rowOf(club.memberId)).toBe(null);
				});
			});

			/**
			 * `clearFloor`'s self test is only safe because, on the officer arm,
			 * `resolveActor` sets `actorMemberId` from the SESSION's own membership.
			 * The block above feeds `clearFloor` a hand-picked actor, so it cannot see
			 * a ladder that read the caller's CLAIMED id there instead; these run the
			 * ladder itself, with a signed-in admin who claims to be someone else.
			 * `attendance-plan-authz.guard.test.ts` pins the same sequence as source
			 * text; this is the half that fails on behaviour.
			 */
			describe("the officer arm's actor is the session's member, never the claimed one", () => {
				beforeEach(() => {
					sessionUserId = club.adminUserId;
				});
				afterEach(() => {
					sessionUserId = null;
				});

				const resolveAs = (subjectMemberId: string, claimed: string) =>
					resolveActor({
						clubId: club.clubId,
						meetingId: club.meetingId,
						memberId: subjectMemberId,
						claimedActorMemberId: claimed,
					});

				it("credits the admin's own member id when the caller claims another member", async () => {
					const resolved = await resolveAs(club.memberId, club.memberId);

					expect(resolved.via).toBe("officer");
					expect(resolved.proof).toBe("session");
					expect(resolved.actorMemberId).toBe(club.adminMemberId);
					expect(resolved.actorMemberId).not.toBe(club.memberId);
				});

				it("floors another member's row at the ask even when the claim names that member", async () => {
					const resolved = await resolveAs(club.memberId, club.memberId);

					expect(
						clearFloor({
							via: resolved.via,
							actorMemberId: resolved.actorMemberId,
							memberId: club.memberId,
						}),
					).toEqual(["reached_out"]);
				});

				it("keeps another member's coming row when the claim names that member", async () => {
					await setPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status: "coming",
						actorMemberId: club.memberId,
					});

					const resolved = await resolveAs(club.memberId, club.memberId);
					const res = await clearPlanStatus(testDb, {
						memberId: club.memberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						actorMemberId: resolved.actorMemberId,
						onlyFrom: clearFloor({
							via: resolved.via,
							actorMemberId: resolved.actorMemberId,
							memberId: club.memberId,
						}),
					});

					expect(res.cleared).toBe(false);
					expect(
						await getPlanStatus(testDb, {
							memberId: club.memberId,
							meetingId: club.meetingId,
						}),
					).toBe("coming");
				});

				it("still lets the admin clear their OWN coming row while claiming another member", async () => {
					await setPlanStatus(testDb, {
						memberId: club.adminMemberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						status: "coming",
						actorMemberId: club.adminMemberId,
					});

					// The claim names someone else; the subject is the admin's own row, so
					// the answer is the SESSION's and the clear goes through.
					const resolved = await resolveAs(club.adminMemberId, club.memberId);
					expect(resolved.actorMemberId).toBe(club.adminMemberId);
					const res = await clearPlanStatus(testDb, {
						memberId: club.adminMemberId,
						meetingId: club.meetingId,
						clubId: club.clubId,
						actorMemberId: resolved.actorMemberId,
						onlyFrom: clearFloor({
							via: resolved.via,
							actorMemberId: resolved.actorMemberId,
							memberId: club.adminMemberId,
						}),
					});

					expect(res.cleared).toBe(true);
					expect(
						await getPlanStatus(testDb, {
							memberId: club.adminMemberId,
							meetingId: club.meetingId,
						}),
					).toBe(null);
				});
			});

			/**
			 * The two floors are exact COMPLEMENTS, and that is the property worth
			 * asserting rather than each half separately: a member may clear an
			 * answer, an officer may clear the ask, and neither may touch the other's.
			 * A future edit that widened either one — say by adding `reached_out` to
			 * `SELF_SERVICE_RUNGS` "for symmetry" — would satisfy every case above
			 * and fail here.
			 */
			it("the self-service and officer floors do not overlap", () => {
				const overlap = SELF_SERVICE_RUNGS.filter((r) =>
					CLEARABLE_ASK.includes(r),
				);
				expect(overlap).toEqual([]);
				// And together they cover every rung, so no status is unclearable by
				// everyone — which would be a row nobody could ever reset.
				expect([...SELF_SERVICE_RUNGS, ...CLEARABLE_ASK].sort()).toEqual([
					"coming",
					"not_coming",
					"reached_out",
				]);
			});
		});
	});
});

describe.skipIf(!hasTestDb)("importPlanAnswers (#1051)", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
		// A history import writes a PAST meeting.
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	const rows = () =>
		testDb
			.select({
				memberId: meetingAttendancePlan.memberId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.meetingId, club.meetingId));
	const logged = async () =>
		(
			await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId))
		).length;

	it("fills every answer into a COMPLETED meeting and logs nothing", async () => {
		const before = await logged();
		const result = await importPlanAnswers(testDb, {
			meetingId: club.meetingId,
			answers: [
				{ memberId: club.memberId, status: "coming" },
				{ memberId: club.adminMemberId, status: "not_coming" },
			],
		});
		expect(result).toEqual({ inserted: 2 });
		expect(
			(await rows()).sort((a, b) => a.status.localeCompare(b.status)),
		).toEqual(
			[
				{ memberId: club.memberId, status: "coming" },
				{ memberId: club.adminMemberId, status: "not_coming" },
			].sort((a, b) => a.status.localeCompare(b.status)),
		);
		// The point of the seam function: no plan_set per answer.
		expect(await logged()).toBe(before);
	});

	it("never overwrites a row that is already there, whatever its rung", async () => {
		await testDb.insert(meetingAttendancePlan).values([
			{ memberId: club.memberId, meetingId: club.meetingId, status: "coming" },
			{
				memberId: club.adminMemberId,
				meetingId: club.meetingId,
				status: "reached_out",
			},
		]);
		const result = await importPlanAnswers(testDb, {
			meetingId: club.meetingId,
			answers: [
				{ memberId: club.memberId, status: "not_coming" },
				{ memberId: club.adminMemberId, status: "not_coming" },
			],
		});
		expect(result).toEqual({ inserted: 0 });
		const byMember = new Map((await rows()).map((r) => [r.memberId, r.status]));
		expect(byMember.get(club.memberId)).toBe("coming");
		expect(byMember.get(club.adminMemberId)).toBe("reached_out");
	});

	it("refuses a cancelled meeting, writing nothing", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			importPlanAnswers(testDb, {
				meetingId: club.meetingId,
				answers: [{ memberId: club.memberId, status: "coming" }],
			}),
		).rejects.toThrow();
		expect(await rows()).toEqual([]);
	});

	it("refuses a scheduled meeting, writing nothing", async () => {
		await testDb
			.update(meetings)
			.set({ status: "scheduled" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			importPlanAnswers(testDb, {
				meetingId: club.meetingId,
				answers: [{ memberId: club.memberId, status: "coming" }],
			}),
		).rejects.toThrow(IMPORT_PLAN_STATUS_MESSAGE);
		expect(await rows()).toEqual([]);
	});

	it("is a no-op, with no query, for no answers", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			importPlanAnswers(testDb, { meetingId: club.meetingId, answers: [] }),
		).resolves.toEqual({ inserted: 0 });
	});
});

/**
 * The meeting page's "No answer", run through the seam the handler calls.
 *
 * `clearPlannedAttendance`'s ladder, session-proof check and floor live in
 * `clearPlannedAttendanceCore` (`availability-logic.ts`), which the handler calls
 * after its meeting, archive, roster and `requireSessionActor` gates; this calls
 * the same seam against the real rows, so a deleted proof check or a changed
 * floor fails here and not only in a source grep
 * (`attendance-plan-authz.guard.test.ts` pins the handler's own wiring).
 *
 * A member's ANSWER is cleared by that member, or by an officer on the season
 * grid, and by nobody else. The Toastmaster is neither, so on another member's
 * row its floor is empty: `coming` and `not_coming` both survive. Every case
 * reads the row back, because `cleared: false` is the same report for a refused
 * delete and for a delete that found nothing.
 */
describe.skipIf(!hasTestDb)("the Toastmaster's clear (#573 follow-up)", () => {
	let club: SeededClub;
	let tmodUserId: string;
	let tmodMemberId: string;
	let extraUserIds: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraUserIds = [];
		tmodUserId = randomUUID();
		const email = `${tmodUserId}@test.example`;
		await testDb
			.insert(user)
			.values({ id: tmodUserId, name: "TMOD", email, emailVerified: true });
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: await seedPerson({
					name: "TMOD",
					email,
					userId: tmodUserId,
				}),
				name: "TMOD",
			})
			.returning({ id: members.id });
		if (!m) throw new Error("member insert failed");
		tmodMemberId = m.id;
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				name: "Toastmaster of the Day",
				key: null,
				category: "leadership",
				isSpeakerRole: false,
				sortOrder: 1,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("role definition insert failed");
		await testDb.insert(roleSlots).values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: "claimed",
			assignedMemberId: tmodMemberId,
		});
		sessionUserId = tmodUserId;
	});
	afterEach(async () => {
		sessionUserId = null;
		// The impersonation marker is keyed on the request object's identity, so a
		// case that made an impersonated write must not leave it on the shared one.
		request = { headers: new Headers() };
		await cleanup(club.clubId, [
			club.adminUserId,
			club.memberUserId,
			tmodUserId,
			...extraUserIds,
		]);
	});

	/** The seam as the meeting page calls it. The claim names the subject, the
	 *  shape the rail sends, unless a case passes its own id or `null` for none. */
	const clearAs = (
		subjectMemberId: string,
		claim: string | null = subjectMemberId,
	) =>
		clearPlannedAttendanceCore(testDb, {
			memberId: subjectMemberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			claimedActorMemberId: claim ?? undefined,
		});
	const rowOf = (memberId: string) =>
		getPlanStatus(testDb, { memberId, meetingId: club.meetingId });
	const seedRow = (
		memberId: string,
		status: "reached_out" | "coming" | "not_coming",
		actorMemberId: string = memberId,
	) =>
		setPlanStatus(testDb, {
			memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status,
			actorMemberId,
		});
	/** A superadmin with an impersonation session in this club, signed in. */
	async function signInAsSupport(mode: "read_only" | "read_write") {
		const superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Support",
			email: `support-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		extraUserIds.push(superadminId);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: club.clubId,
			mode,
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		sessionUserId = superadminId;
		return superadminId;
	}

	it("resolves the seeded caller as the Toastmaster arm", async () => {
		// The cases below mean "the Toastmaster" only if the fixture gives the
		// caller that arm; without this a broken fixture would read as a floor.
		const resolved = await resolveActor({
			clubId: club.clubId,
			meetingId: club.meetingId,
			memberId: club.memberId,
			claimedActorMemberId: club.memberId,
		});
		expect(resolved.via).toBe("tmod");
		expect(resolved.proof).toBe("session");
	});

	// protects=a Toastmaster's "No answer" on another member's coming/not_coming deletes nothing and the row survives; fails_when=the tmod arm's other-row floor returns SELF_SERVICE_RUNGS (or the ask); no_claim=the officer's season-grid clear, which is a different path
	it.each([
		"coming",
		"not_coming",
	] as const)("KEEPS another member's %s row", async (status) => {
		await seedRow(club.memberId, status);

		const res = await clearAs(club.memberId);

		expect(res.cleared).toBe(false);
		expect(await rowOf(club.memberId)).toBe(status);
	});

	it("KEEPS another member's reached_out row: an officer's ask is not the Toastmaster's to take back", async () => {
		await seedRow(club.memberId, "reached_out", club.adminMemberId);

		const res = await clearAs(club.memberId);

		expect(res.cleared).toBe(false);
		expect(await rowOf(club.memberId)).toBe("reached_out");
	});

	// protects=the Toastmaster still takes back their OWN answer; fails_when=the own-row test is inverted or the tmod arm loses SELF_SERVICE_RUNGS; no_claim=none beyond protects
	it.each([
		"coming",
		"not_coming",
	] as const)("clears their OWN %s row", async (status) => {
		await seedRow(tmodMemberId, status);

		const res = await clearAs(tmodMemberId);

		expect(res.cleared).toBe(true);
		expect(await rowOf(tmodMemberId)).toBe(null);
	});

	it("does not clear their OWN reached_out: the ask is the officer's to remove", async () => {
		await seedRow(tmodMemberId, "reached_out", club.adminMemberId);

		const res = await clearAs(tmodMemberId);

		expect(res.cleared).toBe(false);
		expect(await rowOf(tmodMemberId)).toBe("reached_out");
	});

	it("an officer who also holds the Toastmaster slot is the officer arm, not floored to nothing", async () => {
		// The arm order is officer first, so an admin who runs the meeting keeps the
		// officer's floor (the ask on another's row) rather than the Toastmaster's.
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: club.adminMemberId })
			.where(eq(roleSlots.meetingId, club.meetingId));
		sessionUserId = club.adminUserId;
		await seedRow(club.memberId, "reached_out", club.adminMemberId);

		const res = await clearAs(club.memberId, null);

		expect(res.cleared).toBe(true);
		expect(await rowOf(club.memberId)).toBe(null);
	});

	// protects=an officer's "No answer" on another member's answered row removes nothing, through the seam itself; fails_when=the officer arm's other-row floor widens to SELF_SERVICE_RUNGS or the floor is dropped; no_claim=the season grid's clear, which floors at a decline instead
	it.each([
		"coming",
		"not_coming",
	] as const)("KEEPS another member's %s row when an OFFICER clears", async (status) => {
		sessionUserId = club.adminUserId;
		await seedRow(club.memberId, status);

		const res = await clearAs(club.memberId, null);

		expect(res.cleared).toBe(false);
		expect(await rowOf(club.memberId)).toBe(status);
	});

	// ------------------------------------------------------------------------
	// Only a session-proven caller deletes anything.
	// ------------------------------------------------------------------------

	// protects=a clear with NO session is refused whatever it claims, and the row stays; fails_when=the seam's assertSessionProof is removed (the asserted self arm admits a claim naming the subject, and an anonymous clear of one's own row would delete); no_claim=requireSessionActor in the handler, which the guard test pins
	it.each([
		["claims the subject", true],
		["claims nobody", false],
	] as const)("REFUSES a caller with no session that %s", async (_label, claimsSubject) => {
		await seedRow(club.memberId, "not_coming");
		sessionUserId = null;

		await expect(
			clearAs(club.memberId, claimsSubject ? club.memberId : null),
		).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
		expect(await rowOf(club.memberId)).toBe("not_coming");
	});

	// protects=a Toastmaster whose login no longer resolves to a roster member mid-request is refused instead of clearing the row they name; fails_when=assertSessionProof is removed (the asserted arm then admits the claimed Toastmaster id); no_claim=none beyond protects
	it("REFUSES a signed-in Toastmaster whose membership link is gone, even naming their own row", async () => {
		await seedRow(tmodMemberId, "not_coming");
		const [m] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, tmodMemberId));
		if (!m) throw new Error("tmod member missing");
		await testDb
			.update(people)
			.set({ userId: null })
			.where(eq(people.id, m.personId));

		await expect(clearAs(tmodMemberId)).rejects.toThrow(
			SIGN_IN_REQUIRED_MESSAGE,
		);
		expect(await rowOf(tmodMemberId)).toBe("not_coming");
	});

	// protects=a read-only support session cannot clear a member's answer; fails_when=the read-only impersonation is granted the officer arm or admitted as asserted; no_claim=the message (it is the ladder's, not the gate's)
	it("REFUSES a read_only support session", async () => {
		await seedRow(club.memberId, "reached_out", club.adminMemberId);
		await signInAsSupport("read_only");

		await expect(clearAs(club.memberId, null)).rejects.toThrow();
		expect(await rowOf(club.memberId)).toBe("reached_out");
	});

	// protects=a read_write impersonating superadmin keeps the officer arm's credit: the clear is credited to nobody and stamped with the superadmin; fails_when=assertSessionProof refuses the officer arm's null actor, or the actor is defaulted to the claim; no_claim=none beyond protects
	it("lets a read_write support session clear an ask, credited to nobody and stamped", async () => {
		await seedRow(club.memberId, "reached_out", club.adminMemberId);
		const superadminId = await signInAsSupport("read_write");

		const res = await clearAs(club.memberId, null);

		expect(res.cleared).toBe(true);
		expect(await rowOf(club.memberId)).toBe(null);
		const logs = await testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				impersonatedBy: activityLog.impersonatedBy,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, club.meetingId),
					eq(activityLog.action, "plan_set"),
				),
			);
		const cleared = logs.filter(
			(l) => (l.detail as { status?: unknown } | null)?.status === null,
		);
		expect(cleared).toHaveLength(1);
		expect(cleared[0]?.actorMemberId).toBeNull();
		expect(cleared[0]?.impersonatedBy).toBe(superadminId);
	});

	// ------------------------------------------------------------------------
	// The claim never decides who the actor is.
	// ------------------------------------------------------------------------

	// protects=a plain signed-in member who claims the Toastmaster's published id on another member's row is refused and the row stays; fails_when=the claim is believed over the session, or the Toastmaster arm admits a claimed id; no_claim=none beyond protects
	it("REFUSES a plain member who CLAIMS this meeting's Toastmaster id", async () => {
		await seedRow(club.adminMemberId, "not_coming");
		sessionUserId = club.memberUserId;

		await expect(clearAs(club.adminMemberId, tmodMemberId)).rejects.toThrow(
			SELF_ONLY_MESSAGE,
		);
		expect(await rowOf(club.adminMemberId)).toBe("not_coming");
	});

	// protects=a plain signed-in member who names THEMSELVES as the actor while naming another member as the subject is refused; fails_when=the ladder is asked about the claimed id instead of the subject; no_claim=none beyond protects
	it("REFUSES a plain member who claims THEMSELVES while naming ANOTHER subject", async () => {
		await seedRow(club.adminMemberId, "not_coming");
		sessionUserId = club.memberUserId;

		await expect(clearAs(club.adminMemberId, club.memberId)).rejects.toThrow(
			SELF_ONLY_MESSAGE,
		);
		expect(await rowOf(club.adminMemberId)).toBe("not_coming");
	});
});
