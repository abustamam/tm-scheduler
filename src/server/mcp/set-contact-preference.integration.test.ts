/**
 * DB-backed tests for `set_contact_preference` (#1543).
 *
 * The seeded roster member signs in (people.user_id set); the other members
 * these tests act on are extra, sign-in-less rows minted by `addMember`. Per
 * #1110 a signed-in member who never chose may be set; only their own choice
 * (`contact_preference_by = 'member'`) is protected.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityLog, apiTokens, members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// A seam between the tool's plan and the writer's turn: the apply loop runs up
// to 99 transactions after the plan, so a test needs to move state in that gap.
let beforeApply: (() => Promise<void>) | null = null;
vi.mock("#/server/members-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/members-logic")>();
	return {
		...actual,
		applyContactPreference: async (
			...args: Parameters<typeof actual.applyContactPreference>
		) => {
			await beforeApply?.();
			return actual.applyContactPreference(...args);
		},
	};
});

const {
	setContactPreferenceTool,
	CONTACT_PREF_NOT_ON_ROSTER_MESSAGE,
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
const extraUserIds: string[] = [];
afterEach(async () => {
	beforeApply = null;
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
	if (extraUserIds.length > 0) {
		await testDb.delete(user).where(inArray(user.id, extraUserIds.splice(0)));
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
			f.s.memberId, // signs in, never chose: settable (#1110)
			ghost,
		];
		await testDb
			.update(people)
			.set({ email: "admin-pref@example.test" })
			.where(eq(people.id, f.s.personId));
		const before = await Promise.all(
			[f.change, f.same, f.memberSet, f.noPhone, f.noEmail, f.shared, f.s].map(
				(m) => personRow(m.personId),
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
		expect(by.get(f.s.memberId)?.verdict).toBe("would_change");
		expect(by.get(ghost)).toMatchObject({
			verdict: "refused",
			refusal: {
				code: "not_on_roster",
				message: CONTACT_PREF_NOT_ON_ROSTER_MESSAGE,
			},
		});
		expect(body.plan.summary).toEqual({
			wouldChange: 3,
			alreadySet: 1,
			refused: 4,
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
			[f.change, f.same, f.memberSet, f.noPhone, f.noEmail, f.shared, f.s].map(
				(m) => personRow(m.personId),
			),
		);
		expect(after).toEqual(before);
	});

	it("applies only the would_change members and leaves refused ones untouched", async () => {
		const f = await fixture();
		const input = {
			clubId: f.s.clubId,
			memberIds: [f.change.memberId, f.same.memberId, f.memberSet.memberId],
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
		expect(v.refused.map((m) => m.memberId)).toEqual([f.memberSet.memberId]);
		expect(await personRow(f.change.personId)).toEqual({
			pref: "email",
			by: "officer",
		});
		// Member-set preference is never overwritten.
		expect(await personRow(f.memberSet.personId)).toEqual({
			pref: "call",
			by: "member",
		});
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

	/** Preview, then apply with the plan's hash; the gap hook may move state. */
	async function previewThenApply(
		f: Awaited<ReturnType<typeof fixture>>,
		memberIds: string[],
		method: string,
		gap?: () => Promise<void>,
	) {
		const input = { clubId: f.s.clubId, memberIds, method };
		const preview = (await outcome(call(f.adminToken, input))) as {
			value: PlanBody;
		};
		beforeApply = gap ?? null;
		return outcome(
			call(f.adminToken, { ...input, planHash: preview.value.planHash }),
		);
	}

	type Applied = {
		value: {
			changed: { memberId: string }[];
			refused: { memberId: string; refusal: { code: string } }[];
		};
	};

	it("an apply leaves every refused reason untouched", async () => {
		const f = await fixture();
		const ghost = randomUUID();
		const rows = [f.memberSet, f.shared, f.noPhone, f.noEmail];
		const before = await Promise.all(rows.map((m) => personRow(m.personId)));
		const sms = await previewThenApply(
			f,
			[f.memberSet.memberId, f.shared.memberId, f.noPhone.memberId, ghost],
			"sms",
		);
		const refused = (sms as unknown as Applied).value.refused;
		expect(
			Object.fromEntries(refused.map((r) => [r.memberId, r.refusal.code])),
		).toEqual({
			[f.memberSet.memberId]: "member_set",
			[f.shared.memberId]: "multi_club",
			[f.noPhone.memberId]: "no_phone",
			[ghost]: "not_on_roster",
		});
		const email = await previewThenApply(f, [f.noEmail.memberId], "email");
		expect((email as unknown as Applied).value.refused[0]?.refusal.code).toBe(
			"no_email",
		);
		expect(await Promise.all(rows.map((m) => personRow(m.personId)))).toEqual(
			before,
		);
	});

	it("sets a signed-in member who never chose, as the officer (#1110)", async () => {
		const f = await fixture();
		await testDb
			.update(people)
			.set({ email: "admin-pref@example.test" })
			.where(eq(people.id, f.s.personId));
		const plan = await outcome(
			call(f.adminToken, {
				clubId: f.s.clubId,
				memberIds: [f.s.memberId],
				method: "email",
			}),
		);
		expect((plan as { value: PlanBody }).value.plan.members[0]?.verdict).toBe(
			"would_change",
		);
		const r = await previewThenApply(f, [f.s.memberId], "email");
		expect(r.ok).toBe(true);
		const v = (r as unknown as Applied).value;
		expect(v.changed.map((c) => c.memberId)).toEqual([f.s.memberId]);
		expect(v.refused).toEqual([]);
		expect(await personRow(f.s.personId)).toEqual({
			pref: "email",
			by: "officer",
		});
	});

	it("refuses a signed-in member who chose themself, untouched", async () => {
		const f = await fixture();
		await testDb
			.update(people)
			.set({
				email: "admin-pref@example.test",
				preferredContact: "email",
				contactPreferenceBy: "member",
			})
			.where(eq(people.id, f.s.personId));
		const r = await previewThenApply(f, [f.s.memberId], "email");
		const planOnly = await outcome(
			call(f.adminToken, {
				clubId: f.s.clubId,
				memberIds: [f.s.memberId],
				method: "sms",
			}),
		);
		expect(
			(planOnly as { value: PlanBody }).value.plan.members[0]?.refusal?.code,
		).toBe("member_set");
		expect(r.ok).toBe(true);
		expect(await personRow(f.s.personId)).toEqual({
			pref: "email",
			by: "member",
		});
	});

	it("reports the writer's verdict when it refuses after a clean re-plan", async () => {
		const f = await fixture();
		const r = await previewThenApply(
			f,
			[f.change.memberId],
			"sms",
			async () => {
				// The member sets their own preference after the re-plan.
				await testDb
					.update(people)
					.set({ preferredContact: "call", contactPreferenceBy: "member" })
					.where(eq(people.id, f.change.personId));
			},
		);
		// The hook runs after the hash check, so the hash still matched.
		expect((r as unknown as Applied).value.refused[0]?.refusal.code).toBe(
			"member_set",
		);
		expect(await personRow(f.change.personId)).toEqual({
			pref: "call",
			by: "member",
		});
		// And a vanished phone number is no_phone, the writer's own unavailable.
		const g = await fixture();
		const r2 = await previewThenApply(
			g,
			[g.change.memberId],
			"sms",
			async () => {
				await testDb
					.update(people)
					.set({ phone: null })
					.where(eq(people.id, g.change.personId));
			},
		);
		expect((r2 as unknown as Applied).value.refused[0]?.refusal.code).toBe(
			"no_phone",
		);
	});

	it("rethrows an unexpected writer error instead of reporting a refusal", async () => {
		const f = await fixture();
		const r = await previewThenApply(
			f,
			[f.change.memberId],
			"email",
			async () => {
				throw new Error("connection dropped");
			},
		);
		expect(r).toMatchObject({ ok: false, message: "connection dropped" });
		expect(await personRow(f.change.personId)).toEqual({
			pref: null,
			by: null,
		});
	});

	it("never touches names, even when the member was renamed after the plan", async () => {
		const f = await fixture();
		await testDb
			.update(people)
			.set({ preferredName: null })
			.where(eq(people.id, f.change.personId));
		const r = await previewThenApply(
			f,
			[f.change.memberId],
			"sms",
			async () => {
				await testDb
					.update(members)
					.set({ name: "Renamed Meanwhile", preferredName: "Ren" })
					.where(eq(members.id, f.change.memberId));
				await testDb
					.update(people)
					.set({ preferredName: "Person Ren" })
					.where(eq(people.id, f.change.personId));
			},
		);
		expect((r as unknown as Applied).value.changed).toHaveLength(1);
		const [m] = await testDb
			.select({ name: members.name, preferredName: members.preferredName })
			.from(members)
			.where(eq(members.id, f.change.memberId));
		expect(m).toEqual({ name: "Renamed Meanwhile", preferredName: "Ren" });
		const [p] = await testDb
			.select({ preferredName: people.preferredName })
			.from(people)
			.where(eq(people.id, f.change.personId));
		expect(p?.preferredName).toBe("Person Ren");
		// One member_edit entry, carrying only the preference.
		const logs = await testDb
			.select({ detail: activityLog.detail, actor: activityLog.actorMemberId })
			.from(activityLog)
			.where(eq(activityLog.targetId, f.change.memberId));
		expect(logs).toHaveLength(1);
		expect(logs[0]?.actor).toBe(f.s.adminMemberId);
		expect(logs[0]?.detail).toEqual({
			before: { preferredContact: null },
			after: { preferredContact: "sms" },
		});
	});

	it("the writer's WHERE refuses a signed-in Person who chose themself", async () => {
		const f = await fixture();
		const { applyMemberEdit, ContactPreferenceError } = await import(
			"#/server/members-logic"
		);
		const [signedIn] = await testDb
			.select({ name: members.name })
			.from(members)
			.where(eq(members.id, f.s.memberId));
		await testDb
			.update(people)
			.set({
				email: "admin-pref@example.test",
				preferredContact: "call",
				contactPreferenceBy: "member",
			})
			.where(eq(people.id, f.s.personId));
		const err = await applyMemberEdit({
			clubId: f.s.clubId,
			memberId: f.s.memberId,
			name: signedIn?.name ?? "Admin User",
			preferredContact: "email",
			actorMemberId: f.s.memberId,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ContactPreferenceError);
		expect((err as InstanceType<typeof ContactPreferenceError>).code).toBe(
			"member_set",
		);
		expect(await personRow(f.s.personId)).toEqual({
			pref: "call",
			by: "member",
		});
	});
});
