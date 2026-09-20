/**
 * The DATA half of migration 0083 (#801) — the fold that moves role identity
 * into the club's role bank.
 *
 * `bun run db:generate` writes only three DDL statements (add `standing`, drop
 * the per-template unique index, add the `template_id IS NULL` check).
 * Everything between them is hand-written and nothing regenerates it, so this
 * file runs the migration's OWN statements, read out of the shipped `.sql`,
 * against fixtures shaped like the world before the fold. A regenerated file
 * that lost them fails here rather than on a club's database.
 *
 * Two mechanics the fixtures depend on:
 *
 *   * Every case runs inside a transaction that is ROLLED BACK. The fold's
 *     statements are unscoped by design — they must reach every club — and
 *     `tm_test` is shared with the other files vitest runs in parallel.
 *   * Each transaction DROPS the `role_definitions_template_id_null` CHECK
 *     first. The pre-fold world is precisely the world that constraint forbids,
 *     so it cannot be reconstructed with the constraint in place; Postgres DDL
 *     is transactional, so the rollback restores it either way.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/role-identity-fold.integration.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { deriveRoleKey } from "#/lib/role-def-match";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Imported AFTER the mock: `slots-logic` reads `#/db` at load. Only
// `realignEvaluatorPairs` is used, and it takes the caller's transaction
// handle, so it re-derives the pairing inside the same uncommitted fold the
// assertions read.
const { realignEvaluatorPairs } = await import("./slots-logic");

const MIGRATION = resolve(process.cwd(), "drizzle/0083_bent_lorna_dane.sql");

/**
 * The migration's FOLD statements: everything except the three DDL statements
 * drizzle-kit generated. Split on drizzle's own breakpoint marker, exactly as
 * `readMigrationFiles` does, so what runs here is byte-for-byte what runs in
 * the container.
 *
 * `ALTER TABLE` is excluded because the column and the check are already
 * applied to `tm_test`; `DROP INDEX` because the index is already gone. What
 * remains is the part nothing regenerates.
 */
const FOLD_STATEMENT =
	/^(WITH|DO|DROP TABLE|CREATE TEMP TABLE|UPDATE|DELETE)\b/i;

function foldStatements(): string[] {
	const statements = readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		// A segment opens with the comment block that explains it.
		.map((s) => s.replace(/^\s*(--[^\n]*\n)+/, "").trim())
		.filter((s) => FOLD_STATEMENT.test(s));
	// A replay that runs ZERO statements passes every assertion below for the
	// wrong reason — the seeded rows simply keep the state they were seeded in.
	expect(
		statements.length,
		"the migration must still carry its hand-written fold",
	).toBe(15);
	return statements;
}

/**
 * 0083's OWN slug expression, lifted out of the shipped file: the `base := …;`
 * assignment from step 1b's DO block, anchored on the `candidate :=` that
 * follows it.
 *
 * EXTRACTED rather than restated. Step 1b claims to reproduce `deriveRoleKey`
 * "character for character", and a copy of the expression pasted into this file
 * would agree with whichever engine the author had in mind — which is exactly
 * how the one real divergence survived being written down as exact. Reading it
 * off the migration means the two can only be compared, never assumed.
 */
function sqlSlugExpression(): string {
	// COMMENT-BLIND, and that is not tidiness: the paragraph in 0083 explaining
	// this gate quotes `base := …` itself, so a raw match found the PROSE first
	// and handed Postgres a query made of English. Strip `--` lines before
	// matching and only real statements can answer.
	const sqlOnly = readFileSync(MIGRATION, "utf8").replace(/^\s*--.*$/gm, "");
	const [, expr] =
		sqlOnly.match(/base := ([\s\S]*?);\s*\n\s*candidate := base;/) ?? [];
	if (!expr) throw new Error("0083 step 1b no longer has a `base :=` slug");
	return expr.replace(/r\.name/g, "n.name");
}

class Rollback extends Error {}

/** The transaction handle `testDb.transaction` hands its callback. */
type Tx = Parameters<Parameters<typeof testDb.transaction>[0]>[0];

/** Run `body` in a rolled-back transaction with the #801 CHECK dropped, then
 *  the fold replayed, and return whatever `body`'s `after` step read. */
async function foldWith<T>(
	seed: (tx: Tx) => Promise<unknown>,
	after: (tx: Tx) => Promise<T>,
	opts?: { runs?: number },
): Promise<T> {
	let result: T | undefined;
	let ran = false;
	try {
		await testDb.transaction(async (tx) => {
			await tx.execute(
				sql.raw(
					'ALTER TABLE "role_definitions" DROP CONSTRAINT "role_definitions_template_id_null"',
				),
			);
			await seed(tx);
			for (let i = 0; i < (opts?.runs ?? 1); i++) {
				for (const statement of foldStatements()) {
					await tx.execute(sql.raw(statement));
				}
			}
			result = await after(tx);
			ran = true;
			throw new Rollback();
		});
	} catch (e) {
		if (!(e instanceof Rollback)) throw e;
	}
	if (!ran) throw new Error("transaction body did not run");
	return result as T;
}

describe.skipIf(!hasTestDb)("0083 folds role identity into the bank", () => {
	let club: SeededClub;
	const RUN = crypto.randomUUID().slice(0, 8);

	beforeEach(async () => {
		club = await seedClub();
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	/** A template row to hang forks off. Created inside the fold transaction so
	 *  it rolls back with everything else. */
	async function makeTemplate(tx: Tx, suffix: string): Promise<string> {
		const [t] = await tx
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				key: `fold_${RUN}_${suffix}`,
				name: `Fold ${RUN} ${suffix}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		return t.id;
	}

	/** Set by a fixture, read by its assertion — the seed and the read are
	 *  separate callbacks of `foldWith`. */
	let seededPastSlotId = "";
	let bankEvaluatorRoleId = "";

	async function defsFor(tx: Tx, key: string) {
		return tx
			.select({
				id: roleDefinitions.id,
				name: roleDefinitions.name,
				templateId: roleDefinitions.templateId,
				standing: roleDefinitions.standing,
			})
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, key),
				),
			);
	}

	it("folds a fork onto its BANK twin, moving the slots and keeping the club's name", async () => {
		// The reported live case: three standard functionaries hand-added to a
		// special meeting, each a fork of a role the club already ran. The bank
		// row wins outright — it is the row the club's settings edit and its
		// members recognise — and the fork's slot follows it, which is what makes
		// the repair retroactive.
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "twin");
				await tx
					.update(roleDefinitions)
					.set({ key: "timer", name: "Our Timekeeper" })
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				const [fork] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId,
						key: "timer",
						name: "Timer",
						category: "functionary",
					})
					.returning({ id: roleDefinitions.id });
				if (!fork) throw new Error("fork insert failed");
				await tx.insert(roleSlots).values({
					meetingId: club.meetingId,
					roleDefinitionId: fork.id,
					slotIndex: 0,
					assignedMemberId: club.memberId,
					status: "claimed",
				});
				return { forkId: fork.id };
			},
			async (tx) => ({
				defs: await defsFor(tx, "timer"),
				slots: await tx
					.select({
						roleDefinitionId: roleSlots.roleDefinitionId,
						slotIndex: roleSlots.slotIndex,
						assignedMemberId: roleSlots.assignedMemberId,
						status: roleSlots.status,
					})
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId)),
			}),
		);

		// One row, and it is the club's — same id, same NAME. Preserving the
		// club's own rename is `materializeTemplateRoles`' existing contract
		// (#445) and the fold must not undo it.
		expect(result.defs.map((d) => d.id)).toEqual([club.roleDefinitionId]);
		expect(result.defs[0]?.name).toBe("Our Timekeeper");
		expect(result.defs[0]?.templateId).toBeNull();

		// Both slots now point at it, renumbered 0..N-1 because step 3 collapsed
		// two index-0 slots onto one (definition, index) pair.
		expect(result.slots).toHaveLength(2);
		expect(
			result.slots.every((s) => s.roleDefinitionId === club.roleDefinitionId),
		).toBe(true);
		expect(result.slots.map((s) => s.slotIndex).sort()).toEqual([0, 1]);
		// Nothing about the assignment moved.
		expect(result.slots.filter((s) => s.status === "claimed")).toHaveLength(1);
		expect(
			result.slots.find((s) => s.status === "claimed")?.assignedMemberId,
		).toBe(club.memberId);
	});

	it("PROMOTES a fork with no bank twin in place, non-standing, id unmoved", async () => {
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "promote");
				const [fork] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId,
						key: "chief_judge",
						name: "Chief Judge",
						category: "leadership",
					})
					.returning({ id: roleDefinitions.id });
				if (!fork) throw new Error("fork insert failed");
				await tx.insert(roleSlots).values({
					meetingId: club.meetingId,
					roleDefinitionId: fork.id,
					slotIndex: 0,
					assignedMemberId: club.adminMemberId,
					status: "claimed",
				});
				return { forkId: fork.id };
			},
			async (tx) => ({
				defs: await defsFor(tx, "chief_judge"),
				slots: await tx
					.select({
						roleDefinitionId: roleSlots.roleDefinitionId,
						assignedMemberId: roleSlots.assignedMemberId,
					})
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId)),
			}),
		);

		expect(result.defs).toHaveLength(1);
		expect(result.defs[0]?.templateId).toBeNull();
		// Non-standing: it is the club's role now, but no ordinary meeting
		// generates a slot for it. `standing`, not `enabled` — see the migration.
		expect(result.defs[0]?.standing).toBe(false);
		// Promoted IN PLACE, so the slot never moved and its holder is intact.
		const held = result.slots.filter(
			(s) => s.roleDefinitionId === result.defs[0]?.id,
		);
		expect(held).toHaveLength(1);
		expect(held[0]?.assignedMemberId).toBe(club.adminMemberId);
	});

	it("folds a KEYLESS bank row onto a same-named fork by adopting its key", async () => {
		// Step 1a. A club-invented role has `key = NULL`, because
		// `applyRoleDefinitionCreate` never wrote one before #801, so a keyless
		// bank row and its fork share nothing but the name — which is exactly the
		// rule `matchRoleDefs` applies to an unkeyed row.
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "keyless");
				// `seedClub`'s Timer already has a NULL key; give it a distinctive
				// name so the match is this test's and not a collision.
				await tx
					.update(roleDefinitions)
					.set({ name: `Zoom Master ${RUN}`, key: null })
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				const [fork] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId,
						key: `zoom_master_${RUN}`,
						// Case-insensitive, and with surrounding space, because the
						// match is `lower(btrim(name))` on both sides.
						name: `  zoom master ${RUN}  `,
						category: "functionary",
					})
					.returning({ id: roleDefinitions.id });
				if (!fork) throw new Error("fork insert failed");
				return null;
			},
			async (tx) => defsFor(tx, `zoom_master_${RUN}`),
		);

		// ONE row: the club's own, now carrying the fork's key.
		expect(result.map((d) => d.id)).toEqual([club.roleDefinitionId]);
		expect(result[0]?.name).toBe(`Zoom Master ${RUN}`);
	});

	it("REFUSES to award a key two different bare rows both claim, rather than aborting", async () => {
		// A unique violation here does not corrupt anything — it ABORTS THE
		// MIGRATION, and under the Railway startup CMD that aborts the deploy
		// with no in-band remedy. Step 1a's other three guards are all per-NAME,
		// so none of them asks whether one UPDATE is about to write the same
		// (club_id, key) twice.
		//
		// Reachable: `materializeTemplateRoles` preserved a club's rename (#445)
		// while `applyTemplateConversion` deep-copied the template, so two private
		// copies can hold the SAME key under DIFFERENT names — and a club that
		// invented roles by both names has two keyless bank rows to match them.
		// Two templates rather than one because
		// `role_definitions_club_template_key_unique` still stood in that world.
		const result = await foldWith(
			async (tx) => {
				const t1 = await makeTemplate(tx, "contest_a");
				const t2 = await makeTemplate(tx, "contest_b");
				// `seedClub`'s own role is the first keyless bank row, named "Timer".
				await tx.insert(roleDefinitions).values({
					clubId: club.clubId,
					name: "Timekeeper",
					category: "functionary",
				});
				await tx.insert(roleDefinitions).values([
					{
						clubId: club.clubId,
						templateId: t1,
						key: "timer",
						name: "Timer",
						category: "functionary" as const,
					},
					{
						clubId: club.clubId,
						templateId: t2,
						key: "timer",
						name: "Timekeeper",
						category: "functionary" as const,
					},
				]);
				return null;
			},
			async (tx) =>
				tx
					.select({ name: roleDefinitions.name, key: roleDefinitions.key })
					.from(roleDefinitions)
					.where(eq(roleDefinitions.clubId, club.clubId)),
		);

		// Getting here at all is most of the assertion: without the `claimants`
		// guard the statement raises
		// `duplicate key value violates unique constraint
		// "role_definitions_club_key_unique"` and every later step is unreached.
		const byName = Object.fromEntries(result.map((r) => [r.name, r.key]));
		// Neither bare row adopted the contested key — picking one would fold a
		// member's history onto a role chosen by an id comparison. They keep
		// their own slugs and stay two roles, exactly like the rename case.
		expect(byName.Timer).toBe("timer");
		expect(byName.Timekeeper).toBe("timekeeper");
		expect(new Set(result.map((r) => r.key)).size).toBe(result.length);
	});

	it("lets a bare row take a key only a FORK holds, so the pair folds", async () => {
		// Step 1b's EXISTS is scoped to BANK rows, and that scoping is what makes
		// the fold reachable rather than merely tidy. `role_definitions_club_key_
		// unique` is partial on `template_id is null`, so a key held only by a
		// fork is free — and landing on it is the OUTCOME, because step 2 groups
		// by (club_id, key).
		//
		// Measured on the shape step 1a cannot catch: the club's "Ah Counter"
		// against the template's "Ah-Counter". The names differ by punctuation, so
		// the name match misses; unscoped, the EXISTS then pushed the bank row to
		// `ah_counter_2`, the two never folded, and the club's slot history ended
		// up on the promoted fork at `standing = false` — where `generateSlotRows`
		// would never place it on an ordinary meeting again.
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "punctuation");
				await tx
					.update(roleDefinitions)
					.set({ name: "Ah Counter", key: null })
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				const [fork] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId,
						key: "ah_counter",
						name: "Ah-Counter",
						category: "functionary",
					})
					.returning({ id: roleDefinitions.id });
				if (!fork) throw new Error("fork insert failed");
				await tx.insert(roleSlots).values({
					meetingId: club.meetingId,
					roleDefinitionId: fork.id,
					slotIndex: 3,
					assignedMemberId: club.memberId,
					status: "claimed",
				});
				return null;
			},
			async (tx) => ({
				defs: await defsFor(tx, "ah_counter"),
				slots: await tx
					.select({
						roleDefinitionId: roleSlots.roleDefinitionId,
						assignedMemberId: roleSlots.assignedMemberId,
					})
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId)),
			}),
		);

		// ONE row, and it is the CLUB's — standing, so ordinary meetings keep
		// generating it.
		expect(result.defs.map((d) => d.id)).toEqual([club.roleDefinitionId]);
		expect(result.defs[0]?.standing).toBe(true);
		expect(result.defs[0]?.name).toBe("Ah Counter");
		// And the fork's claimed slot came with it.
		const held = result.slots.filter(
			(s) => s.assignedMemberId === club.memberId,
		);
		expect(held).toHaveLength(1);
		expect(held[0]?.roleDefinitionId).toBe(club.roleDefinitionId);
	});

	it("gives every remaining keyless row a slugified, per-club-unique key", async () => {
		// Step 1b, and the reason it matters: `meeting_template_roles.key` is NOT
		// NULL, so a keyless bank role could never be declared by any agenda.
		const result = await foldWith(
			async (tx) => {
				await tx
					.update(roleDefinitions)
					.set({ name: "Zoom Master!!", key: null })
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				await tx.insert(roleDefinitions).values([
					// Slugifies to the same base — must be suffixed, not collided.
					{
						clubId: club.clubId,
						name: "Zoom  master",
						category: "functionary" as const,
					},
					// Nothing slugifiable at all.
					{
						clubId: club.clubId,
						name: "!!!",
						category: "functionary" as const,
					},
				]);
				return null;
			},
			async (tx) =>
				tx
					.select({ name: roleDefinitions.name, key: roleDefinitions.key })
					.from(roleDefinitions)
					.where(eq(roleDefinitions.clubId, club.clubId)),
		);

		const byName = Object.fromEntries(result.map((r) => [r.name, r.key]));
		// Both zoom rows slugify to the same base, so one takes it and the other
		// is suffixed. WHICH is deliberately not asserted: the loop orders by
		// `(club_id, id)` and `role_definitions.id` is `gen_random_uuid()`, so it
		// is reproducible for a given database and unpredictable from here — the
		// same reason the survivor rule's id tiebreak is called deterministic
		// rather than meaningful.
		expect([byName["Zoom Master!!"], byName["Zoom  master"]].sort()).toEqual([
			"zoom_master",
			"zoom_master_2",
		]);
		// Nothing slugifiable falls back to `role`, exactly as `deriveRoleKey` does.
		expect(byName["!!!"]).toBe("role");
		// No row is left unkeyed, and no key repeats within the club.
		expect(result.every((r) => r.key != null)).toBe(true);
		expect(new Set(result.map((r) => r.key)).size).toBe(result.length);
	});

	it("renumbers with FOLDED-IN SLOTS LAST, not merely contiguously", async () => {
		// Slot ids are SUPPLIED rather than defaulted, and the bank slot is given
		// the HIGHEST original index on purpose. Both choices exist to make this
		// distinguish the shipped rule from the one an earlier draft shipped:
		// ordering by `(slot_index, id)` alone keeps the pre-existing slots in
		// their own relative order and is still contiguous, so a test that lets
		// `gen_random_uuid()` choose, or that puts the bank slot first, passes
		// either way.
		const A = "0000ff01-0000-4000-8000-000000000001"; // bank, index 5
		const B = "0000ff01-0000-4000-8000-000000000002"; // fork, index 0
		const C = "0000ff01-0000-4000-8000-000000000003"; // fork, index 1
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "order");
				await tx
					.update(roleDefinitions)
					.set({ key: "speaker" })
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				const [fork] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId,
						key: "speaker",
						name: "Speaker",
						category: "speaker",
						isSpeakerRole: true,
					})
					.returning({ id: roleDefinitions.id });
				if (!fork) throw new Error("fork insert failed");
				await tx
					.delete(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId));
				await tx.insert(roleSlots).values([
					{
						id: A,
						meetingId: club.meetingId,
						roleDefinitionId: club.roleDefinitionId,
						slotIndex: 5,
					},
					{
						id: B,
						meetingId: club.meetingId,
						roleDefinitionId: fork.id,
						slotIndex: 0,
						assignedMemberId: club.memberId,
						status: "claimed" as const,
					},
					{
						id: C,
						meetingId: club.meetingId,
						roleDefinitionId: fork.id,
						slotIndex: 1,
						assignedMemberId: club.adminMemberId,
						status: "claimed" as const,
					},
				]);
				return null;
			},
			async (tx) =>
				tx
					.select({
						id: roleSlots.id,
						slotIndex: roleSlots.slotIndex,
						assignedMemberId: roleSlots.assignedMemberId,
						evaluatesSlotId: roleSlots.evaluatesSlotId,
						status: roleSlots.status,
					})
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId)),
		);

		expect(result).toHaveLength(3);
		// The slot that was already on the surviving role keeps its place at the
		// FRONT despite having the highest old index; the two that arrived take
		// the tail in their own former order. Ordering by `(slot_index, id)`
		// alone gives [B, C, A] and is equally contiguous.
		expect(
			result
				.slice()
				.sort((x, y) => x.slotIndex - y.slotIndex)
				.map((x) => x.id),
		).toEqual([A, B, C]);
		// And nothing else on a slot moved.
		expect(result.every((s) => s.evaluatesSlotId === null)).toBe(true);
		expect(result.filter((s) => s.status === "claimed")).toHaveLength(2);
	});

	it("keeps a stored evaluator pairing through the fold AND the next speaker edit", async () => {
		// The reason "folded-in last" is not a tidiness preference.
		// `realignEvaluatorPairs` never READS `evaluates_slot_id` — it overwrites
		// evaluator i's pointer with speaker i from the two roles' sorted arrays.
		// So the fold changes the pairing by changing ARRAY MEMBERSHIP, and the
		// damage surfaces on an edit made days later rather than on the deploy.
		//
		// Driven through the real function rather than asserted about: it takes a
		// `DbOrTx`, so it re-derives inside this transaction.
		// `applyAddSpeakerSlot` could not be used — it opens a transaction of its
		// own on another pooled connection, which cannot see an uncommitted fold.
		//
		// The ids are chosen so the FORK's slots sort AHEAD of the bank's within
		// their index on the speaker side and BEHIND on the evaluator side. Under
		// `(slot_index, id)` alone the two roles then interleave differently and
		// E0 ends up evaluating the contest speaker; under the shipped rule both
		// roles append, and every pair survives.
		const S0 = "0000ff02-0000-4000-8000-0000000000b1";
		const S1 = "0000ff02-0000-4000-8000-0000000000b2";
		const SF = "0000ff02-0000-4000-8000-0000000000a1"; // sorts BEFORE S0
		const E0 = "0000ff02-0000-4000-8000-0000000000c1";
		const E1 = "0000ff02-0000-4000-8000-0000000000c2";
		const EF = "0000ff02-0000-4000-8000-0000000000d1"; // sorts AFTER E0
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "pairing");
				// The club's own paired roles.
				await tx
					.update(roleDefinitions)
					.set({
						key: "speaker",
						name: "Speaker",
						category: "speaker",
						isSpeakerRole: true,
						sortOrder: 10,
					})
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				const [bankEval] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						key: "evaluator",
						name: "Evaluator",
						category: "evaluator",
						defaultCount: 3,
						sortOrder: 20,
					})
					.returning({ id: roleDefinitions.id });
				// The contest's forks of the same two keys.
				const forks = await tx
					.insert(roleDefinitions)
					.values([
						{
							clubId: club.clubId,
							templateId,
							key: "speaker",
							name: "Contestant",
							category: "speaker" as const,
							isSpeakerRole: true,
							sortOrder: 10,
						},
						{
							clubId: club.clubId,
							templateId,
							key: "evaluator",
							name: "Contest Evaluator",
							category: "evaluator" as const,
							defaultCount: 3,
							sortOrder: 20,
						},
					])
					.returning({ id: roleDefinitions.id, key: roleDefinitions.key });
				const forkSpeaker = forks.find((f) => f.key === "speaker");
				const forkEval = forks.find((f) => f.key === "evaluator");
				if (!bankEval || !forkSpeaker || !forkEval) {
					throw new Error("fixture insert failed");
				}
				bankEvaluatorRoleId = bankEval.id;

				await tx
					.delete(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId));
				await tx.insert(roleSlots).values([
					{
						id: S0,
						meetingId: club.meetingId,
						roleDefinitionId: club.roleDefinitionId,
						slotIndex: 0,
					},
					{
						id: S1,
						meetingId: club.meetingId,
						roleDefinitionId: club.roleDefinitionId,
						slotIndex: 1,
					},
					{
						id: SF,
						meetingId: club.meetingId,
						roleDefinitionId: forkSpeaker.id,
						slotIndex: 0,
					},
				]);
				// Evaluators second, so their `evaluates_slot_id` can point at the
				// speaker slots above — the STORED pairing this test is about.
				await tx.insert(roleSlots).values([
					{
						id: E0,
						meetingId: club.meetingId,
						roleDefinitionId: bankEval.id,
						slotIndex: 0,
						evaluatesSlotId: S0,
					},
					{
						id: E1,
						meetingId: club.meetingId,
						roleDefinitionId: bankEval.id,
						slotIndex: 1,
						evaluatesSlotId: S1,
					},
					{
						id: EF,
						meetingId: club.meetingId,
						roleDefinitionId: forkEval.id,
						slotIndex: 0,
						evaluatesSlotId: SF,
					},
				]);
				return null;
			},
			async (tx) => {
				// THE NEXT SPEAKER EDIT. `applyAddSpeakerSlot` inserts a speaker and
				// its evaluator and then realigns; this is that, minus the meeting
				// lock and the activity row, neither of which touches the pairing.
				const [newSpeaker] = await tx
					.insert(roleSlots)
					.values({
						meetingId: club.meetingId,
						roleDefinitionId: club.roleDefinitionId,
						slotIndex: 99,
					})
					.returning({ id: roleSlots.id });
				if (!newSpeaker) throw new Error("speaker insert failed");
				await tx.insert(roleSlots).values({
					meetingId: club.meetingId,
					roleDefinitionId: bankEvaluatorRoleId,
					slotIndex: 99,
					evaluatesSlotId: newSpeaker.id,
				});
				await realignEvaluatorPairs(
					tx,
					club.meetingId,
					club.roleDefinitionId,
					bankEvaluatorRoleId,
				);
				return tx
					.select({
						id: roleSlots.id,
						evaluatesSlotId: roleSlots.evaluatesSlotId,
					})
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId));
			},
		);

		const pairOf = (id: string) =>
			result.find((r) => r.id === id)?.evaluatesSlotId;
		// Every pair the meeting carried BEFORE the fold still holds after a
		// speaker was added on top of it.
		expect(pairOf(E0)).toBe(S0);
		expect(pairOf(E1)).toBe(S1);
		expect(pairOf(EF)).toBe(SF);
	});

	it("is a NO-OP on a second run", async () => {
		// Migrations are tracked, so this cannot happen through drizzle — but a
		// fold that is not idempotent is one an operator cannot safely re-run by
		// hand, and step 6's unconditional UPDATE is the statement most likely to
		// misbehave on a folded database.
		const [once, twice] = await Promise.all([
			foldWith(
				async (tx) => {
					const templateId = await makeTemplate(tx, "idem1");
					await tx.insert(roleDefinitions).values({
						clubId: club.clubId,
						templateId,
						key: "judge",
						name: "Judge",
						category: "functionary",
					});
					return null;
				},
				async (tx) => snapshot(tx),
			),
			foldWith(
				async (tx) => {
					const templateId = await makeTemplate(tx, "idem2");
					await tx.insert(roleDefinitions).values({
						clubId: club.clubId,
						templateId,
						key: "judge",
						name: "Judge",
						category: "functionary",
					});
					return null;
				},
				async (tx) => snapshot(tx),
				{ runs: 2 },
			),
		]);
		expect(twice).toEqual(once);
	});

	async function snapshot(tx: Tx) {
		return tx
			.select({
				key: roleDefinitions.key,
				name: roleDefinitions.name,
				templateId: roleDefinitions.templateId,
				standing: roleDefinitions.standing,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId))
			.orderBy(roleDefinitions.key);
	}

	it("moves a PAST meeting's assignment onto the surviving role, which is what recency reads", async () => {
		// The point of the whole repair: `loadRoleRecency`'s "last served" and
		// `season-grid-logic`'s row axis both key on
		// `role_slots.role_definition_id`, so an assignment made on a fork was
		// invisible to both. After the fold it reads through the survivor — on
		// meetings that have ALREADY happened, which is what makes the repair
		// retroactive rather than only forward-looking.
		//
		// Asserted at that COLUMN rather than by calling `loadRoleRecency`, and
		// the reason is mechanical, not a preference: the fold has to run inside
		// a rolled-back transaction (see this file's header), and
		// `loadRoleRecency` reads through the pool — a different connection,
		// which cannot see an uncommitted fold. The function's own grouping over
		// this column is covered by `role-recency` beside it; what only this file
		// can measure is that the column moved.
		const result = await foldWith(
			async (tx) => {
				const templateId = await makeTemplate(tx, "recency");
				await tx
					.update(roleDefinitions)
					.set({ key: "timer" })
					.where(eq(roleDefinitions.id, club.roleDefinitionId));
				const [past] = await tx
					.insert(meetings)
					.values({
						clubId: club.clubId,
						scheduledAt: new Date("2026-01-08T02:00:00Z"),
						status: "completed",
					})
					.returning({ id: meetings.id });
				if (!past) throw new Error("meeting insert failed");
				const [fork] = await tx
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId,
						key: "timer",
						name: "Timer",
						category: "functionary",
					})
					.returning({ id: roleDefinitions.id });
				if (!fork) throw new Error("fork insert failed");
				const [slot] = await tx
					.insert(roleSlots)
					.values({
						meetingId: past.id,
						roleDefinitionId: fork.id,
						slotIndex: 0,
						assignedMemberId: club.memberId,
						status: "confirmed",
					})
					.returning({ id: roleSlots.id });
				if (!slot) throw new Error("slot insert failed");
				seededPastSlotId = slot.id;
				return null;
			},
			async (tx) =>
				tx
					.select({
						roleDefinitionId: roleSlots.roleDefinitionId,
						assignedMemberId: roleSlots.assignedMemberId,
						status: roleSlots.status,
					})
					.from(roleSlots)
					.where(eq(roleSlots.id, seededPastSlotId)),
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.roleDefinitionId).toBe(club.roleDefinitionId);
		expect(result[0]?.assignedMemberId).toBe(club.memberId);
		expect(result[0]?.status).toBe("confirmed");
	});
});

/**
 * The claim step 1b makes about itself: its slug is `deriveRoleKey`'s,
 * "character for character".
 *
 * Two engines implementing one rule is the shape `CLAUDE.md` records for
 * `SPLASH_LOGO_*` — a literal restated in a test agrees with whichever renderer
 * the author had in mind, so each side has to be MEASURED. Here that means
 * running the migration's own expression in Postgres and `deriveRoleKey` in
 * node over the same names.
 *
 * `İstanbul` is the case that was actually wrong and the reason the fold now
 * goes through `foldRoleName`: JS applies Unicode FULL case mapping, so
 * `"İ".toLowerCase()` is `i` plus a combining dot above, the dot is not
 * `[a-z0-9]`, and the slug came out `i_stanbul` against Postgres's `istanbul`.
 * `U+0130` is the only unconditional lowercase special-case in Unicode, so it
 * is the whole of the divergence — the rest of this list is the control that
 * says so.
 */
describe.skipIf(!hasTestDb)("0083's slug matches deriveRoleKey", () => {
	const NAMES = [
		"İstanbul Chair",
		"Zoom Master",
		"Ah-Counter",
		"Sergeant-at-Arms",
		"  Zoom — Master!! ",
		"Café Host",
		"Straße Keeper",
		"🎤 Host",
		"TIMER",
		"___",
		"ÀÉÎÕÜ",
		"",
	];

	it("agrees with Postgres on every name, including the dotted capital I", async () => {
		const expr = sqlSlugExpression();
		// The expression is the migration's, so a step-1b rewrite that changes the
		// rule fails here rather than silently diverging from the TS.
		expect(expr).toContain("[^a-z0-9]");

		for (const name of NAMES) {
			const res = await testDb.execute(
				sql`select ${sql.raw(expr)} as slug from (select ${name}::text as name) n`,
			);
			const fromSql = String(res.rows[0]?.slug ?? "");
			expect(
				deriveRoleKey(name, new Set()),
				`name: ${JSON.stringify(name)}`,
			).toBe(fromSql);
		}
	});
});
