/**
 * Every server fn in `history-import.ts` refuses a signed-in non-superadmin, and
 * `apply` refuses a read-only impersonation session (#1051).
 *
 * Runs the REAL handlers through the same minimal `createServerFn` adapter
 * `areas-authz.integration.test.ts` uses, with the cookie -> session lookup
 * faked and nothing else: `requireUser` and `requireSuperadmin` run for real.
 * The control is the superadmin, who gets through, so a refusal cannot be a
 * harness that refuses everything.
 */
import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubImports,
	impersonationSessions,
	meetings,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
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

const fns = await import("./history-import");
const { NO_PERMISSION_MESSAGE } = await import("./guards");

type Fn = (input: { data: unknown }) => Promise<unknown>;

describe.skipIf(!hasTestDb)("history-import.ts authorization (#1051)", () => {
	let seed: SeededClub;
	let memberUserId: string;
	let superadminId: string;
	const userIds: string[] = [];

	async function makeUser(isSuperadmin: boolean) {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "",
			email: `history-import-${id}@test.example`,
			emailVerified: true,
			isSuperadmin,
		});
		userIds.push(id);
		return id;
	}

	const calls = (clubId: string): Record<string, () => Promise<unknown>> => ({
		listEasySpeakImports: () =>
			(fns.listEasySpeakImports as Fn)({ data: { clubId } }),
		uploadEasySpeakBundle: () =>
			(fns.uploadEasySpeakBundle as Fn)({ data: { clubId, text: "{}" } }),
		previewEasySpeakImport: () =>
			(fns.previewEasySpeakImport as Fn)({
				data: { clubId, importId: randomUUID() },
			}),
		applyEasySpeakImport: () =>
			(fns.applyEasySpeakImport as Fn)({
				data: { clubId, importId: randomUUID(), planHash: "0".repeat(64) },
			}),
		importEasySpeakSpeechRequests: () =>
			(fns.importEasySpeakSpeechRequests as Fn)({
				data: { clubId, importId: randomUUID() },
			}),
		importEasySpeakMentors: () =>
			(fns.importEasySpeakMentors as Fn)({
				data: { clubId, importId: randomUUID() },
			}),
	});

	beforeEach(async () => {
		seed = await seedClub();
		memberUserId = await makeUser(false);
		superadminId = await makeUser(true);
		sessionUserId = memberUserId;
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await testDb
			.delete(impersonationSessions)
			.where(inArray(impersonationSessions.superadminUserId, userIds));
		await testDb.delete(user).where(inArray(user.id, userIds));
		userIds.length = 0;
	});

	it("covers every fn the module exports", () => {
		expect(Object.keys(calls(seed.clubId)).sort()).toEqual(
			Object.keys(fns).sort(),
		);
	});

	it.each([
		"listEasySpeakImports",
		"uploadEasySpeakBundle",
		"previewEasySpeakImport",
		"applyEasySpeakImport",
		"importEasySpeakSpeechRequests",
		"importEasySpeakMentors",
	])("%s refuses a signed-in non-superadmin", async (name) => {
		await expect(calls(seed.clubId)[name]?.()).rejects.toThrow(
			NO_PERMISSION_MESSAGE,
		);
	});

	it("refuses the club's own admin: this is not a club-admin tool", async () => {
		sessionUserId = seed.adminUserId;
		await expect(calls(seed.clubId).uploadEasySpeakBundle?.()).rejects.toThrow(
			NO_PERMISSION_MESSAGE,
		);
	});

	it("a refused upload stores nothing", async () => {
		await expect(
			calls(seed.clubId).uploadEasySpeakBundle?.(),
		).rejects.toThrow();
		const [row] = await testDb
			.select({ n: count() })
			.from(clubImports)
			.where(eq(clubImports.clubId, seed.clubId));
		expect(Number(row?.n)).toBe(0);
	});

	it("lets the superadmin through (the control): the list is empty, not refused", async () => {
		sessionUserId = superadminId;
		await expect(calls(seed.clubId).listEasySpeakImports?.()).resolves.toEqual(
			[],
		);
	});

	it("refuses an upload under a read-only impersonation, and stores nothing; without it the upload reaches the logic", async () => {
		sessionUserId = superadminId;
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: seed.clubId,
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await expect(calls(seed.clubId).uploadEasySpeakBundle?.()).rejects.toThrow(
			/read-only impersonation/i,
		);
		// Without the session the same call gets past the gate and the LOGIC refuses
		// the empty object: the gate, not the harness, refused above.
		await testDb
			.delete(impersonationSessions)
			.where(eq(impersonationSessions.superadminUserId, superadminId));
		await expect(calls(seed.clubId).uploadEasySpeakBundle?.()).rejects.toThrow(
			/not an Easy-Speak bundle/i,
		);
		const [row] = await testDb
			.select({ n: count() })
			.from(clubImports)
			.where(eq(clubImports.clubId, seed.clubId));
		expect(Number(row?.n)).toBe(0);
	});

	it("refuses apply under a read-only impersonation, and applies under none", async () => {
		sessionUserId = superadminId;
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: seed.clubId,
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await expect(calls(seed.clubId).applyEasySpeakImport?.()).rejects.toThrow(
			/read-only impersonation/i,
		);
		// Without the session the same call gets past the gate and fails on the
		// unknown import id instead: the gate, not the harness, refused above.
		await testDb
			.delete(impersonationSessions)
			.where(eq(impersonationSessions.superadminUserId, superadminId));
		await expect(calls(seed.clubId).applyEasySpeakImport?.()).rejects.toThrow(
			/not found/i,
		);
		const rows = await testDb
			.select({ id: meetings.id })
			.from(meetings)
			.where(eq(meetings.clubId, seed.clubId));
		expect(rows).toHaveLength(1);
	});

	it("refuses the speech-request import under a read-only impersonation, and imports under none (#1052)", async () => {
		sessionUserId = superadminId;
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: seed.clubId,
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await expect(
			calls(seed.clubId).importEasySpeakSpeechRequests?.(),
		).rejects.toThrow(/read-only impersonation/i);
		// Without the session the same call gets past the gate and fails on the
		// unknown import id: the gate, not the harness, refused above.
		await testDb
			.delete(impersonationSessions)
			.where(eq(impersonationSessions.superadminUserId, superadminId));
		await expect(
			calls(seed.clubId).importEasySpeakSpeechRequests?.(),
		).rejects.toThrow(/not found/i);
	});

	it("refuses the mentor import under a read-only impersonation, and imports under none (#1053)", async () => {
		sessionUserId = superadminId;
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: seed.clubId,
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await expect(calls(seed.clubId).importEasySpeakMentors?.()).rejects.toThrow(
			/read-only impersonation/i,
		);
		// Without the session the same call gets past the gate and fails on the
		// unknown import id: the gate, not the harness, refused above.
		await testDb
			.delete(impersonationSessions)
			.where(eq(impersonationSessions.superadminUserId, superadminId));
		await expect(calls(seed.clubId).importEasySpeakMentors?.()).rejects.toThrow(
			/not found/i,
		);
	});
});
