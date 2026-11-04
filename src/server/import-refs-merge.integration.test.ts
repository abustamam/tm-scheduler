/**
 * A merge must not make the Easy-Speak import forget a person it already made
 * (#1494). Each test drives the REAL importers (`applyEasySpeakImport`,
 * `importMentorPairs`) and the REAL merges (`mergePeople`, the club admin's
 * `applyMemberMerge`), not hand-written `import_refs` rows.
 *
 * Run with:
 *   bunx vitest run src/server/import-refs-merge.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, importRefs, members, people, user } from "#/db/schema";
import type { PersonResolution } from "#/lib/easy-speak-import-plan";
import type { ImportRefKind } from "#/lib/import-refs";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./history-import-logic");
const mentors = await import("./mentor-import-logic");
const { mergePeople } = await import("./people-merge-logic");
const { applyMemberMerge } = await import("./members-logic");

const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");
/** The fixture's mentee who ticked "Wants Mentee?". */
const WANTS_MENTEE_KEY = "es:900057";

describe.skipIf(!hasTestDb)("merge keeps import refs (#1494)", () => {
	let seed: SeededClub;
	let superadminId: string;
	const extraUsers: string[] = [];
	const extraClubs: SeededClub[] = [];

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
		await testDb
			.update(clubs)
			.set({ timezone: "America/Los_Angeles" })
			.where(eq(clubs.id, seed.clubId));
	});

	afterEach(async () => {
		for (const c of extraClubs.splice(0)) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await testDb.delete(user).where(inArray(user.id, extraUsers.splice(0)));
	});

	/** Upload the fixture, resolve everyone the plan cannot place as a guest, apply. */
	async function importFixture() {
		const stored = await logic.storeEasySpeakBundle({
			clubId: seed.clubId,
			uploadedByUserId: superadminId,
			text: readFileSync(FIXTURE, "utf8"),
		});
		return { importId: stored.importId, ...(await applyAll(stored.importId)) };
	}

	async function resolutionsFor(importId: string) {
		const preview = await logic.previewEasySpeakImport({
			clubId: seed.clubId,
			importId,
			now: NOW,
		});
		const resolutions: Record<string, PersonResolution> = {};
		for (const p of preview.people) {
			if (p.needsDecision) {
				resolutions[p.key] = { action: "guest", kind: "visitor" };
			}
		}
		return { preview, resolutions };
	}

	async function applyAll(importId: string) {
		const { resolutions } = await resolutionsFor(importId);
		const { report } = await logic.applyEasySpeakImport({
			clubId: seed.clubId,
			importId,
			runner: { kind: "superadmin", userId: superadminId },
			resolutions,
			now: NOW,
		});
		return { report, resolutions };
	}

	async function refTarget(kind: ImportRefKind, sourceId: string) {
		const [r] = await testDb
			.select({ targetId: importRefs.targetId })
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, kind),
					eq(importRefs.sourceId, sourceId),
				),
			);
		return r?.targetId;
	}

	async function addMember(clubId = seed.clubId): Promise<{
		id: string;
		personId: string;
	}> {
		const [p] = await testDb
			.insert(people)
			.values({ name: `Keeper ${randomUUID()}` })
			.returning({ id: people.id });
		const [m] = await testDb
			.insert(members)
			.values({
				clubId,
				personId: p?.id as string,
				name: "Keeper",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		return { id: m?.id as string, personId: p?.id as string };
	}

	async function memberRow(id: string) {
		const [m] = await testDb.select().from(members).where(eq(members.id, id));
		return m;
	}

	async function setWilling(id: string, willing: boolean) {
		await testDb
			.update(members)
			.set({ willingToMentor: willing })
			.where(eq(members.id, id));
	}

	async function clubMemberCount() {
		return (
			await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, seed.clubId))
		).length;
	}

	/** Merge `absorbedMemberId` into a fresh keeper through the named path. */
	async function mergeInto(
		via: "people" | "club",
		keeper: { id: string; personId: string },
		absorbedMemberId: string,
	) {
		const absorbed = await memberRow(absorbedMemberId);
		if (!absorbed) throw new Error("absorbed member missing");
		if (via === "people") {
			await mergePeople({
				keeperPersonId: keeper.personId,
				absorbedPersonId: absorbed.personId,
			});
		} else {
			await applyMemberMerge({
				clubId: seed.clubId,
				keeperId: keeper.id,
				absorbedId: absorbedMemberId,
				actorMemberId: seed.adminMemberId,
			});
		}
	}

	/** An imported person to absorb: a member the import created for `key`. */
	async function createdMemberOf(key: string): Promise<string> {
		const id = await refTarget("person", key);
		if (!id) throw new Error(`the import made no member for ${key}`);
		const m = await memberRow(id);
		if (!m || m.clubId !== seed.clubId) throw new Error("not a club member");
		return id;
	}

	const PATHS = ["people", "club"] as const;

	for (const via of PATHS) {
		it(`a re-import after the ${via} merge decides nobody and creates nobody (#1494)`, async () => {
			const first = await importFixture();
			expect(first.report.created.members?.active).toBeGreaterThan(0);
			const absorbedId = await createdMemberOf(WANTS_MENTEE_KEY);
			const keeper = await addMember();
			const before = await clubMemberCount();

			await mergeInto(via, keeper, absorbedId);

			// Every `person` ref now names a member that exists.
			const refs = await testDb
				.select({ targetId: importRefs.targetId })
				.from(importRefs)
				.where(
					and(
						eq(importRefs.clubId, seed.clubId),
						eq(importRefs.kind, "person"),
					),
				);
			const live = new Set(
				(
					await testDb
						.select({ id: members.id })
						.from(members)
						.where(eq(members.clubId, seed.clubId))
				).map((m) => m.id),
			);
			expect(refs.filter((r) => !live.has(r.targetId))).toEqual([]);
			expect(await refTarget("person", WANTS_MENTEE_KEY)).toBe(keeper.id);
			const afterMerge = await clubMemberCount();
			expect(afterMerge).toBe(before - 1);

			const { preview, resolutions } = await resolutionsFor(first.importId);
			expect(preview.unresolvedCount).toBe(0);
			expect(preview.people.filter((p) => p.status === "create")).toEqual([]);
			const again = await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: first.importId,
				runner: { kind: "superadmin", userId: superadminId },
				resolutions,
				now: NOW,
			});
			const made = again.report.created.members;
			expect((made?.active ?? 0) + (made?.former ?? 0)).toBe(0);
			expect(await clubMemberCount()).toBe(afterMerge);
		});

		it(`the ${via} merge keeps a flag the keeper turned off off, on the next mentor step (#1494)`, async () => {
			const { importId } = await importFixture();
			const runMentors = () =>
				mentors.importMentorPairs({
					clubId: seed.clubId,
					importId,
					runner: { kind: "superadmin", userId: superadminId },
				});
			const absorbedId = await createdMemberOf(WANTS_MENTEE_KEY);
			const first = await runMentors();
			expect(first.willing.set).toBeGreaterThan(0);
			expect((await memberRow(absorbedId))?.willingToMentor).toBe(true);
			const keeper = await addMember();

			await mergeInto(via, keeper, absorbedId);
			// The keeper, who now stands for the imported person, opts out.
			await setWilling(keeper.id, false);
			expect(await refTarget("willing_to_mentor", keeper.id)).toBe(keeper.id);
			expect(await refTarget("willing_to_mentor", absorbedId)).toBeUndefined();

			const again = await runMentors();

			expect((await memberRow(keeper.id))?.willingToMentor).toBe(false);
			expect(again.willing.set).toBe(0);
		});
	}

	it("a keeper that already holds its own willing_to_mentor ref keeps it, and nothing clashes (#1494)", async () => {
		const { importId } = await importFixture();
		const runMentors = () =>
			mentors.importMentorPairs({
				clubId: seed.clubId,
				importId,
				runner: { kind: "superadmin", userId: superadminId },
			});
		const absorbedId = await createdMemberOf(WANTS_MENTEE_KEY);
		await runMentors();
		const keeper = await addMember();
		await testDb.insert(importRefs).values({
			clubId: seed.clubId,
			source: "easy_speak",
			kind: "willing_to_mentor",
			sourceId: keeper.id,
			targetId: keeper.id,
		});

		await mergeInto("people", keeper, absorbedId);
		await setWilling(keeper.id, false);
		await runMentors();

		const rows = await testDb
			.select({ sourceId: importRefs.sourceId, targetId: importRefs.targetId })
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, seed.clubId),
					eq(importRefs.kind, "willing_to_mentor"),
					inArray(importRefs.sourceId, [keeper.id, absorbedId]),
				),
			);
		expect(rows).toEqual([{ sourceId: keeper.id, targetId: keeper.id }]);
		expect((await memberRow(keeper.id))?.willingToMentor).toBe(false);
	});

	it("a ref in another club that names the same ids is left alone (#1494)", async () => {
		const { importId } = await importFixture();
		void importId;
		const absorbedId = await createdMemberOf(WANTS_MENTEE_KEY);
		const otherClub = await seedClub();
		extraClubs.push(otherClub);
		await testDb.insert(importRefs).values([
			{
				clubId: otherClub.clubId,
				source: "easy_speak",
				kind: "person",
				sourceId: "es:other",
				targetId: absorbedId,
			},
			{
				clubId: otherClub.clubId,
				source: "easy_speak",
				kind: "willing_to_mentor",
				sourceId: absorbedId,
				targetId: absorbedId,
			},
		]);
		const keeper = await addMember();

		await mergeInto("club", keeper, absorbedId);

		const rows = await testDb
			.select({
				kind: importRefs.kind,
				sourceId: importRefs.sourceId,
				targetId: importRefs.targetId,
			})
			.from(importRefs)
			.where(eq(importRefs.clubId, otherClub.clubId));
		expect(rows.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
			{ kind: "person", sourceId: "es:other", targetId: absorbedId },
			{
				kind: "willing_to_mentor",
				sourceId: absorbedId,
				targetId: absorbedId,
			},
		]);
	});
});
