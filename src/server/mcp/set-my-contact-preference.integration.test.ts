/**
 * DB-backed tests for `set_my_contact_preference` (#1570), with a real token.
 *
 * Card: protects=a member's agent sets THEIR OWN Person's preferred contact
 * method and nobody else's, marked as the member's own choice, after a preview;
 * fails_when=another Person is written, contact_preference_by is not 'member',
 * a user with no Person or a method with no contact detail is applied, or a
 * stale hash applies; no_claim=the officer tool (its own suite) and the
 * account card's UI.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiTokens, members, people, user as userTable } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// The no-Person test needs a user past the club-membership check, which a user
// with no Person can never be for real (membership resolves through the Person).
const hooks = vi.hoisted(() => ({ eligible: null as null | boolean }));
vi.mock("#/server/connector-eligibility", async (orig) => {
	const m = await orig<typeof import("#/server/connector-eligibility")>();
	return {
		...m,
		mayUseConnector: (userId: string) =>
			hooks.eligible === null ? m.mayUseConnector(userId) : hooks.eligible,
	};
});

const { setMyContactPreferenceTool } = await import(
	"#/server/mcp/tools/set-my-contact-preference"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");
const { NO_LINKED_PERSON_MESSAGE } = await import(
	"#/server/contact-preference-logic"
);
const { CONTACT_METHOD_UNAVAILABLE_MESSAGE } = await import(
	"#/lib/preferred-contact"
);

const seeded: SeededClub[] = [];
const strayUsers: string[] = [];
afterEach(async () => {
	hooks.eligible = null;
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
	for (const id of strayUsers.splice(0)) {
		await testDb.delete(apiTokens).where(eq(apiTokens.userId, id));
		await testDb.delete(userTable).where(eq(userTable.id, id));
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

type Preview = {
	applied: false;
	plan: {
		before: string | null;
		after: string | null;
		refusal: { code: string; message: string } | null;
	};
	planHash: string;
};

const call = (token: string, input: Record<string, unknown>) =>
	setMyContactPreferenceTool.handler(input, {
		rawToken: token,
		audience: "member",
	});

async function person(id: string) {
	const [row] = await testDb
		.select({ pref: people.preferredContact, by: people.contactPreferenceBy })
		.from(people)
		.where(eq(people.id, id));
	return row;
}

async function expectMcpError(p: Promise<unknown>, code: string) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	return err as InstanceType<typeof McpError>;
}

describe.skipIf(!hasTestDb)("set_my_contact_preference (#1570)", () => {
	it("previews before and after without writing, then writes the caller's own Person as 'member'", async () => {
		const s = await club();
		await testDb
			.update(people)
			.set({ email: "me@example.com", phone: "+15550001111" })
			.where(eq(people.id, s.personId));
		const token = await tokenFor(s.memberUserId);
		const p = (await call(token, { preferredContact: "sms" })) as Preview;
		expect(p.plan).toMatchObject({ before: null, after: "sms", refusal: null });
		expect(await person(s.personId)).toMatchObject({ pref: null });

		const out = await call(token, {
			preferredContact: "sms",
			planHash: p.planHash,
		});
		expect(out).toMatchObject({ applied: true, preferredContact: "sms" });
		expect(await person(s.personId)).toEqual({ pref: "sms", by: "member" });

		// null clears it.
		const p2 = (await call(token, { preferredContact: null })) as Preview;
		expect(p2.plan.before).toBe("sms");
		await call(token, { preferredContact: null, planHash: p2.planHash });
		expect((await person(s.personId))?.pref).toBeNull();
	});

	it("writes only the caller's Person, not another member's", async () => {
		const s = await club();
		await testDb
			.update(people)
			.set({ phone: "+15550002222" })
			.where(eq(people.id, s.personId));
		const [admin] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, s.adminMemberId));
		const token = await tokenFor(s.memberUserId);
		const p = (await call(token, { preferredContact: "call" })) as Preview;
		await call(token, { preferredContact: "call", planHash: p.planHash });
		expect((await person(s.personId))?.pref).toBe("call");
		expect(await person(admin?.personId ?? "")).toEqual({
			pref: null,
			by: null,
		});
		expect(
			Object.keys(setMyContactPreferenceTool.config.inputSchema ?? {}).sort(),
		).toEqual(["planHash", "preferredContact"]);
	});

	it("refuses a method with no contact detail, in the preview and the apply", async () => {
		const s = await club();
		await testDb
			.update(people)
			.set({ phone: null })
			.where(eq(people.id, s.personId));
		const token = await tokenFor(s.memberUserId);
		const p = (await call(token, { preferredContact: "sms" })) as Preview;
		expect(p.plan.refusal).toEqual({
			code: "method_unavailable",
			message: CONTACT_METHOD_UNAVAILABLE_MESSAGE,
		});
		await expectMcpError(
			call(token, { preferredContact: "sms", planHash: p.planHash }),
			"BLOCKED",
		);
		expect((await person(s.personId))?.pref).toBeNull();
	});

	it("a user in no open club is FORBIDDEN, in the preview and the apply", async () => {
		const id = randomUUID();
		strayUsers.push(id);
		await testDb.insert(userTable).values({
			id,
			name: "No Club",
			email: `${id}@example.com`,
			emailVerified: true,
		});
		const token = await tokenFor(id);
		await expectMcpError(call(token, { preferredContact: null }), "FORBIDDEN");
		await expectMcpError(
			call(token, { preferredContact: null, planHash: "x" }),
			"FORBIDDEN",
		);
	});

	it("refuses a user with no linked Person, in the preview and the apply", async () => {
		hooks.eligible = true;
		const id = randomUUID();
		strayUsers.push(id);
		await testDb.insert(userTable).values({
			id,
			name: "No Person",
			email: `${id}@example.com`,
			emailVerified: true,
		});
		const token = await tokenFor(id);
		const p = (await call(token, { preferredContact: "email" })) as Preview;
		expect(p.plan.refusal).toEqual({
			code: "no_linked_person",
			message: NO_LINKED_PERSON_MESSAGE,
		});
		await expectMcpError(
			call(token, { preferredContact: "email", planHash: p.planHash }),
			"BLOCKED",
		);
	});

	it("PLAN_STALE when the Person changed since the preview; nothing written", async () => {
		const s = await club();
		await testDb
			.update(people)
			.set({ email: "me@example.com" })
			.where(eq(people.id, s.personId));
		const token = await tokenFor(s.memberUserId);
		const p = (await call(token, { preferredContact: "email" })) as Preview;
		await testDb
			.update(people)
			.set({ preferredContact: "email", contactPreferenceBy: "member" })
			.where(eq(people.id, s.personId));
		// Drift: the stored preference now already equals the target.
		await expectMcpError(
			call(token, { preferredContact: "email", planHash: p.planHash }),
			"PLAN_STALE",
		);
	});
});
