/**
 * Every server fn in `history-import.ts` admits a superadmin or an admin of THAT
 * club and refuses everyone else (#1051, #1492), and the fns that write refuse a
 * read-only impersonation session.
 *
 * Runs the REAL handlers through the same minimal `createServerFn` adapter
 * `areas-authz.integration.test.ts` uses, with the cookie -> session lookup
 * faked and nothing else: `requireUser` and `requireSuperadmin` run for real.
 * The control is the superadmin, who gets through, so a refusal cannot be a
 * harness that refuses everything.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { count, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubImports,
	clubs,
	impersonationSessions,
	meetings,
	members,
	officerTerms,
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
const {
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	mayRunHistoryImport,
	requireHistoryImportRunner,
} = await import("./guards");
const { runnerAttribution, storeEasySpeakBundle } = await import(
	"./history-import-logic"
);

type Fn = (input: { data: unknown }) => Promise<unknown>;

describe.skipIf(!hasTestDb)("history-import.ts authorization (#1051)", () => {
	let seed: SeededClub;
	let otherSeed: SeededClub | null = null;
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
		if (otherSeed) {
			await cleanup(otherSeed.clubId, [
				otherSeed.adminUserId,
				otherSeed.memberUserId,
			]);
			otherSeed = null;
		}
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
	])("%s refuses a signed-in non-member", async (name) => {
		await expect(calls(seed.clubId)[name]?.()).rejects.toThrow(
			NOT_A_MEMBER_MESSAGE,
		);
	});

	/** What each fn says once it is PAST the gate, for an import id that does not exist. */
	const PAST_THE_GATE: Record<string, RegExp | "list"> = {
		listEasySpeakImports: "list",
		uploadEasySpeakBundle: /not an Easy-Speak bundle/i,
		previewEasySpeakImport: /not found/i,
		applyEasySpeakImport: /not found/i,
		importEasySpeakSpeechRequests: /not found/i,
		importEasySpeakMentors: /not found/i,
	};

	async function expectAdmitted(name: string) {
		const outcome = PAST_THE_GATE[name];
		if (outcome === "list") {
			await expect(calls(seed.clubId)[name]?.()).resolves.toEqual([]);
		} else {
			await expect(calls(seed.clubId)[name]?.()).rejects.toThrow(outcome);
		}
	}

	async function expectRefused(name: string, message: string | RegExp) {
		await expect(calls(seed.clubId)[name]?.()).rejects.toThrow(message);
	}

	// protects=a club's own admin, and a member holding an open officer term (the
	// effective-admin arm), run the import for their club through all six fns;
	// fails_when=any fn still demands a superadmin, or admits through a different
	// rule than requireClubRole;
	// no_claim=what the logic then does (the logic integration tests).
	it.each(
		Object.keys(PAST_THE_GATE),
	)("%s admits the club's own admin", async (name) => {
		sessionUserId = seed.adminUserId;
		await expectAdmitted(name);
	});

	it.each(
		Object.keys(PAST_THE_GATE),
	)("%s admits an open officer term (effective admin)", async (name) => {
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(),
			termEnd: null,
		});
		sessionUserId = seed.memberUserId;
		await expectAdmitted(name);
	});

	// protects=a plain member, an admin of ANOTHER club and a former member are
	// refused by every fn with requireClubRole's own sentence, and the answer
	// does not name the club they asked about;
	// fails_when=the gate checks "an admin somewhere" instead of "this club";
	// no_claim=none beyond protects.
	it.each(
		Object.keys(PAST_THE_GATE),
	)("%s refuses a plain member, another club's admin, and a former member", async (name) => {
		sessionUserId = seed.memberUserId;
		await expectRefused(name, NO_PERMISSION_MESSAGE);
		otherSeed = await seedClub();
		sessionUserId = otherSeed.adminUserId;
		await expectRefused(name, NOT_A_MEMBER_MESSAGE);
		await testDb
			.update(members)
			.set({ status: "former" })
			.where(eq(members.id, seed.adminMemberId));
		sessionUserId = seed.adminUserId;
		await expectRefused(name, NOT_A_MEMBER_MESSAGE);
	});

	// protects=an archived club takes no import from its admin (ADR-0016);
	// fails_when=the gate drops the archive check;
	// no_claim=a superadmin's own handling of an archived club (the logic's).
	it.each(
		Object.keys(PAST_THE_GATE),
	)("%s refuses an admin of an archived club", async (name) => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		sessionUserId = seed.adminUserId;
		await expectRefused(name, /archived/i);
	});

	// protects=mayRunHistoryImport answers true exactly where the gate passes, for
	// every case above (it is the same function, caught);
	// fails_when=the affordance and the gate drift apart;
	// no_claim=none beyond protects.
	it("mayRunHistoryImport agrees with the gate for every case", async () => {
		expect(await mayRunHistoryImport(superadminId, seed.clubId)).toBe(true);
		expect(await mayRunHistoryImport(seed.adminUserId, seed.clubId)).toBe(true);
		expect(await mayRunHistoryImport(seed.memberUserId, seed.clubId)).toBe(
			false,
		);
		expect(await mayRunHistoryImport(memberUserId, seed.clubId)).toBe(false);
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(),
			termEnd: null,
		});
		expect(await mayRunHistoryImport(seed.memberUserId, seed.clubId)).toBe(
			true,
		);
		otherSeed = await seedClub();
		expect(await mayRunHistoryImport(otherSeed.adminUserId, seed.clubId)).toBe(
			false,
		);
		await testDb
			.update(members)
			.set({ status: "former" })
			.where(eq(members.id, seed.adminMemberId));
		expect(await mayRunHistoryImport(seed.adminUserId, seed.clubId)).toBe(
			false,
		);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		expect(await mayRunHistoryImport(seed.memberUserId, seed.clubId)).toBe(
			false,
		);
	});

	// protects=a club admin's overrideClubBinding: true is refused BEFORE any logic
	// runs, shown with a VALID bundle and a REAL stored import: nothing is stored
	// by the upload, the stored import is not applied and no meeting is written;
	// a superadmin's flag reaches the logic;
	// fails_when=the flag is passed down for a non-superadmin (the valid bundle
	// would then be stored / applied);
	// no_claim=what the override then does (the logic integration test).
	it("refuses a club admin's binding override before the logic, and passes a superadmin's", async () => {
		const text = readFileSync(
			resolve(
				__dirname,
				"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
			),
			"utf8",
		);
		const stored = await storeEasySpeakBundle({
			clubId: seed.clubId,
			uploadedByUserId: superadminId,
			text,
		});
		const imports = async () =>
			testDb
				.select({ id: clubImports.id, appliedAt: clubImports.appliedAt })
				.from(clubImports)
				.where(eq(clubImports.clubId, seed.clubId));
		const meetingCount = async () =>
			(
				await testDb
					.select({ id: meetings.id })
					.from(meetings)
					.where(eq(meetings.clubId, seed.clubId))
			).length;
		const importsBefore = await imports();
		const meetingsBefore = await meetingCount();
		expect(importsBefore).toEqual([{ id: stored.importId, appliedAt: null }]);
		sessionUserId = seed.adminUserId;
		const refusal =
			/Only GavelUp support can import a bundle from another Easy-Speak club/;
		await expect(
			(fns.uploadEasySpeakBundle as Fn)({
				data: {
					clubId: seed.clubId,
					text,
					overrideClubBinding: true,
				},
			}),
		).rejects.toThrow(refusal);
		await expect(
			(fns.applyEasySpeakImport as Fn)({
				data: {
					clubId: seed.clubId,
					importId: stored.importId,
					planHash: "0".repeat(64),
					overrideClubBinding: true,
				},
			}),
		).rejects.toThrow(refusal);
		expect(await imports()).toEqual(importsBefore);
		expect(await meetingCount()).toBe(meetingsBefore);
		sessionUserId = superadminId;
		await expect(
			(fns.applyEasySpeakImport as Fn)({
				data: {
					clubId: seed.clubId,
					importId: stored.importId,
					planHash: "0".repeat(64),
					overrideClubBinding: true,
				},
			}),
		).rejects.toThrow(/Preview again/i);
	});

	// protects=a READ-WRITE impersonation session is admitted by all six fns, and it
	// resolves as the superadmin (kind "superadmin", credited through
	// impersonatedBy), not as an admin with a member id;
	// fails_when=the superadmin arm is not asked first, or a fn admits through a
	// different rule;
	// no_claim=a read-only session (the tests below refuse it).
	it.each(
		Object.keys(PAST_THE_GATE),
	)("%s admits a read-write impersonation session", async (name) => {
		sessionUserId = superadminId;
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: seed.clubId,
			mode: "read_write",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await expectAdmitted(name);
		const runner = await requireHistoryImportRunner(superadminId, seed.clubId);
		expect(runner).toEqual({ kind: "superadmin", userId: superadminId });
		expect(runnerAttribution(runner)).toEqual({
			actorMemberId: null,
			impersonatedBy: superadminId,
		});
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
