/**
 * `find_people` and a member's preferred contact method (#1093).
 *
 * The tool returns HOW a member wants to be reached (`preferredContact`, the
 * effective value) and never the email or phone that decided it. Those two
 * are read server-side to judge availability; a row here carries both, so a
 * serializer that spread its input, or a reader that passed them through,
 * puts them in the output and fails the raw-text sweep.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { findPeopleTool } = await import("#/server/mcp/tools/find-people");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { toMcpMember } = await import("#/server/mcp/serialize");

const PHONE = "+14155552671";
const PHONE_DIGITS = "4155552671";

interface Row {
	id: string;
	kind: string;
	preferredContact?: string | null;
}

describe.skipIf(!hasTestDb)("find_people: preferredContact (#1093)", () => {
	let seed: SeededClub;
	let token: string;

	function call() {
		return findPeopleTool.handler(
			{ clubId: seed.clubId },
			{ rawToken: token },
		) as Promise<{ people: Row[] }>;
	}

	beforeEach(async () => {
		seed = await seedClub();
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;
		await testDb
			.update(people)
			.set({ phone: PHONE, preferredContact: "sms" })
			.where(eq(people.id, seed.personId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("returns the effective preference and no email or phone", async () => {
		const res = await call();
		const member = res.people.find((p) => p.id === seed.memberId);
		expect(member?.preferredContact).toBe("sms");
		const admin = res.people.find((p) => p.id === seed.adminMemberId);
		expect(admin?.preferredContact).toBeNull();

		const text = JSON.stringify(res);
		expect(text).not.toContain(PHONE_DIGITS);
		expect(text).not.toContain(`member-${seed.memberUserId}@test.example`);
		expect(text).not.toContain(`admin-${seed.adminUserId}@test.example`);
	});

	it("shows no preference once the phone is gone, and sms again when it is back", async () => {
		await testDb
			.update(people)
			.set({ phone: null })
			.where(eq(people.id, seed.personId));
		const gone = await call();
		expect(
			gone.people.find((p) => p.id === seed.memberId)?.preferredContact,
		).toBeNull();

		await testDb
			.update(people)
			.set({ phone: PHONE })
			.where(eq(people.id, seed.personId));
		const back = await call();
		expect(
			back.people.find((p) => p.id === seed.memberId)?.preferredContact,
		).toBe("sms");
	});

	it("toMcpMember drops an email or phone handed to it", () => {
		const out = toMcpMember({
			id: "m1",
			name: "Jane",
			preferredContact: "call",
			// Not on its declared input; a caller spreading a wider row would.
			...{ email: "jane@example.com", phone: PHONE },
		} as Parameters<typeof toMcpMember>[0]);
		expect(Object.keys(out).sort()).toEqual([
			"id",
			"kind",
			"name",
			"preferredContact",
			"preferredName",
		]);
	});
});
