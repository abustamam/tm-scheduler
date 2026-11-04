/**
 * A club keeps at most MAX_UNAPPLIED_IMPORTS unapplied stored uploads; storing
 * another deletes the oldest. Against the test database.
 *
 * Run with:
 *   bunx vitest run src/server/history-import-upload-cap.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubImports, user } from "#/db/schema";
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

/** A valid bundle whose hash differs by `n`. */
function bundleText(n: number): string {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
	bundle.meetings = [];
	bundle.people = [
		{
			esUserId: "900101",
			name: `Pia President ${n}`,
			status: "President",
			joined: null,
		},
	];
	bundle.mentors = [];
	bundle.speechRequests = [];
	bundle.visitorsIntroduced = [];
	return JSON.stringify(bundle);
}

describe.skipIf(!hasTestDb)("unapplied upload cap", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let uploaderId: string;

	const store = (club: SeededClub, n: number) =>
		logic.storeEasySpeakBundle({
			clubId: club.clubId,
			uploadedByUserId: uploaderId,
			text: bundleText(n),
			overrideClubBinding: true,
		});
	const rows = (club: SeededClub, unapplied?: boolean) =>
		testDb
			.select({
				id: clubImports.id,
				sha: clubImports.bundleSha256,
				appliedAt: clubImports.appliedAt,
			})
			.from(clubImports)
			.where(
				and(
					eq(clubImports.clubId, club.clubId),
					unapplied ? isNull(clubImports.appliedAt) : undefined,
				),
			)
			.orderBy(asc(clubImports.createdAt), asc(clubImports.id));

	beforeEach(async () => {
		seed = await seedClub();
		other = await seedClub();
		uploaderId = randomUUID();
		await testDb.insert(user).values({
			id: uploaderId,
			name: "Uploader",
			email: `up-${uploaderId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		await testDb.delete(user).where(inArray(user.id, [uploaderId]));
	});

	// protects=a club cannot accumulate unapplied uploads without bound: the sixth leaves five and the oldest is gone;
	// fails_when=the cap number is raised, or the delete is dropped or keeps the oldest;
	// no_claim=what the panel shows afterwards.
	it("the sixth upload leaves five unapplied and the oldest is gone", async () => {
		const ids: string[] = [];
		for (let n = 1; n <= logic.MAX_UNAPPLIED_IMPORTS; n++) {
			ids.push((await store(seed, n)).importId);
		}
		expect(await rows(seed, true)).toHaveLength(5);
		const sixth = await store(seed, 6);
		expect(sixth.reused).toBe(false);
		const left = (await rows(seed, true)).map((r) => r.id);
		expect(left).toHaveLength(logic.MAX_UNAPPLIED_IMPORTS);
		expect(left).not.toContain(ids[0]);
		expect(left).toContain(sixth.importId);
		expect(left).toEqual(expect.arrayContaining(ids.slice(1)));
	});

	// protects=an applied import (the club's record and its binding) is never deleted or counted;
	// fails_when=the delete drops its applied_at IS NULL filter, or the count includes applied rows;
	// no_claim=that apply itself is correct.
	it("never deletes or counts an applied import", async () => {
		const applied = await store(seed, 100);
		await testDb
			.update(clubImports)
			.set({ appliedAt: new Date() })
			.where(eq(clubImports.id, applied.importId));
		for (let n = 1; n <= 6; n++) await store(seed, n);
		const all = await rows(seed);
		expect(
			all.find((r) => r.id === applied.importId)?.appliedAt,
		).not.toBeNull();
		expect(await rows(seed, true)).toHaveLength(5);
		expect(all).toHaveLength(6);
	});

	// protects=re-uploading the same file reuses its row and deletes nothing;
	// fails_when=the reuse path inserts or deletes;
	// no_claim=none beyond protects.
	it("a same-content re-upload deletes nothing", async () => {
		for (let n = 1; n <= 5; n++) await store(seed, n);
		const before = (await rows(seed, true)).map((r) => r.id);
		const again = await store(seed, 1);
		expect(again.reused).toBe(true);
		expect((await rows(seed, true)).map((r) => r.id)).toEqual(before);
	});

	// protects=another club's uploads are never trimmed by this club's upload;
	// fails_when=the delete drops its club filter;
	// no_claim=none beyond protects.
	it("leaves another club's rows alone", async () => {
		for (let n = 1; n <= 3; n++) await store(other, n);
		for (let n = 1; n <= 6; n++) await store(seed, n);
		expect(await rows(other)).toHaveLength(3);
		expect(await rows(seed)).toHaveLength(5);
	});

	// protects=two concurrent uploads cannot exceed the cap;
	// fails_when=the count, delete and insert leave the club write lock;
	// no_claim=which of the concurrent rows survives.
	it("concurrent uploads stay at the cap", async () => {
		for (let n = 1; n <= 5; n++) await store(seed, n);
		await Promise.all([store(seed, 6), store(seed, 7), store(seed, 8)]);
		expect(await rows(seed, true)).toHaveLength(5);
	});

	// protects=an upload while an apply holds the club's import lock deletes nothing (the running apply's row survives); the next upload trims;
	// fails_when=the trim ignores the lock result;
	// no_claim=the apply itself.
	it("skips the trim while the import lock is held, trims on the next upload", async () => {
		for (let n = 1; n <= 5; n++) await store(seed, n);
		const holder = await testDb.$client.connect();
		try {
			await holder.query("begin");
			const got = await holder.query(
				"select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as ok",
				[`history-import:${seed.clubId}`],
			);
			expect(got.rows[0].ok).toBe(true);
			const sixth = await store(seed, 6);
			expect(sixth.reused).toBe(false);
			expect(await rows(seed, true)).toHaveLength(6);
		} finally {
			await holder.query("rollback");
			holder.release();
		}
		await store(seed, 7);
		expect(await rows(seed, true)).toHaveLength(5);
	});
});
