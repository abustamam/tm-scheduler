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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	meetings,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

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
	).toBe(12);
	return statements;
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

	/** Set by the recency fixture below, read by its assertion — the seed and
	 *  the read are separate callbacks of `foldWith`. */
	let seededPastSlotId = "";

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

	it("renumbers ORDER-PRESERVING, so a stored evaluator pairing still re-derives the same way", async () => {
		// `evaluates_slot_id` is stored but `realignEvaluatorPairs` re-derives it
		// POSITIONALLY from `slot_index` on the next speaker edit — so a fold that
		// reordered slots would silently re-pair evaluators long after the deploy.
		// Step 4's `ORDER BY slot_index, id` is that function's exact tiebreak.
		//
		// Slot ids are SUPPLIED rather than defaulted, and that is what makes the
		// assertion deterministic instead of probabilistic: `id` is the tiebreak
		// within a collided index, so a test that lets `gen_random_uuid()` choose
		// can only assert contiguity — which a reordering renumber satisfies too.
		const A = "0000ff01-0000-4000-8000-000000000001";
		const B = "0000ff01-0000-4000-8000-000000000002";
		const C = "0000ff01-0000-4000-8000-000000000003";
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
				// Replace `seedClub`'s slot so every id on this meeting is chosen
				// here. A (0, A) on the bank row and a (0, B) on the fork COLLIDE
				// once the fork's slots are re-pointed; (1, C) was already behind
				// both and must stay behind them.
				await tx
					.delete(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId));
				await tx.insert(roleSlots).values([
					{
						id: A,
						meetingId: club.meetingId,
						roleDefinitionId: club.roleDefinitionId,
						slotIndex: 0,
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
		// Contiguous from 0 — and in the ONE order `(slot_index, id)` gives, which
		// is `realignEvaluatorPairs`' own. A renumber that sorted any other way
		// would still be contiguous and would still fail here.
		expect(
			result
				.slice()
				.sort((x, y) => x.slotIndex - y.slotIndex)
				.map((x) => x.id),
		).toEqual([A, B, C]);
		// And nothing else on a slot moved.
		expect(result.every((s) => s.evaluatesSlotId === null)).toBe(true);
		expect(result.filter((s) => s.status === "claimed")).toHaveLength(2);
		expect(result.find((s) => s.id === C)?.assignedMemberId).toBe(
			club.adminMemberId,
		);
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
