/**
 * DB-backed tests for `set_contact_preference` (#1543).
 *
 * The seeded roster member signs in (people.user_id set), so the members these
 * tests act on are extra, sign-in-less rows minted by `addMember`.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiTokens, members, people } from "#/db/schema";
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
	setContactPreferenceTool,
	NOT_ON_ROSTER_MESSAGE,
	SIGNS_IN_MESSAGE,
	NO_PHONE_MESSAGE,
	NO_EMAIL_MESSAGE,
} = await import("#/server/mcp/tools/set-contact-preference");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const { CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE } = await import(
	"#/lib/preferred-contact"
);

const seeded: SeededClub[] = [];
const extraMemberIds: string[] = [];
afterEach(async () => {
	// A person shared with a second club blocks the club cleanup: drop the
	// extra rows first.
	if (extraMemberIds.length > 0) {
		await testDb
			.delete(members)
			.where(inArray(members.id, extraMemberIds.splice(0)));
	}
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

function call(token: string, input: Record<string, unknown>) {
	return setContactPreferenceTool.handler(input, {
		rawToken: token,
		audience: setContactPreferenceTool.audience,
	});
}

async function outcome(p: Promise<unknown>) {
	try {
		return { ok: true as const, value: await p };
	} catch (e) {
		const err = e as { code?: string; message: string; detail?: unknown };
		return { ok: false as const, code: err.code, message: err.message, err };
	}
}

async function addMember(
	clubId: string,
	opts: {
		name: string;
		email?: string | null;
		phone?: string | null;
		stored?: "email" | "call" | "sms" | "whatsapp" | null;
		by?: "member" | "officer" | null;
		userId?: string | null;
		personId?: string;
	},
) {
	const personId =
		opts.personId ??
		(await seedPerson({
			name: opts.name,
			email: opts.email ?? null,
			phone: opts.phone ?? null,
			userId: opts.userId ?? null,
		}));
	if (opts.stored !== undefined || opts.by !== undefined) {
		await testDb
			.update(people)
			.set({
				preferredContact: opts.stored ?? null,
				contactPreferenceBy: opts.by ?? null,
			})
			.where(eq(people.id, personId));
	}
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name: opts.name,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("no member");
	extraMemberIds.push(row.id);
	return { memberId: row.id, personId };
}

async function personRow(personId: string) {
	const [r] = await testDb
		.select({
			pref: people.preferredContact,
			by: people.contactPreferenceBy,
		})
		.from(people)
		.where(eq(people.id, personId));
	return r;
}

interface PlanBody {
	plan: {
		summary: { wouldChange: number; alreadySet: number; refused: number };
		members: {
			memberId: string;
			verdict: string;
			refusal: { code: string; message: string } | null;
		}[];
	};
	planHash: string;
}

describe.skipIf(!hasTestDb)("set_contact_preference (#1543)", () => {
	async function fixture() {
		const s = await club();
		const foreign = await club();
		const adminToken = await tokenFor(s.adminUserId);
		const change = await addMember(s.clubId, {
			name: "Chang Change",
			email: "chang@example.test",
			phone: "5550001111",
		});
		const same = await addMember(s.clubId, {
			name: "Sam Same",
			email: "sam@example.test",
			stored: "email",
			by: "officer",
		});
		const memberSet = await addMember(s.clubId, {
			name: "Mia Chose",
			email: "mia@example.test",
			stored: "call",
			phone: "5550002222",
			by: "member",
		});
		const noPhone = await addMember(s.clubId, {
			name: "Pat NoPhone",
			email: "pat@example.test",
		});
		const noEmail = await addMember(s.clubId, {
			name: "Eve NoEmail",
			phone: "5550003333",
		});
		const shared = await addMember(s.clubId, {
			name: "Una Shared",
			email: "una@example.test",
		});
		// The same Person also on another club's roster.
		const [other] = await testDb
			.insert(members)
			.values({
				clubId: foreign.clubId,
				personId: shared.personId,
				name: "Una Shared",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!other) throw new Error("no foreign member");
		extraMemberIds.push(other.id);
		return {
			s,
			foreign,
			adminToken,
			change,
			same,
			memberSet,
			noPhone,
			noEmail,
			shared,
		};
	}

	it("previews each verdict and reason and writes nothing", async () => {
		const f = await fixture();
		const ghost = randomUUID();
		const ids = [
			f.change.memberId,
			f.same.memberId,
			f.memberSet.memberId,
			f.noPhone.memberId,
			f.noEmail.memberId,
			f.shared.memberId,
			f.s.memberId, // signs in
			ghost,
		];
		const before = await Promise.all(
			[f.change, f.same, f.memberSet, f.noPhone, f.noEmail, f.shared].map((m) =>
				personRow(m.personId),
			),
		);
		const r = await outcome(
			call(f.adminToken, {
				clubId: f.s.clubId,
				memberIds: ids,
				method: "email",
			}),
		);
		expect(r.ok).toBe(true);
		const body = (r as { value: PlanBody }).value;
		const by = new Map(body.plan.members.map((m) => [m.memberId, m]));
		expect(by.get(f.change.memberId)?.verdict).toBe("would_change");
		expect(by.get(f.same.memberId)?.verdict).toBe("already_set");
		expect(by.get(f.memberSet.memberId)).toMatchObject({
			verdict: "refused",
			refusal: {
				code: "member_set",
				message: CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE,
			},
		});
		expect(by.get(f.shared.memberId)?.refusal?.code).toBe("multi_club");
		expect(by.get(f.s.memberId)).toMatchObject({
			verdict: "refused",
			refusal: { code: "signs_in", message: SIGNS_IN_MESSAGE },
		});
		expect(by.get(ghost)).toMatchObject({
			verdict: "refused",
			refusal: { code: "not_on_roster", message: NOT_ON_ROSTER_MESSAGE },
		});
		expect(body.plan.summary).toEqual({
			wouldChange: 2,
			alreadySet: 1,
			refused: 5,
		});
		// no_email / no_phone via the methods they lack
		const noEmail = await outcome(
			call(f.adminToken, {
				clubId: f.s.clubId,
				memberIds: [f.noEmail.memberId],
				method: "email",
			}),
		);
		expect(
			(noEmail as { value: PlanBody }).value.plan.members[0]?.refusal,
		).toEqual({ code: "no_email", message: NO_EMAIL_MESSAGE });
		const noPhone = await outcome(
			call(f.adminToken, {
				clubId: f.s.clubId,
				memberIds: [f.noPhone.memberId],
				method: "sms",
			}),
		);
		expect(
			(noPhone as { value: PlanBody }).value.plan.members[0]?.refusal,
		).toEqual({ code: "no_phone", message: NO_PHONE_MESSAGE });

		const after = await Promise.all(
			[f.change, f.same, f.memberSet, f.noPhone, f.noEmail, f.shared].map((m) =>
				personRow(m.personId),
			),
		);
		expect(after).toEqual(before);
	});

	it("applies only the would_change members and leaves refused ones untouched", async () => {
		const f = await fixture();
		const input = {
			clubId: f.s.clubId,
			memberIds: [
				f.change.memberId,
				f.same.memberId,
				f.memberSet.memberId,
				f.s.memberId,
			],
			method: "email",
		};
		const preview = (await outcome(call(f.adminToken, input))) as {
			value: PlanBody;
		};
		const applied = await outcome(
			call(f.adminToken, { ...input, planHash: preview.value.planHash }),
		);
		expect(applied.ok).toBe(true);
		const v = (
			applied as {
				value: {
					applied: boolean;
					changed: { memberId: string }[];
					alreadySet: { memberId: string }[];
					refused: { memberId: string }[];
				};
			}
		).value;
		expect(v.applied).toBe(true);
		expect(v.changed.map((m) => m.memberId)).toEqual([f.change.memberId]);
		expect(v.alreadySet.map((m) => m.memberId)).toEqual([f.same.memberId]);
		expect(v.refused.map((m) => m.memberId).sort()).toEqual(
			[f.memberSet.memberId, f.s.memberId].sort(),
		);
		expect(await personRow(f.change.personId)).toEqual({
			pref: "email",
			by: "officer",
		});
		// Member-set preference is never overwritten.
		expect(await personRow(f.memberSet.personId)).toEqual({
			pref: "call",
			by: "member",
		});
		expect(await personRow(f.s.personId)).toEqual({ pref: null, by: null });
	});

	it("does not rename the member it edits", async () => {
		const f = await fixture();
		await testDb
			.update(members)
			.set({ preferredName: "Changy" })
			.where(eq(members.id, f.change.memberId));
		const input = {
			clubId: f.s.clubId,
			memberIds: [f.change.memberId],
			method: "sms",
		};
		const preview = (await outcome(call(f.adminToken, input))) as {
			value: PlanBody;
		};
		await call(f.adminToken, { ...input, planHash: preview.value.planHash });
		const [m] = await testDb
			.select({ name: members.name, preferredName: members.preferredName })
			.from(members)
			.where(eq(members.id, f.change.memberId));
		expect(m).toEqual({ name: "Chang Change", preferredName: "Changy" });
		expect((await personRow(f.change.personId))?.pref).toBe("sms");
	});

	it("none clears an officer-set preference", async () => {
		const f = await fixture();
		const input = {
			clubId: f.s.clubId,
			memberIds: [f.same.memberId],
			method: "none",
		};
		const preview = (await outcome(call(f.adminToken, input))) as {
			value: PlanBody;
		};
		expect(preview.value.plan.members[0]?.verdict).toBe("would_change");
		await call(f.adminToken, { ...input, planHash: preview.value.planHash });
		expect((await personRow(f.same.personId))?.pref).toBeNull();
	});

	it("a stale planHash is PLAN_STALE with a fresh plan, and writes nothing", async () => {
		const f = await fixture();
		const input = {
			clubId: f.s.clubId,
			memberIds: [f.change.memberId],
			method: "email",
		};
		const preview = (await outcome(call(f.adminToken, input))) as {
			value: PlanBody;
		};
		// The member picks their own preference between preview and apply.
		await testDb
			.update(people)
			.set({ preferredContact: "call", contactPreferenceBy: "member" })
			.where(eq(people.id, f.change.personId));
		const r = await outcome(
			call(f.adminToken, { ...input, planHash: preview.value.planHash }),
		);
		expect(r).toMatchObject({ ok: false, code: "PLAN_STALE" });
		const details = (r as unknown as { err: { detail?: PlanBody } }).err.detail;
		expect(details?.plan.members[0]?.refusal?.code).toBe("member_set");
		expect(await personRow(f.change.personId)).toEqual({
			pref: "call",
			by: "member",
		});
	});

	it("refuses a non-officer caller", async () => {
		const f = await fixture();
		const memberToken = await tokenFor(f.s.memberUserId);
		const r = await outcome(
			call(memberToken, {
				clubId: f.s.clubId,
				memberIds: [f.change.memberId],
				method: "email",
			}),
		);
		expect(r).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
		expect(await personRow(f.change.personId)).toEqual({
			pref: null,
			by: null,
		});
	});
});
