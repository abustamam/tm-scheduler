/**
 * The speech-request step of the Easy-Speak import, against the test database
 * (#1052). Each test is an acceptance criterion or a branch of
 * `importSpeechRequests`: the bundle's open requests become queue rows, once.
 *
 * Run with:
 *   bunx vitest run src/server/speech-requests-import.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubImports,
	importRefs,
	members,
	people,
	speechRequests,
	user,
} from "#/db/schema";
import type { EasySpeakBundleV1 } from "#/lib/easy-speak-bundle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./history-import-logic");

const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);

type Request = EasySpeakBundleV1["speechRequests"][number];

function request(over: Partial<Request> & { es: string }): Request {
	const { es, ...rest } = over;
	return {
		esSpeechId: null,
		who: { esUserId: es, name: `Person ${es}` },
		title: "A speech",
		path: null,
		project: null,
		introduction: null,
		requestedOn: "2025-04-23",
		preferred: [null, null, null],
		scheduledOn: null,
		status: "requested",
		...rest,
	};
}

describe.skipIf(!hasTestDb)("speech-request import (#1052)", () => {
	let seed: SeededClub;
	let superadminId: string;
	const extraUsers: string[] = [];

	beforeEach(async () => {
		seed = await seedClub();
		superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		extraUsers.push(superadminId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await testDb.delete(user).where(inArray(user.id, extraUsers.splice(0)));
	});

	/** A club member the import's apply is taken to have resolved from `es`. */
	async function resolvedMember(es: string): Promise<string> {
		const [person] = await testDb
			.insert(people)
			.values({ name: `Person ${es}` })
			.returning({ id: people.id });
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: person?.id as string,
				name: `Person ${es}`,
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		await testDb.insert(importRefs).values({
			clubId: seed.clubId,
			source: "easy_speak",
			kind: "person",
			sourceId: `es:${es}`,
			targetId: member?.id as string,
		});
		return member?.id as string;
	}

	async function storeBundle(
		requests: Request[],
		appliedAt: Date | null = new Date(),
	): Promise<string> {
		const base = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
		const [row] = await testDb
			.insert(clubImports)
			.values({
				clubId: seed.clubId,
				source: "easy_speak",
				bundle: { ...base, speechRequests: requests },
				bundleSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
				uploadedByUserId: superadminId,
				appliedAt,
			})
			.returning({ id: clubImports.id });
		return row?.id as string;
	}

	function run(importId: string) {
		return logic.importSpeechRequests({
			clubId: seed.clubId,
			importId,
			superadminUserId: superadminId,
		});
	}

	async function rows() {
		return testDb
			.select()
			.from(speechRequests)
			.where(eq(speechRequests.clubId, seed.clubId));
	}

	it("AC3: imports exactly the bundle's requested requests as open rows", async () => {
		const a = await resolvedMember("1");
		const b = await resolvedMember("2");
		const importId = await storeBundle([
			request({ es: "1", esSpeechId: "sr-1", title: "  First  " }),
			request({ es: "2", path: "Dynamic Leadership", project: "Icebreaker" }),
			request({ es: "1", esSpeechId: "sr-3", status: "requested" }),
			request({ es: "2", esSpeechId: "sr-4", status: "scheduled" }),
			request({ es: "1", esSpeechId: "sr-5", status: "completed" }),
		]);

		const result = await run(importId);

		expect(result).toEqual({
			total: 5,
			imported: 3,
			alreadyImported: 0,
			skippedScheduled: 1,
			skippedCompleted: 1,
			skippedUnknownStatus: 0,
			skippedNoMember: 0,
		});
		const stored = await rows();
		expect(stored).toHaveLength(3);
		expect(stored.every((r) => r.status === "open")).toBe(true);
		expect(stored.every((r) => r.scheduledSlotId === null)).toBe(true);
		expect(stored.map((r) => r.membershipId).sort()).toEqual([a, a, b].sort());
		expect(stored.map((r) => r.title)).toContain("First");
		const second = stored.find((r) => r.membershipId === b);
		expect(second?.path).toBe("Dynamic Leadership");
		expect(second?.projectName).toBe("Icebreaker");
		// The request date is kept as the row's creation time.
		expect(second?.createdAt.toISOString()).toBe("2025-04-23T12:00:00.000Z");
	});

	it("a second run adds nothing and reports every row as already imported", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([
			request({ es: "1", esSpeechId: "sr-1" }),
			request({ es: "2" }),
			// An unkeyed twin of the one above: numbered, not collapsed.
			request({ es: "2" }),
		]);

		const first = await run(importId);
		expect(first.imported).toBe(3);
		const ids = (await rows()).map((r) => r.id).sort();

		const again = await run(importId);
		expect(again.imported).toBe(0);
		expect(again.alreadyImported).toBe(3);
		expect((await rows()).map((r) => r.id).sort()).toEqual(ids);
		const refs = await testDb
			.select()
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, "speech_request"),
				),
			);
		expect(refs).toHaveLength(3);
		expect(new Set(refs.map((r) => r.sourceId)).size).toBe(3);
		expect(refs.filter((r) => r.sourceId.startsWith("anon:")).length).toBe(2);
	});

	it("skips scheduled, completed and unknown statuses, counting each", async () => {
		await resolvedMember("1");
		const importId = await storeBundle([
			request({ es: "1", esSpeechId: "s1", status: "scheduled" }),
			request({ es: "1", esSpeechId: "s2", status: "scheduled" }),
			request({ es: "1", esSpeechId: "s3", status: "completed" }),
			request({ es: "1", esSpeechId: "s4", status: "Requested " }),
			request({ es: "1", esSpeechId: "s5", status: "mystery" }),
		]);

		const result = await run(importId);

		expect(result).toMatchObject({
			total: 5,
			imported: 1,
			skippedScheduled: 2,
			skippedCompleted: 1,
			skippedUnknownStatus: 1,
			skippedNoMember: 0,
		});
		expect(await rows()).toHaveLength(1);
	});

	it("skips a requester who did not resolve to a member still in the club", async () => {
		await resolvedMember("1");
		// A person ref pointing at a membership that no longer exists.
		await testDb.insert(importRefs).values({
			clubId: seed.clubId,
			source: "easy_speak",
			kind: "person",
			sourceId: "es:3",
			targetId: randomUUID(),
		});
		const importId = await storeBundle([
			request({ es: "1", esSpeechId: "k1" }),
			// No ref at all: a guest or someone the apply skipped.
			request({ es: "2", esSpeechId: "k2" }),
			// A stale ref.
			request({ es: "3", esSpeechId: "k3" }),
		]);

		const result = await run(importId);

		expect(result).toMatchObject({ imported: 1, skippedNoMember: 2 });
		expect(await rows()).toHaveLength(1);
		// A skipped request leaves no ref behind, so it imports once resolvable.
		const refs = await testDb
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, "speech_request"),
				),
			);
		expect(refs.map((r) => r.sourceId)).toEqual(["k1"]);
	});

	it("refuses an import that has not been applied", async () => {
		await resolvedMember("1");
		const importId = await storeBundle(
			[request({ es: "1", esSpeechId: "k1" })],
			null,
		);

		await expect(run(importId)).rejects.toThrow(
			logic.IMPORT_NOT_APPLIED_MESSAGE,
		);
		expect(await rows()).toHaveLength(0);
	});

	it("refuses an import that belongs to another club", async () => {
		await resolvedMember("1");
		const importId = await storeBundle([request({ es: "1" })]);
		const other = await seedClub();
		try {
			await expect(
				logic.importSpeechRequests({
					clubId: other.clubId,
					importId,
					superadminUserId: superadminId,
				}),
			).rejects.toThrow();
			const stray = await testDb
				.select()
				.from(speechRequests)
				.where(eq(speechRequests.clubId, other.clubId));
			expect(stray).toHaveLength(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("normalises preferred dates: capped at three, de-duplicated, real days only", async () => {
		await resolvedMember("1");
		const importId = await storeBundle([
			request({
				es: "1",
				esSpeechId: "d1",
				preferred: [
					"2026-11-04",
					null,
					"2026-11-04",
					"2026-11-11",
					"2026-11-18",
					"2026-11-25",
				],
			}),
			request({ es: "1", esSpeechId: "d2", preferred: [null, null, null] }),
		]);

		await run(importId);

		const stored = await rows();
		const withDates = stored.find((r) => r.preferredDates.length > 0);
		expect(withDates?.preferredDates).toEqual([
			"2026-11-04",
			"2026-11-11",
			"2026-11-18",
		]);
		expect(stored.find((r) => r.preferredDates.length === 0)).toBeDefined();
	});

	it("does not bring back a request a human withdrew or deleted after the import", async () => {
		await resolvedMember("1");
		const importId = await storeBundle([
			request({ es: "1", esSpeechId: "w1" }),
			request({ es: "1", esSpeechId: "w2" }),
		]);
		await run(importId);
		const [one, two] = await rows();
		await testDb
			.update(speechRequests)
			.set({ status: "withdrawn" })
			.where(eq(speechRequests.id, one?.id as string));
		await testDb
			.delete(speechRequests)
			.where(eq(speechRequests.id, two?.id as string));

		const again = await run(importId);

		expect(again).toMatchObject({ imported: 0, alreadyImported: 2 });
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.status).toBe("withdrawn");
	});

	it("logs one history_imported entry for the step, attributed to the superadmin", async () => {
		await resolvedMember("1");
		const importId = await storeBundle([
			request({ es: "1", esSpeechId: "l1" }),
			request({ es: "1", esSpeechId: "l2", status: "scheduled" }),
		]);

		await run(importId);

		const entries = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "history_imported"),
				),
			);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.impersonatedBy).toBe(superadminId);
		expect(entries[0]?.actorMemberId).toBeNull();
		expect(entries[0]?.detail).toMatchObject({
			importId,
			step: "speech_requests",
			counts: { total: 2, imported: 1, skippedScheduled: 1 },
		});
	});

	it("validates the server-fn input: a club id and an import id", () => {
		const ok = logic.importSpeechRequestsSchema.safeParse({
			clubId: randomUUID(),
			importId: randomUUID(),
		});
		expect(ok.success).toBe(true);
		expect(
			logic.importSpeechRequestsSchema.safeParse({ clubId: randomUUID() })
				.success,
		).toBe(false);
	});
});
