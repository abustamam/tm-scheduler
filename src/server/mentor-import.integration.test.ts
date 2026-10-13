/**
 * The mentor-pair step of the Easy-Speak import, against the test database
 * (#1053). Each test is an acceptance criterion or a branch of
 * `importMentorPairs`: the bundle's mentor pairs become #939 mentorships, once.
 *
 * Run with:
 *   bunx vitest run src/server/mentor-import.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubImports,
	importRefs,
	members,
	mentorships,
	people,
	user,
} from "#/db/schema";
import type { EasySpeakBundleV1 } from "#/lib/easy-speak-bundle";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
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

type Row = EasySpeakBundleV1["mentors"][number];

const person = (es: string) => ({ esUserId: es, name: `Person ${es}` });

function row(mentee: string, mentor: string | null, wants = false): Row {
	return {
		mentee: person(mentee),
		mentor: mentor === null ? null : person(mentor),
		wantsMentee: wants,
	};
}

describe.skipIf(!hasTestDb)("mentor-pair import (#1053)", () => {
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
	async function resolvedMember(
		es: string,
		status: "active" | "inactive" = "active",
	): Promise<string> {
		const [p] = await testDb
			.insert(people)
			.values({ name: `Person ${es}` })
			.returning({ id: people.id });
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: p?.id as string,
				name: `Person ${es}`,
				clubRole: "member",
				status,
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
		mentors: Row[],
		appliedAt: Date | null = new Date(),
	): Promise<string> {
		const base = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
		const [r] = await testDb
			.insert(clubImports)
			.values({
				clubId: seed.clubId,
				source: "easy_speak",
				bundle: { ...base, mentors },
				bundleSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
				uploadedByUserId: superadminId,
				appliedAt,
			})
			.returning({ id: clubImports.id });
		return r?.id as string;
	}

	function run(importId: string) {
		return logic.importMentorPairs({
			clubId: seed.clubId,
			importId,
			superadminUserId: superadminId,
		});
	}

	async function pairings() {
		return testDb
			.select()
			.from(mentorships)
			.where(eq(mentorships.clubId, seed.clubId));
	}

	it("AC1: the pair count equals the bundle's non-null mentor count, as active pairings with no focus, and a second run adds none", async () => {
		const a = await resolvedMember("1");
		const b = await resolvedMember("2");
		const c = await resolvedMember("3");
		const importId = await storeBundle([
			row("1", "2"),
			row("3", "2"),
			// No mentor named: not a pair.
			row("2", null, true),
		]);

		const first = await run(importId);

		expect(first).toMatchObject({
			total: 3,
			pairs: 2,
			noMentor: 1,
			imported: 2,
			alreadyImported: 0,
			alreadyPaired: 0,
			skipped: [],
		});
		const stored = await pairings();
		expect(stored).toHaveLength(2);
		expect(
			stored.map((s) => [s.mentorMemberId, s.menteeMemberId]).sort(),
		).toEqual(
			[
				[b, a],
				[b, c],
			].sort(),
		);
		expect(stored.every((s) => s.endedAt === null && s.focus === null)).toBe(
			true,
		);
		expect(stored.every((s) => s.createdByMemberId === null)).toBe(true);

		const again = await run(importId);
		expect(again).toMatchObject({ imported: 0, alreadyImported: 2 });
		expect(await pairings()).toHaveLength(2);
		const refs = await testDb
			.select()
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, "mentor_pair"),
				),
			);
		expect(refs.map((r) => r.sourceId).sort()).toEqual([
			"es:1>es:2",
			"es:3>es:2",
		]);
	});

	it("AC2: an unresolved person blocks only their own pair, which is listed with who and why", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		await resolvedMember("3");
		const importId = await storeBundle([
			row("1", "2"),
			// No ref at all for 8: a guest, or someone the apply skipped.
			row("8", "2"),
			row("3", "9"),
			row("8", "9"),
		]);

		const result = await run(importId);

		expect(result).toMatchObject({ pairs: 4, imported: 1 });
		expect(result.skipped).toEqual([
			{
				mentee: person("8"),
				mentor: person("2"),
				reason: "mentee_not_member",
			},
			{
				mentee: person("3"),
				mentor: person("9"),
				reason: "mentor_not_member",
			},
			{
				mentee: person("8"),
				mentor: person("9"),
				reason: "neither_member",
			},
		]);
		expect(await pairings()).toHaveLength(1);
		// A skipped pair leaves no ref, so it imports once the person resolves.
		const refs = await testDb
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, "mentor_pair"),
				),
			);
		expect(refs.map((r) => r.sourceId)).toEqual(["es:1>es:2"]);
	});

	it("skips a pair whose person resolved to a FORMER member, and writes it once they are active again", async () => {
		await resolvedMember("1");
		const mentor = await resolvedMember("2", "inactive");
		const importId = await storeBundle([row("1", "2")]);

		const first = await run(importId);
		expect(first.skipped).toEqual([
			{
				mentee: person("1"),
				mentor: person("2"),
				reason: "mentor_not_member",
			},
		]);
		expect(await pairings()).toHaveLength(0);

		await testDb
			.update(members)
			.set({ status: "active" })
			.where(eq(members.id, mentor));
		const again = await run(importId);
		expect(again).toMatchObject({ imported: 1, skipped: [] });
	});

	it("skips a pair whose MENTEE resolved to a former member, and one whose mentee and mentor both did", async () => {
		await resolvedMember("1");
		await resolvedMember("2", "inactive");
		await resolvedMember("3", "inactive");
		const importId = await storeBundle([row("2", "1"), row("2", "3")]);

		const result = await run(importId);

		expect(result.skipped.map((s) => s.reason)).toEqual([
			"mentee_not_member",
			"neither_member",
		]);
		expect(await pairings()).toHaveLength(0);
	});

	it("skips a stale person ref that points at no membership", async () => {
		await resolvedMember("1");
		await testDb.insert(importRefs).values({
			clubId: seed.clubId,
			source: "easy_speak",
			kind: "person",
			sourceId: "es:2",
			targetId: randomUUID(),
		});
		const importId = await storeBundle([row("1", "2")]);

		const result = await run(importId);

		expect(result.skipped.map((s) => s.reason)).toEqual(["mentor_not_member"]);
		expect(await pairings()).toHaveLength(0);
	});

	it("skips a pair that resolves to one member on both sides", async () => {
		const m = await resolvedMember("1");
		await testDb.insert(importRefs).values({
			clubId: seed.clubId,
			source: "easy_speak",
			kind: "person",
			sourceId: "name:alias",
			targetId: m,
		});
		const importId = await storeBundle([
			{
				mentee: person("1"),
				mentor: { esUserId: null, name: "Alias" },
				wantsMentee: false,
			},
		]);

		const result = await run(importId);

		expect(result.skipped.map((s) => s.reason)).toEqual(["same_person"]);
		expect(await pairings()).toHaveLength(0);
	});

	it("keeps an active pairing an admin already made, remembers it, and does not bring back one a human ended", async () => {
		const a = await resolvedMember("1");
		const b = await resolvedMember("2");
		const c = await resolvedMember("3");
		const [byHand] = await testDb
			.insert(mentorships)
			.values({
				clubId: seed.clubId,
				mentorMemberId: b,
				menteeMemberId: a,
				focus: "contest",
			})
			.returning({ id: mentorships.id });
		const importId = await storeBundle([row("1", "2"), row("3", "2")]);

		const first = await run(importId);
		expect(first).toMatchObject({ imported: 1, alreadyPaired: 1 });
		// The hand-made pairing is untouched; the other one is new.
		const stored = await pairings();
		expect(stored).toHaveLength(2);
		expect(stored.find((s) => s.id === byHand?.id)?.focus).toBe("contest");

		// A human ends both; a re-run brings neither back.
		await testDb
			.update(mentorships)
			.set({ endedAt: new Date() })
			.where(eq(mentorships.clubId, seed.clubId));
		const again = await run(importId);
		expect(again).toMatchObject({
			imported: 0,
			alreadyImported: 2,
			alreadyPaired: 0,
		});
		expect(
			await testDb
				.select({ id: mentorships.id })
				.from(mentorships)
				.where(
					and(
						eq(mentorships.clubId, seed.clubId),
						isNull(mentorships.endedAt),
						eq(mentorships.menteeMemberId, c),
					),
				),
		).toHaveLength(0);
	});

	it("a pair listed twice in the bundle is written once", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([row("1", "2"), row("1", "2")]);

		const result = await run(importId);

		expect(result).toMatchObject({ pairs: 2, imported: 1, alreadyImported: 1 });
		expect(await pairings()).toHaveLength(1);
	});

	it("reports 'Wants Mentee?' as not imported and writes no member flag", async () => {
		const a = await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([
			row("1", null, true),
			row("2", null, false),
			row("5", "1", true),
		]);

		const result = await run(importId);

		expect(result.wantsMenteeNotImported).toEqual([person("1"), person("5")]);
		const [m] = await testDb
			.select({ willing: members.willingToMentor })
			.from(members)
			.where(eq(members.id, a));
		expect(m?.willing).toBe(false);
	});

	it("is refused at once while an apply holds the club's import lock, and writes nothing", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([row("1", "2")]);
		const apply = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`history-import:${seed.clubId}`}, 0))`,
			);
		});
		try {
			await expect(run(importId)).rejects.toThrow(logic.IMPORT_RUNNING_MESSAGE);
		} finally {
			await apply.commit();
		}
		expect(await pairings()).toHaveLength(0);
		expect((await run(importId)).imported).toBe(1);
	});

	it("refuses an import that has not been applied", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([row("1", "2")], null);

		await expect(run(importId)).rejects.toThrow(
			logic.MENTORS_NOT_APPLIED_MESSAGE,
		);
		expect(await pairings()).toHaveLength(0);
	});

	it("refuses an import that belongs to another club", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([row("1", "2")]);
		const other = await seedClub();
		try {
			await expect(
				logic.importMentorPairs({
					clubId: other.clubId,
					importId,
					superadminUserId: superadminId,
				}),
			).rejects.toThrow();
			const stray = await testDb
				.select()
				.from(mentorships)
				.where(eq(mentorships.clubId, other.clubId));
			expect(stray).toHaveLength(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("logs one history_imported entry for the step, attributed to the superadmin", async () => {
		await resolvedMember("1");
		await resolvedMember("2");
		const importId = await storeBundle([row("1", "2"), row("7", "2", true)]);

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
			step: "mentors",
			counts: {
				total: 2,
				pairs: 2,
				imported: 1,
				skipped: 1,
				wantsMenteeNotImported: 1,
			},
		});
	});

	it("validates the server-fn input: a club id and an import id", () => {
		expect(
			logic.importMentorPairsSchema.safeParse({
				clubId: randomUUID(),
				importId: randomUUID(),
			}).success,
		).toBe(true);
		expect(
			logic.importMentorPairsSchema.safeParse({ clubId: randomUUID() }).success,
		).toBe(false);
	});
});
