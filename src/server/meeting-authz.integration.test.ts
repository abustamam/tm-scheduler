/**
 * DB-backed tests for the per-meeting agenda-write authorization (ADR-0010):
 * a club admin OR the meeting's self-asserted TMOD may edit; reschedule stays
 * admin-only. Tests the plain logic fns directly (`#/db` → test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-authz.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { utcToZonedWallTime } from "#/lib/datetime";
import {
	GRAMMARIAN_ROLE_KEY,
	TMOD_ROLE_KEY,
	VOTE_COUNTER_ROLE_KEY,
} from "#/lib/meeting-roles";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	resolveMeetingAgendaAuthz,
	resolveVoteCounterAuthz,
	resolveWordOfTheDayAuthz,
} = await import("./meeting-authz-logic");
const { applyMeetingMetaPatch } = await import("./meetings-logic");
const { startImpersonation } = await import("./impersonation-logic");

/** Add a Toastmaster of the Day role def + slot to the meeting; optionally
 *  assign a roster member. Returns the slot id.
 *
 *  Defaults to the canonical name with NO key, which is the pre-#368-backfill
 *  shape every test here was written against and which must keep working.
 *  `role` overrides both so #464's cases can seed a renamed TMOD (key intact) or
 *  a club-invented role whose NAME merely looks like one. */
async function addTmodSlot(
	club: SeededClub,
	assignedMemberId: string | null,
	role: { name?: string; key?: string | null } = {},
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: role.name ?? "Toastmaster of the Day",
			key: role.key ?? null,
			category: "leadership",
			isSpeakerRole: false,
			sortOrder: 1,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: assignedMemberId ? "claimed" : "open",
			assignedMemberId,
		})
		.returning({ id: roleSlots.id });
	return slot.id;
}

/** Insert an extra active roster member; return its id. Every membership needs
 *  a Person (ADR-0008 / #64) — seed one first. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	return m.id;
}

describe.skipIf(!hasTestDb)("meeting agenda authorization", () => {
	let club: SeededClub;
	const extraUsers: string[] = [];

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		for (const id of extraUsers.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	it("allows a club admin (session) — via admin", async () => {
		await addTmodSlot(club, null);
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.adminUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows a member promoted to admin (session) — via admin", async () => {
		// Promote the member's membership row to admin (resolved via their Person).
		await testDb
			.update(members)
			.set({ clubRole: "admin" })
			.where(eq(members.id, club.memberId));
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows a superadmin with a read_write impersonation session — via admin (#246)", async () => {
		await addTmodSlot(club, null);
		const suId = randomUUID();
		await testDb.insert(user).values({
			id: suId,
			name: "Verify SU",
			email: `su-${suId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		extraUsers.push(suId);

		// read_only impersonation does NOT grant the admin editor (write-blind).
		await startImpersonation(suId, { clubId: club.clubId });
		let authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: suId,
		});
		expect(authz.allowed).toBe(false);

		// read_write impersonation grants the admin editor path.
		await startImpersonation(suId, {
			clubId: club.clubId,
			mode: "read_write",
			reason: "fixing the agenda",
		});
		authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: suId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows the meeting's TMOD self-assert — via tmod-self-assert", async () => {
		await addTmodSlot(club, club.memberId);
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("tmod-self-assert");
		expect(authz.tmodMemberId).toBe(club.memberId);
	});

	// #464 — the SERVER half. These two roles carry a capability, so identifying
	// them by display name was not an affordance bug: the mutation itself was
	// refused for a club that renamed, and granted to a club that invented a
	// look-alike. Both directions are exercised here rather than only in the pure
	// unit test, because this is the decision that actually gates the write.
	it("allows the TMOD self-assert after the club RENAMES the role (#464)", async () => {
		await addTmodSlot(club, club.memberId, {
			name: "MC",
			key: "toastmaster_of_the_day",
		});
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("tmod-self-assert");
		expect(authz.tmodMemberId).toBe(club.memberId);
	});

	// NULL key, which is what `createClubRole` actually writes — it never sets one.
	// So this is the shape a real club produces, and keying off `key` alone did not
	// close it: the row falls through to the NAME fallback, which is why that
	// fallback matches canonical names EXACTLY rather than by prefix.
	it("rejects a club-invented role whose NAME merely looks like the TMOD (#464)", async () => {
		await addTmodSlot(club, club.memberId, {
			name: "Toastmaster Evaluator",
			key: null,
		});
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
		expect(authz.tmodMemberId).toBe(null);
	});

	// The unordered-SQL defect. Two candidates in one meeting and a single `find`
	// would answer with whichever row Postgres returned first, so the same meeting
	// could grant the impostor on one request and the real TMOD on the next.
	it("picks the keyed TMOD over a keyless look-alike in the same meeting (#464)", async () => {
		const impostor = await addRosterMember(club.clubId, "Impostor");
		await addTmodSlot(club, impostor, {
			name: "Toastmaster Assistant",
			key: null,
		});
		await addTmodSlot(club, club.memberId, {
			name: "MC",
			key: "toastmaster_of_the_day",
		});
		const real = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(real.allowed).toBe(true);
		expect(real.via).toBe("tmod-self-assert");
		// Credited to the verified holder, which is what lands in activity_log (#396).
		expect(real.actorMemberId).toBe(club.memberId);
		const fake = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: impostor,
		});
		expect(fake.allowed).toBe(false);
		expect(fake.via).toBe(null);
	});

	it("rejects a non-TMOD, non-admin roster member", async () => {
		await addTmodSlot(club, club.memberId);
		const other = await addRosterMember(club.clubId, "Someone Else");
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: other,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
	});

	it("rejects self-assert when the TMOD slot is unassigned", async () => {
		await addTmodSlot(club, null);
		const someone = await addRosterMember(club.clubId, "Wannabe");
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: someone,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.tmodMemberId).toBe(null);
	});

	it("rejects a plain member session with no self-assert", async () => {
		await addTmodSlot(club, club.memberId);
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
		});
		expect(authz.allowed).toBe(false);
	});

	/**
	 * Archived club = platform takedown (ADR-0016/#555): a WRITE must THROW, not
	 * return `allowed: false`, so every caller surfaces the same sentence.
	 *
	 * This resolver is the choke point for the whole agenda-edit family
	 * (`updateMeeting`, `addSpeakerSlot`, `removeSpeakerSlot`, `moveSpeakerSlot`,
	 * `moveEvaluatorSlot`), and it carried NO archive check — the gate belongs
	 * here rather than in five handlers, and here is also the only place the
	 * session-less TMOD arm can be covered. Both arms are asserted because the
	 * admin arm returns FIRST: gating only the TMOD path would leave the family
	 * open to any club admin, and gating only the admin path would leave it open
	 * to a session-less self-asserted TMOD, which is the wider hole.
	 */
	/**
	 * The archive gate runs BEFORE the meeting-lock check, in all three resolvers.
	 * Ordering is not cosmetic: with the lock first, an archived club's COMPLETED
	 * meeting answered "this meeting is completed" — telling a caller the takedown
	 * was supposed to silence something about the meeting's state, and answering
	 * differently from the same club's scheduled meeting. Takedown outranks every
	 * other reason to refuse.
	 */
	it("reports the takedown, not the lock, on an archived club's completed meeting", async () => {
		await addTmodSlot(club, null);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				sessionUserId: club.adminUserId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("throws on an archived club — admin arm (#555)", async () => {
		await addTmodSlot(club, null);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				sessionUserId: club.adminUserId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("throws on an archived club — session-less TMOD self-assert arm (#555)", async () => {
		await addTmodSlot(club, club.memberId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				sessionUserId: null,
				selfMemberId: club.memberId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	/**
	 * The two sibling resolvers in the same module gate identically. Splitting the
	 * fix would be the half-applied shape: all three authorize a WRITE to a
	 * meeting of a club, all three are reached by session-less self-assert arms,
	 * and all three are exempted from the archive-gate sweep by the same
	 * `require*Editor` regex — so a gate on one of them reads as "handled".
	 */
	it("throws on an archived club — Word of the Day resolver (#555)", async () => {
		await addTmodSlot(club, club.memberId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			resolveWordOfTheDayAuthz({
				meetingId: club.meetingId,
				sessionUserId: null,
				selfMemberId: club.memberId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("throws on an archived club — vote counter resolver (#555)", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			resolveVoteCounterAuthz({
				meetingId: club.meetingId,
				sessionUserId: club.adminUserId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	/** The DENIED path throws the same way: an archived club must not be
	 *  distinguishable by whether the caller would otherwise have had access. */
	it("throws on an archived club even for a caller with no access (#555)", async () => {
		await addTmodSlot(club, null);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				sessionUserId: null,
				selfMemberId: randomUUID(),
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("meta edit is allowed for a TMOD (canReschedule=false) when time is unchanged", async () => {
		// Re-submit the current wall time so it round-trips to the same instant.
		const current = await testDb.query.meetings.findFirst({
			where: (m, { eq: e }) => e(m.id, club.meetingId),
		});
		expect(current).toBeTruthy();
		// seedClub uses the default club timezone (America/Chicago); convert the
		// stored UTC instant back to its wall-clock string so it round-trips.
		const wall = current
			? utcToZonedWallTime(current.scheduledAt, "America/Chicago")
			: "";
		await expect(
			applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				scheduledAt: wall,
				theme: "TMOD picked this",
				canReschedule: false,
			}),
		).resolves.toBeTruthy();
	});

	it("rejects a TMOD reschedule (date/time change, canReschedule=false)", async () => {
		await expect(
			applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				scheduledAt: "2099-01-01T12:00",
				canReschedule: false,
			}),
		).rejects.toThrow(/reschedule/i);
	});

	it("rejects a TMOD length change (canReschedule=false)", async () => {
		const current = await testDb.query.meetings.findFirst({
			where: (m, { eq: e }) => e(m.id, club.meetingId),
		});
		const wall = current
			? utcToZonedWallTime(current.scheduledAt, "America/Chicago")
			: "";
		await expect(
			applyMeetingMetaPatch({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				scheduledAt: wall,
				lengthMinutes: (current?.lengthMinutes ?? 90) + 15,
				canReschedule: false,
			}),
		).rejects.toThrow(/reschedule/i);
	});
});

/**
 * A self-assert never overrides a session (#747, ADR-0026).
 *
 * The bug: all four self-assert arms in `meeting-authz-logic.ts` granted on
 * `selfMemberId === <slot>MemberId` and consulted `sessionUserId` nowhere, so an
 * ordinary signed-in member fell past the admin arm and could assert ANYONE's
 * id — and `activity_log` then credited the write to the innocent member whose
 * id was asserted, because `actorMemberId` is the asserted identity. The
 * activity log is not the safety net ADR-0010 called it; under impersonation it
 * is the amplifier.
 *
 * **Every case is run against all four arms**, by name, rather than against the
 * one that prompted the filing. That is the finding: it was one SHAPE copied
 * four times, so a fixture that exercises one arm says nothing about the other
 * three — and the arms are spread across three resolvers with three different
 * result shapes, which is how four copies went unnoticed.
 *
 * **Each refusal is paired with its anonymous control.** A refusal assertion on
 * its own passes for any reason at all, including a broken fixture whose slot
 * was never assigned; running the identical call with no session and seeing it
 * GRANT is what pins the refusal to the session and nothing else. It is also
 * the acceptance criterion in its own right — the account-less Toastmaster
 * running the agenda from their phone is the workflow this model exists for,
 * and #747 must leave it byte for byte unchanged.
 */
describe.skipIf(!hasTestDb)("self-assert binds to the session (#747)", () => {
	let club: SeededClub;
	const extraUsers: string[] = [];

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		for (const id of extraUsers.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	/** Seed a KEYED role slot on the meeting, optionally assigned. Keyed rather
	 *  than name-matched so the fixture cannot fail for a #464 reason. */
	async function addKeyedSlot(
		key: string,
		name: string,
		assignedMemberId: string | null,
	): Promise<void> {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				name,
				key,
				category: "functionary",
				isSpeakerRole: false,
				sortOrder: 50,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: assignedMemberId ? "claimed" : "open",
			assignedMemberId,
		});
	}

	/** A signed-in account that is on NO roster in this club — an outsider
	 *  holding an account, which is what acceptance criterion 4 is about. */
	async function addOutsiderUser(): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Outsider",
			email: `outsider-${id}@test.example`,
			emailVerified: true,
		});
		extraUsers.push(id);
		return id;
	}

	/** A superadmin account, for the two impersonation arms. */
	async function addSuperadminUser(): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Super User",
			email: `su-${id}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		extraUsers.push(id);
		return id;
	}

	/** The common shape of the three resolvers' answers, so one table can drive
	 *  all four arms. `via` and `actorMemberId` are on every one of them. */
	type Answer = {
		allowed: boolean;
		via: string | null;
		actorMemberId: string | null;
	};

	const ARMS: {
		arm: string;
		key: string;
		roleName: string;
		via: string;
		resolve: (input: {
			meetingId: string;
			sessionUserId?: string | null;
			selfMemberId?: string | null;
		}) => Promise<Answer>;
	}[] = [
		{
			arm: "agenda meta (TMOD)",
			key: TMOD_ROLE_KEY,
			roleName: "Toastmaster of the Day",
			via: "tmod-self-assert",
			resolve: resolveMeetingAgendaAuthz,
		},
		{
			arm: "Word of the Day (TMOD)",
			key: TMOD_ROLE_KEY,
			roleName: "Toastmaster of the Day",
			via: "tmod-self-assert",
			resolve: resolveWordOfTheDayAuthz,
		},
		{
			arm: "Word of the Day (Grammarian)",
			key: GRAMMARIAN_ROLE_KEY,
			roleName: "Grammarian",
			via: "grammarian-self-assert",
			resolve: resolveWordOfTheDayAuthz,
		},
		{
			arm: "Ballot Counter",
			key: VOTE_COUNTER_ROLE_KEY,
			roleName: "Ballot Counter",
			via: "vote-counter-self-assert",
			resolve: resolveVoteCounterAuthz,
		},
	];

	it.each(
		ARMS,
	)("$arm: refuses a signed-in member asserting somebody else's id", async ({
		key,
		roleName,
		via,
		resolve,
	}) => {
		// The reported bug, per arm. `club.memberUserId` is an ordinary active
		// member — not an admin, so they fall past the admin arm — and the id
		// they assert is the role holder's, which the public meeting payload
		// ships to any visitor (`slots[].assigneeId`).
		const holder = await addRosterMember(club.clubId, "Real Holder");
		await addKeyedSlot(key, roleName, holder);

		const forged = await resolve({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
			selfMemberId: holder,
		});
		expect(forged.allowed).toBe(false);
		expect(forged.via).toBeNull();
		// The audit trail is half the harm: before #747 this returned `holder`,
		// so the forged write landed in the club's permanent log under the name
		// of the member who did not make it.
		expect(forged.actorMemberId).toBeNull();

		// The control. Identical call, no session — still granted, so the
		// refusal above is the session and not the fixture.
		const anonymous = await resolve({
			meetingId: club.meetingId,
			sessionUserId: null,
			selfMemberId: holder,
		});
		expect(anonymous.allowed).toBe(true);
		expect(anonymous.via).toBe(via);
		expect(anonymous.actorMemberId).toBe(holder);
	});

	it.each(
		ARMS,
	)("$arm: grants the holder who is signed in as themselves", async ({
		key,
		roleName,
		via,
		resolve,
	}) => {
		// The cost side of the change, and it must be zero. A signed-in role
		// holder's client sends their own membership id (`useEffectiveMember`
		// lets the session win over the localStorage name-pick), so this is what
		// every honest signed-in Toastmaster actually sends.
		await addKeyedSlot(key, roleName, club.memberId);
		const authz = await resolve({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe(via);
		expect(authz.actorMemberId).toBe(club.memberId);
	});

	it.each(
		ARMS,
	)("$arm: refuses a signed-in account with no membership in this club", async ({
		key,
		roleName,
		via,
		resolve,
	}) => {
		// An outsider holding an account is not an anonymous visitor and must
		// not be treated as one: they are exactly the adversary ADR-0026 names,
		// and falling back to the anonymous arm would make holding an account
		// strictly better than not holding one.
		const holder = await addRosterMember(club.clubId, "Real Holder");
		await addKeyedSlot(key, roleName, holder);
		const outsider = await addOutsiderUser();

		const authz = await resolve({
			meetingId: club.meetingId,
			sessionUserId: outsider,
			selfMemberId: holder,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBeNull();

		const anonymous = await resolve({
			meetingId: club.meetingId,
			sessionUserId: null,
			selfMemberId: holder,
		});
		expect(anonymous.allowed).toBe(true);
		expect(anonymous.via).toBe(via);
	});

	it.each(ARMS)("$arm: refuses a READ-ONLY impersonating superadmin", async ({
		key,
		roleName,
		resolve,
	}) => {
		// ADR-0020's read-only mode is write-blind by construction, and a
		// memberless superadmin session hit the self-assert arms before #747 —
		// so the one principal the platform most needs to keep attributable
		// could write under a member's name with `impersonated_by` null.
		const holder = await addRosterMember(club.clubId, "Real Holder");
		await addKeyedSlot(key, roleName, holder);
		const su = await addSuperadminUser();
		await startImpersonation(su, { clubId: club.clubId });

		const authz = await resolve({
			meetingId: club.meetingId,
			sessionUserId: su,
			selfMemberId: holder,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBeNull();
	});

	it.each(
		ARMS,
	)("$arm: a READ_WRITE impersonating superadmin is unaffected", async ({
		key,
		roleName,
		resolve,
	}) => {
		// #246 promises full admin parity under a read_write impersonation, and
		// the admin arm returns BEFORE any self-assert runs — so this arm must
		// not move. Asserted per arm because "the admin arm runs first" is a
		// property of three separate resolvers, not of one.
		const holder = await addRosterMember(club.clubId, "Real Holder");
		await addKeyedSlot(key, roleName, holder);
		const su = await addSuperadminUser();
		await startImpersonation(su, {
			clubId: club.clubId,
			mode: "read_write",
			reason: "fixing the agenda",
		});

		const authz = await resolve({
			meetingId: club.meetingId,
			sessionUserId: su,
			selfMemberId: holder,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
		// Memberless, so `logActivity` stamps the real superadmin instead.
		expect(authz.actorMemberId).toBeNull();
	});

	it("a club admin signed in is still granted via admin, not via a self-assert", async () => {
		// The precedence the whole change rests on: the admin arm returns first, so
		// an admin who ALSO holds the Toastmaster slot is credited as an admin and
		// keeps `canReschedule`. Without this, binding the self-assert could
		// silently demote an admin to the narrower grant on the meetings they run.
		await addKeyedSlot(TMOD_ROLE_KEY, "Toastmaster of the Day", club.memberId);
		await testDb
			.update(members)
			.set({ clubRole: "admin" })
			.where(eq(members.id, club.memberId));
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
		expect(authz.actorMemberId).toBe(club.memberId);
	});
});
