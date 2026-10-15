/**
 * Mentor requests (#1209), DB-backed: asking a mentor, withdrawing, and the
 * mentor's or an admin's answer, with the refusals each carries.
 *
 * The server fns cannot be invoked from vitest, so the wrapper's gate is held
 * by `mentorship-authz.guard.test.ts` (source) and by calling the logic-level
 * `authorizeMentorRequestDecision` here, which the wrapper calls first.
 * Every test seeds its own club and removes it (`cleanup`).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	members,
	mentorshipRequests,
	mentorships,
	people,
	user,
} from "#/db/schema";
import { orientationView } from "#/lib/orientation";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./mentorship-logic");
const { loadOrientationFacts } = await import("./orientation-logic");

const createdClubs: string[] = [];
const createdUsers: string[] = [];

afterEach(async () => {
	for (const id of createdClubs) await cleanup(id, createdUsers);
	createdClubs.length = 0;
	createdUsers.length = 0;
});

async function seed() {
	const s = await seedClub();
	createdClubs.push(s.clubId);
	createdUsers.push(s.adminUserId, s.memberUserId);
	return s;
}

/** A roster member WITH a sign-in user, so they can act as themselves. */
async function addMember(
	clubId: string,
	opts: {
		name: string;
		willing?: boolean;
		listed?: boolean;
		status?: "active" | "inactive";
		email?: string | null;
		phone?: string | null;
		preferredContact?: "email" | "sms" | null;
	},
) {
	const userId = randomUUID();
	const email =
		opts.email === undefined ? `${userId}@test.example` : opts.email;
	await testDb.insert(user).values({
		id: userId,
		name: opts.name,
		email: `${userId}@login.example`,
		emailVerified: true,
	});
	createdUsers.push(userId);
	const [person] = await testDb
		.insert(people)
		.values({
			name: opts.name,
			email,
			phone: opts.phone === undefined ? "+15555550100" : opts.phone,
			userId,
			preferredContact: opts.preferredContact ?? null,
		})
		.returning({ id: people.id });
	if (!person) throw new Error("fixture");
	const willing = opts.willing ?? true;
	const [m] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: person.id,
			name: opts.name,
			status: opts.status ?? "active",
			willingToMentor: willing,
			mentorListedAt: (opts.listed ?? willing) ? new Date() : null,
		})
		.returning({ id: members.id });
	if (!m) throw new Error("fixture");
	return { id: m.id, userId };
}

const requestsOf = (menteeId: string) =>
	testDb
		.select()
		.from(mentorshipRequests)
		.where(eq(mentorshipRequests.menteeMemberId, menteeId));
const pairingsOf = (mentorId: string, menteeId: string) =>
	testDb
		.select()
		.from(mentorships)
		.where(
			and(
				eq(mentorships.mentorMemberId, mentorId),
				eq(mentorships.menteeMemberId, menteeId),
			),
		);

describe.skipIf(!hasTestDb)("requestMentor (#1209)", () => {
	// protects=an active member asking a willing, listed, active mentor writes
	// exactly one pending request whose mentee is the CALLER (resolved from the
	// session), with focus new_member by default, and the chosen focus and its
	// free text when given;
	// fails_when=no row, a second row, the wrong mentee or club, a default other
	// than new_member, or `other` text kept for a non-other focus;
	// no_claim=the refusals (next tests); the draft (the component test)
	it("writes one pending request, defaulting the focus to new_member", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, { name: "Mia Mentor" });
		const { requestId } = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		const rows = await requestsOf(s.memberId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: requestId,
			clubId: s.clubId,
			menteeMemberId: s.memberId,
			mentorMemberId: mentor.id,
			focus: "new_member",
			focusOther: null,
			status: "pending",
			mentorshipId: null,
			decidedAt: null,
		});

		await testDb
			.update(mentorshipRequests)
			.set({ status: "withdrawn" })
			.where(eq(mentorshipRequests.id, requestId));
		await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			focus: "other",
			focusOther: "  Humor  ",
		});
		const next = (await requestsOf(s.memberId)).find(
			(r) => r.status === "pending",
		);
		expect(next).toMatchObject({ focus: "other", focusOther: "Humor" });
	});

	// protects=a request is refused for the caller themself, for a mentor who is
	// not willing, one who is willing but never confirmed their listing (the
	// Easy-Speak import's flag), and one who is inactive, each with a message the
	// member can read, and NO row is written;
	// fails_when=any of the four writes a pending request, or the self-request
	// reaches the database CHECK instead of the message;
	// no_claim=another club's mentor and an existing pairing (the next test)
	it("refuses self, an unwilling, an unlisted and an inactive mentor", async () => {
		const s = await seed();
		const unwilling = await addMember(s.clubId, {
			name: "Una Unwilling",
			willing: false,
		});
		const unlisted = await addMember(s.clubId, {
			name: "Lia Unlisted",
			willing: true,
			listed: false,
		});
		const inactive = await addMember(s.clubId, {
			name: "Ian Inactive",
			status: "inactive",
		});
		const ask = (mentorMemberId: string) =>
			logic.requestMentor({
				userId: s.memberUserId,
				clubId: s.clubId,
				mentorMemberId,
			});
		await expect(ask(s.memberId)).rejects.toThrow(
			logic.MENTORSHIP_SELF_MESSAGE,
		);
		for (const m of [unwilling, unlisted, inactive]) {
			await expect(ask(m.id)).rejects.toThrow(
				logic.MENTOR_REQUEST_UNAVAILABLE_MESSAGE,
			);
		}
		expect(await requestsOf(s.memberId)).toHaveLength(0);
	});

	// protects=a mentor of ANOTHER club cannot be asked even by id, and a pairing
	// already active on that focus refuses the request, while a different focus
	// with the same mentor is allowed;
	// fails_when=the club check is dropped (cross-club request), the duplicate
	// check ignores the focus, or an ended pairing still blocks;
	// no_claim=that the page offers the other focuses (the component test)
	it("refuses another club's mentor and an active pairing on that focus", async () => {
		const s = await seed();
		const elsewhere = await seed();
		const outsider = await addMember(elsewhere.clubId, { name: "Olga Away" });
		await expect(
			logic.requestMentor({
				userId: s.memberUserId,
				clubId: s.clubId,
				mentorMemberId: outsider.id,
			}),
		).rejects.toThrow(logic.MENTOR_REQUEST_UNAVAILABLE_MESSAGE);

		const mentor = await addMember(s.clubId, { name: "Mia Mentor" });
		await logic.createMentorship({
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			menteeMemberId: s.memberId,
			focus: "new_member",
			actorMemberId: s.adminMemberId,
		});
		await expect(
			logic.requestMentor({
				userId: s.memberUserId,
				clubId: s.clubId,
				mentorMemberId: mentor.id,
			}),
		).rejects.toThrow(logic.MENTORSHIP_DUPLICATE_MESSAGE);
		expect(await requestsOf(s.memberId)).toHaveLength(0);

		await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			focus: "contest",
		});
		expect(await requestsOf(s.memberId)).toHaveLength(1);
	});

	// protects=one pending request per mentee: a second, to the same or another
	// mentor, is refused with "You already have a request waiting..." and no new
	// row; after Withdraw, or a decline, a new one succeeds;
	// fails_when=a second pending row appears, the refusal is the raw unique
	// violation, or Withdraw/decline leaves the slot taken;
	// no_claim=two requests racing at the same instant (the unique index decides
	// that; one INSERT either way)
	it("allows one pending request, freed by withdrawing or a decline", async () => {
		const s = await seed();
		const a = await addMember(s.clubId, { name: "Abe Archer" });
		const b = await addMember(s.clubId, { name: "Bea Bell" });
		const ask = (mentorMemberId: string) =>
			logic.requestMentor({
				userId: s.memberUserId,
				clubId: s.clubId,
				mentorMemberId,
			});
		const first = await ask(a.id);
		await expect(ask(b.id)).rejects.toThrow(
			"You already have a request waiting. Withdraw it to ask someone else.",
		);
		await expect(ask(a.id)).rejects.toThrow(
			logic.MENTOR_REQUEST_PENDING_MESSAGE,
		);
		expect(await requestsOf(s.memberId)).toHaveLength(1);

		await logic.withdrawMentorRequest({
			userId: s.memberUserId,
			requestId: first.requestId,
		});
		const second = await ask(b.id);
		await logic.decideMentorRequest({
			requestId: second.requestId,
			accept: false,
			userId: b.userId,
			actingAs: "mentor",
			actorMemberId: b.id,
		});
		await ask(a.id);
		expect(
			(await requestsOf(s.memberId)).filter((r) => r.status === "pending"),
		).toHaveLength(1);
	});
});

describe.skipIf(!hasTestDb)("decideMentorRequest (#1209)", () => {
	async function pending(over: { mentorWilling?: boolean } = {}) {
		const s = await seed();
		const mentor = await addMember(s.clubId, {
			name: "Mia Mentor",
			willing: over.mentorWilling ?? true,
		});
		const { requestId } = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			focus: "contest",
		});
		return { s, mentor, requestId };
	}

	// protects=the mentor accepting creates ONE mentorships row with the
	// request's focus and the MENTOR as creator, marks the request accepted with
	// that mentorship and the decider, and the mentee's "Get a mentor" item
	// reads done (the request here is new_member, the one focus that ticks it);
	// fails_when=no pairing, a second one, the wrong focus or creator, the request
	// left pending, or the checklist still undone;
	// no_claim=the admin path and the refusals (the next tests)
	it("accept by the mentor pairs them and ticks the checklist", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, { name: "Mia Mentor" });
		const { requestId } = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		const auth = await logic.authorizeMentorRequestDecision(
			mentor.userId,
			requestId,
		);
		expect(auth).toEqual({ actorMemberId: mentor.id, actingAs: "mentor" });
		const out = await logic.decideMentorRequest({
			requestId,
			accept: true,
			userId: mentor.userId,
			actingAs: auth.actingAs,
			actorMemberId: auth.actorMemberId,
		});
		const pairs = await pairingsOf(mentor.id, s.memberId);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({
			clubId: s.clubId,
			focus: "new_member",
			createdByMemberId: mentor.id,
			endedAt: null,
		});
		expect(out).toEqual({ status: "accepted", mentorshipId: pairs[0]?.id });
		const [req] = await requestsOf(s.memberId);
		expect(req).toMatchObject({
			status: "accepted",
			mentorshipId: pairs[0]?.id,
			decidedByMemberId: mentor.id,
		});
		expect(req?.decidedAt).toBeInstanceOf(Date);

		const facts = await loadOrientationFacts(s.memberId);
		if (!facts) throw new Error("no facts");
		const item = orientationView({
			...facts,
			startedAt: new Date(),
		}).items.find((i) => i.key === "get-a-mentor");
		expect(item?.done).toBe(true);
	});

	// protects=an admin who is not the mentor may accept for them (the pairing's
	// created_by is the ADMIN's member id) or decline; a decline writes no
	// pairing and records who declined;
	// fails_when=the admin is refused, the creator is recorded as the mentor, or
	// a decline leaves a mentorships row;
	// no_claim=that a plain member is refused (the next test)
	it("an admin can accept or decline on the mentor's behalf", async () => {
		const { s, mentor, requestId } = await pending();
		const auth = await logic.authorizeMentorRequestDecision(
			s.adminUserId,
			requestId,
		);
		expect(auth.actorMemberId).toBe(s.adminMemberId);
		await logic.decideMentorRequest({
			requestId,
			accept: true,
			userId: s.adminUserId,
			actingAs: auth.actingAs,
			actorMemberId: auth.actorMemberId,
		});
		const [pair] = await pairingsOf(mentor.id, s.memberId);
		expect(pair).toMatchObject({
			focus: "contest",
			createdByMemberId: s.adminMemberId,
		});

		// A second mentee's request, declined by the admin.
		const other = await addMember(s.clubId, { name: "Dee Declined" });
		const { requestId: r2 } = await logic.requestMentor({
			userId: other.userId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		await logic.decideMentorRequest({
			requestId: r2,
			accept: false,
			userId: s.adminUserId,
			actingAs: "admin",
			actorMemberId: s.adminMemberId,
		});
		const [declined] = await requestsOf(other.id);
		expect(declined).toMatchObject({
			status: "declined",
			mentorshipId: null,
			decidedByMemberId: s.adminMemberId,
		});
		expect(await pairingsOf(mentor.id, other.id)).toHaveLength(0);
	});

	// protects=the mentor declining sets declined with no pairing, and the
	// mentee can then ask someone else;
	// fails_when=a decline pairs them, leaves the request pending, or keeps the
	// mentee's one-pending slot taken;
	// no_claim=what the mentee reads afterwards (the component test)
	it("a decline by the mentor records it and frees the mentee to ask again", async () => {
		const { s, mentor, requestId } = await pending();
		await logic.decideMentorRequest({
			requestId,
			accept: false,
			userId: mentor.userId,
			actingAs: "mentor",
			actorMemberId: mentor.id,
		});
		const [req] = await requestsOf(s.memberId);
		expect(req?.status).toBe("declined");
		expect(await pairingsOf(mentor.id, s.memberId)).toHaveLength(0);
		const other = await addMember(s.clubId, { name: "Ned Next" });
		await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: other.id,
		});
	});

	// protects=a member who is neither the request's mentor nor an admin (the
	// mentee, a bystander, a member of another club, someone with no account in
	// the club) and a request that does not exist ALL get "Only the mentor or an
	// admin can answer this request.", and the request is unchanged;
	// fails_when=any of them passes the check, the club is taken from anywhere
	// but the request row (a foreign club's admin would pass), or a missing
	// request answers differently from a stranger;
	// no_claim=that the server fn calls this first (the guard test)
	it("refuses everyone but the mentor and an admin", async () => {
		const { s, requestId } = await pending();
		const bystander = await addMember(s.clubId, { name: "Bo Bystander" });
		const foreign = await seed();
		const MSG = logic.MENTOR_REQUEST_NOT_ALLOWED_MESSAGE;
		for (const userId of [
			s.memberUserId,
			bystander.userId,
			foreign.adminUserId,
			randomUUID(),
		]) {
			await expect(
				logic.authorizeMentorRequestDecision(userId, requestId),
			).rejects.toThrow(MSG);
		}
		await expect(
			logic.authorizeMentorRequestDecision(s.adminUserId, randomUUID()),
		).rejects.toThrow(MSG);
		const [req] = await requestsOf(s.memberId);
		expect(req?.status).toBe("pending");
	});

	// protects=a mentor and an admin accepting at the same instant produce
	// exactly ONE pairing: one call succeeds and the other is told "That request
	// has already been answered.";
	// fails_when=two pairings or a unique-violation message, both calls succeed,
	// or the loser's attempt changes the winner's row;
	// no_claim=which of the two wins (either may)
	it("two concurrent accepts make one pairing", async () => {
		const { s, mentor, requestId } = await pending();
		const results = await Promise.allSettled([
			logic.decideMentorRequest({
				requestId,
				accept: true,
				userId: mentor.userId,
				actingAs: "mentor",
				actorMemberId: mentor.id,
			}),
			logic.decideMentorRequest({
				requestId,
				accept: true,
				userId: s.adminUserId,
				actingAs: "admin",
				actorMemberId: s.adminMemberId,
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const lost = results.find((r) => r.status === "rejected");
		expect((lost as PromiseRejectedResult).reason.message).toBe(
			"That request has already been answered.",
		);
		expect(await pairingsOf(mentor.id, s.memberId)).toHaveLength(1);
	});

	// protects=accepting after an admin already created the SAME active pairing
	// links that row (mentorship_id) instead of inserting a duplicate, and the
	// admin's creator stays on it;
	// fails_when=a second row, a unique-violation message, the request not
	// linked, or the original's creator overwritten;
	// no_claim=a pairing on a different focus (that is a new row)
	it("links an existing active pairing instead of inserting another", async () => {
		const { s, mentor, requestId } = await pending();
		const made = await logic.createMentorship({
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			menteeMemberId: s.memberId,
			focus: "contest",
			actorMemberId: s.adminMemberId,
		});
		const out = await logic.decideMentorRequest({
			requestId,
			accept: true,
			userId: mentor.userId,
			actingAs: "mentor",
			actorMemberId: mentor.id,
		});
		expect(out.mentorshipId).toBe(made.id);
		const pairs = await pairingsOf(mentor.id, s.memberId);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]?.createdByMemberId).toBe(s.adminMemberId);
		const [req] = await requestsOf(s.memberId);
		expect(req).toMatchObject({ status: "accepted", mentorshipId: made.id });
	});

	// protects=accepting while the mentee, or the mentor, is no longer active is
	// refused naming that person ("{name} is no longer an active member."), the
	// request stays pending and no pairing is written, while a DECLINE still
	// works;
	// fails_when=the accept pairs a lapsed member, the message is the generic
	// "Both members must be active", or the refusal consumes the request;
	// no_claim=reactivation restoring the flow (the request simply stays pending)
	it("refuses to accept for a party who is no longer active", async () => {
		const { s, mentor, requestId } = await pending();
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, s.memberId));
		await expect(
			logic.decideMentorRequest({
				requestId,
				accept: true,
				userId: mentor.userId,
				actingAs: "mentor",
				actorMemberId: mentor.id,
			}),
		).rejects.toThrow(`${"Member User"} is no longer an active member.`);

		await testDb
			.update(members)
			.set({ status: "active" })
			.where(eq(members.id, s.memberId));
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, mentor.id));
		await expect(
			logic.decideMentorRequest({
				requestId,
				accept: true,
				userId: s.adminUserId,
				actingAs: "admin",
				actorMemberId: s.adminMemberId,
			}),
		).rejects.toThrow("Mia Mentor is no longer an active member.");
		expect(await pairingsOf(mentor.id, s.memberId)).toHaveLength(0);
		const [req] = await requestsOf(s.memberId);
		expect(req?.status).toBe("pending");

		await logic.decideMentorRequest({
			requestId,
			accept: false,
			userId: s.adminUserId,
			actingAs: "admin",
			actorMemberId: s.adminMemberId,
		});
		expect((await requestsOf(s.memberId))[0]?.status).toBe("declined");
	});

	// protects=a mentor who turned "willing to mentor" off AFTER the request may
	// still accept it: the flag gates NEW requests only;
	// fails_when=the accept re-checks willingness and strands the mentee's
	// pending request;
	// no_claim=that an unlisted mentor can be asked (they cannot)
	it("lets a mentor who stopped being willing still accept", async () => {
		const { s, mentor, requestId } = await pending();
		await testDb
			.update(members)
			.set({ willingToMentor: false, mentorListedAt: null })
			.where(eq(members.id, mentor.id));
		await logic.decideMentorRequest({
			requestId,
			accept: true,
			userId: mentor.userId,
			actingAs: "mentor",
			actorMemberId: mentor.id,
		});
		expect(await pairingsOf(mentor.id, s.memberId)).toHaveLength(1);
	});
});

describe.skipIf(!hasTestDb)("withdrawMentorRequest (#1209)", () => {
	// protects=the mentee withdrawing a pending request sets withdrawn with the
	// mentee as decider; a request already answered, and one withdrawn, is
	// refused "That request has already been answered." (decide after a
	// withdraw likewise); someone else's, and a missing one, are refused as
	// "Only the member who asked..." and nothing changes;
	// fails_when=a decided request is flipped to withdrawn, a withdrawn one can
	// still be accepted, or another member can withdraw it;
	// no_claim=the race between a withdraw and an accept in flight (the same
	// row lock the concurrent-accept test covers)
	it("withdraws only the caller's own pending request, once", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, { name: "Mia Mentor" });
		const { requestId } = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		await expect(
			logic.withdrawMentorRequest({ userId: mentor.userId, requestId }),
		).rejects.toThrow(logic.MENTOR_REQUEST_NOT_YOURS_MESSAGE);
		await expect(
			logic.withdrawMentorRequest({
				userId: s.memberUserId,
				requestId: randomUUID(),
			}),
		).rejects.toThrow(logic.MENTOR_REQUEST_NOT_YOURS_MESSAGE);

		await logic.withdrawMentorRequest({ userId: s.memberUserId, requestId });
		const [req] = await requestsOf(s.memberId);
		expect(req).toMatchObject({
			status: "withdrawn",
			decidedByMemberId: s.memberId,
		});
		await expect(
			logic.withdrawMentorRequest({ userId: s.memberUserId, requestId }),
		).rejects.toThrow("That request has already been answered.");
		await expect(
			logic.decideMentorRequest({
				requestId,
				accept: true,
				userId: mentor.userId,
				actingAs: "mentor",
				actorMemberId: mentor.id,
			}),
		).rejects.toThrow("That request has already been answered.");
		expect(await pairingsOf(mentor.id, s.memberId)).toHaveLength(0);

		const second = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		await logic.decideMentorRequest({
			requestId: second.requestId,
			accept: false,
			userId: mentor.userId,
			actingAs: "mentor",
			actorMemberId: mentor.id,
		});
		await expect(
			logic.withdrawMentorRequest({
				userId: s.memberUserId,
				requestId: second.requestId,
			}),
		).rejects.toThrow("That request has already been answered.");
		expect((await requestsOf(s.memberId)).map((r) => r.status).sort()).toEqual([
			"declined",
			"withdrawn",
		]);
	});
});

describe.skipIf(!hasTestDb)("mentor request readers (#1209)", () => {
	// protects=the mentee reads their LATEST request (any status) with the mentor's
	// name and contact, the mentor reads pending ones with the mentee's contact
	// and effective preferred method (a stored sms with no phone reads null), a
	// request whose mentee went inactive is hidden from the mentor and the admin
	// list, the admin list carries names only, and the mentee still sees their
	// request when the MENTOR went inactive (it holds their one slot);
	// fails_when=a stale request is "latest", contact is missing, a stale
	// preference leaks, an inactive party's request is listed to a mentor, or a
	// mentee is locked out of withdrawing;
	// no_claim=who may call the server fns (the guard test)
	it("shows each side their requests, hiding a lapsed mentee's", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, {
			name: "Mia Mentor",
			email: "mia@example.org",
			phone: "+15555550111",
			preferredContact: "email",
		});
		const mentee2 = await addMember(s.clubId, {
			name: "Sam Smith",
			email: "sam@example.org",
			phone: null,
			preferredContact: "sms",
		});
		const first = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		await logic.withdrawMentorRequest({
			userId: s.memberUserId,
			requestId: first.requestId,
		});
		await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			focus: "leadership",
		});
		await logic.requestMentor({
			userId: mentee2.userId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});

		const mine = await logic.loadMyMentorRequests(s.memberId);
		expect(mine?.outgoing).toMatchObject({
			status: "pending",
			focus: "leadership",
			mentor: {
				id: mentor.id,
				name: "Mia Mentor",
				email: "mia@example.org",
				phone: "+15555550111",
				preferredContact: "email",
			},
		});
		expect(mine?.incoming).toEqual([]);

		const theirs = await logic.loadMyMentorRequests(mentor.id);
		expect(theirs?.outgoing).toBeNull();
		expect(theirs?.incoming.map((r) => r.mentee.name)).toEqual([
			"Member User",
			"Sam Smith",
		]);
		const sam = theirs?.incoming.find((r) => r.mentee.name === "Sam Smith");
		expect(sam?.mentee).toMatchObject({
			email: "sam@example.org",
			phone: null,
			preferredContact: null,
		});

		const club = await logic.loadClubPendingMentorRequests(s.clubId);
		expect(club.map((r) => [r.mentee.name, r.mentor.name])).toEqual([
			["Member User", "Mia Mentor"],
			["Sam Smith", "Mia Mentor"],
		]);
		expect(Object.keys(club[0]?.mentee ?? {}).sort()).toEqual(["id", "name"]);

		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, mentee2.id));
		expect(
			(await logic.loadMyMentorRequests(mentor.id))?.incoming.map(
				(r) => r.mentee.name,
			),
		).toEqual(["Member User"]);
		// The admin list keeps it, flagged, so the admin can decline it (item 7).
		expect(
			(await logic.loadClubPendingMentorRequests(s.clubId)).map((r) => [
				r.mentee.name,
				r.partyInactive,
			]),
		).toEqual([
			["Member User", false],
			["Sam Smith", true],
		]);

		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, mentor.id));
		expect(
			(await logic.loadMyMentorRequests(s.memberId))?.outgoing?.status,
		).toBe("pending");
		expect(await logic.loadMyMentorRequests(randomUUID())).toBeNull();
	});

	// protects=while the mentee has a pending request the orientation facts name
	// the mentor, and the "Get a mentor" hint reads "Waiting for {mentor} to
	// answer." with the item still NOT done; once answered or withdrawn the hint
	// returns to the default;
	// fails_when=the hint ignores the request, ticks the item early, or lingers
	// after a withdraw;
	// no_claim=the checklist's rendering (orientation-checklist tests)
	it("tells the checklist who the member is waiting on", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, { name: "Mia Mentor" });
		const hint = async () => {
			const facts = await loadOrientationFacts(s.memberId);
			if (!facts) throw new Error("no facts");
			return orientationView({ ...facts, startedAt: new Date() }).items.find(
				(i) => i.key === "get-a-mentor",
			);
		};
		expect((await hint())?.hint).toBe(
			"Choose a mentor, or your VP Education will pair you.",
		);
		const { requestId } = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		const waiting = await hint();
		expect(waiting?.hint).toBe("Waiting for Mia Mentor to answer.");
		expect(waiting?.done).toBe(false);
		await logic.withdrawMentorRequest({ userId: s.memberUserId, requestId });
		expect((await hint())?.hint).toBe(
			"Choose a mentor, or your VP Education will pair you.",
		);
	});
});

describe.skipIf(!hasTestDb)("review fixes (#1209)", () => {
	async function pending() {
		const s = await seed();
		const mentor = await addMember(s.clubId, {
			name: "Mia Mentor",
			preferredContact: "email",
		});
		const { requestId } = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			focus: "contest",
		});
		return { s, mentor, requestId };
	}

	// protects=an admin demoted AFTER authorizing but BEFORE the decision runs
	// (the window a queued club lock opens) is refused on accept and on decline,
	// and nothing is written: no pairing, the request still pending;
	// fails_when=the decision commits on the authorization made before the lock;
	// no_claim=the lock queueing itself (the re-check is what is asserted)
	it("refuses an admin who lost the role between authorizing and deciding", async () => {
		const { s, mentor, requestId } = await pending();
		const auth = await logic.authorizeMentorRequestDecision(
			s.adminUserId,
			requestId,
		);
		expect(auth.actingAs).toBe("admin");
		await testDb
			.update(members)
			.set({ clubRole: "member" })
			.where(eq(members.id, s.adminMemberId));
		for (const accept of [true, false]) {
			await expect(
				logic.decideMentorRequest({
					requestId,
					accept,
					userId: s.adminUserId,
					actingAs: auth.actingAs,
					actorMemberId: auth.actorMemberId,
				}),
			).rejects.toThrow(logic.MENTOR_REQUEST_NOT_ALLOWED_MESSAGE);
		}
		expect(await pairingsOf(mentor.id, s.memberId)).toHaveLength(0);
		expect((await requestsOf(s.memberId))[0]?.status).toBe("pending");
	});

	// protects=a mentor deactivated after authorizing is refused the same way, and
	// so is a mentor whose actor id is not the request's mentor;
	// fails_when=an inactive mentor's accept commits, or a different member's id
	// passes as the mentor;
	// no_claim=the admin arm (the previous test)
	it("refuses a mentor who went inactive between authorizing and deciding", async () => {
		const { s, mentor, requestId } = await pending();
		const auth = await logic.authorizeMentorRequestDecision(
			mentor.userId,
			requestId,
		);
		await expect(
			logic.decideMentorRequest({
				requestId,
				accept: true,
				userId: mentor.userId,
				actingAs: "mentor",
				actorMemberId: s.memberId,
			}),
		).rejects.toThrow(logic.MENTOR_REQUEST_NOT_ALLOWED_MESSAGE);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, mentor.id));
		await expect(
			logic.decideMentorRequest({
				requestId,
				accept: false,
				userId: mentor.userId,
				actingAs: auth.actingAs,
				actorMemberId: auth.actorMemberId,
			}),
		).rejects.toThrow(logic.MENTOR_REQUEST_NOT_ALLOWED_MESSAGE);
		expect((await requestsOf(s.memberId))[0]?.status).toBe("pending");
	});

	// protects=when a newer NON-pending row exists (membership collapse can leave
	// a withdrawn one), the mentee's outgoing request is still the pending one,
	// so Withdraw shows;
	// fails_when=outgoing is the newest row regardless of status;
	// no_claim=which non-pending row wins when none is pending (latest, as before)
	it("loadMyMentorRequests prefers a pending request over a newer answered one", async () => {
		const { s, mentor, requestId } = await pending();
		await testDb.insert(mentorshipRequests).values({
			clubId: s.clubId,
			menteeMemberId: s.memberId,
			mentorMemberId: mentor.id,
			focus: "leadership",
			status: "withdrawn",
			createdAt: new Date(Date.now() + 60_000),
		});
		const mine = await logic.loadMyMentorRequests(s.memberId);
		expect(mine?.outgoing?.id).toBe(requestId);
		expect(mine?.outgoing?.status).toBe("pending");
	});

	// protects=a focus note with a NUL is refused with a friendly message at the
	// schema, before Postgres would 500 on it;
	// fails_when=the NUL passes the schema;
	// no_claim=other characters (any text is allowed)
	it("refuses a NUL in the focus note", () => {
		const parsed = logic.requestMentorSchema.safeParse({
			clubId: randomUUID(),
			mentorMemberId: randomUUID(),
			focus: "other",
			focusOther: "a\u0000b",
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toBe(
			logic.MENTOR_FOCUS_OTHER_NUL_MESSAGE,
		);
	});

	// protects=a request id that does not exist, one in a club the caller is not
	// in, and a stranger's all answer withdraw with the same message;
	// fails_when=a member of another club, or someone with no account there, is
	// told anything different from "no such request";
	// no_claim=the mentee's own withdraw (covered above)
	it("withdraw answers a foreign club's request like a missing one", async () => {
		const { requestId } = await pending();
		const foreign = await seed();
		for (const userId of [
			foreign.memberUserId,
			foreign.adminUserId,
			randomUUID(),
		]) {
			await expect(
				logic.withdrawMentorRequest({ userId, requestId }),
			).rejects.toThrow(logic.MENTOR_REQUEST_NOT_YOURS_MESSAGE);
		}
	});

	// protects=requestMentor hands back the mentor's contact (name, email, phone,
	// effective preferred method) so the draft needs no second read;
	// fails_when=the contact is missing, the raw column is returned, or it names
	// someone other than the asked mentor;
	// no_claim=the formatting of the draft (the component test)
	it("requestMentor returns the mentor's contact", async () => {
		const { mentor, s } = await pending();
		const other = await addMember(s.clubId, {
			name: "Ned Next",
			phone: null,
			preferredContact: null,
		});
		await logic.withdrawMentorRequest({
			userId: s.memberUserId,
			requestId: (await requestsOf(s.memberId))[0]?.id ?? "",
		});
		const out = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: mentor.id,
		});
		expect(out.mentor).toMatchObject({
			id: mentor.id,
			name: "Mia Mentor",
			phone: "+15555550100",
			preferredContact: "email",
		});
		expect(out.mentor.email).toContain("@test.example");
		await logic.withdrawMentorRequest({
			userId: s.memberUserId,
			requestId: out.requestId,
		});
		const second = await logic.requestMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			mentorMemberId: other.id,
		});
		expect(second.mentor.phone).toBeNull();
		expect(second.mentor.preferredContact).toBeNull();
	});

	// protects=a mentor's "Your mentees" rows carry the mentee's EFFECTIVE
	// preferred contact, judged on what the mentee has stored;
	// fails_when=the field is absent or the raw column leaks through;
	// no_claim=the welcome draft's text (the component test)
	it("a pairing's other party carries preferredContact", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, { name: "Mia Mentor" });
		const mentee = await addMember(s.clubId, {
			name: "Eli Mentee",
			preferredContact: "sms",
		});
		await logic.createMentorship({
			clubId: s.clubId,
			mentorMemberId: mentor.id,
			menteeMemberId: mentee.id,
			focus: "new_member",
			actorMemberId: s.adminMemberId,
		});
		const mine = await logic.loadMyMentorships(mentor.id);
		expect(mine?.mentees[0]?.member.preferredContact).toBe("sms");
	});

	// protects=the admin's list keeps a pending request whose party went inactive,
	// flagged, so it can be declined; an all-active one is unflagged;
	// fails_when=the row vanishes (the mentee's slot stays taken with no way to
	// clear it) or the flag is missing;
	// no_claim=that accept works for it (it is refused, tests above)
	it("the admin list flags a pending request with an inactive party", async () => {
		const { s, mentor, requestId } = await pending();
		const before = await logic.loadClubPendingMentorRequests(s.clubId);
		expect(before.map((r) => [r.id, r.partyInactive])).toEqual([
			[requestId, false],
		]);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, mentor.id));
		const after = await logic.loadClubPendingMentorRequests(s.clubId);
		expect(after.map((r) => [r.id, r.partyInactive])).toEqual([
			[requestId, true],
		]);
	});
});
