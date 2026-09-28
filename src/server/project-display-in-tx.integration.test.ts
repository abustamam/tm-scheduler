/**
 * #1005: a speaker claim or speech edit that carries a `projectId` reads the
 * Pathways catalog through ITS OWN transaction, not the pool.
 *
 * Reading through the pool while the transaction holds a connection takes a
 * second one, so ~10 concurrent claims exhaust the default pool and every
 * request hangs. Pool exhaustion is not something a test can drive cheaply or
 * deterministically, so these assert the observable difference instead: a
 * catalog row inserted inside the transaction and not yet committed is visible
 * through `tx` and INVISIBLE through the pool (READ COMMITTED). Each case runs
 * the helper against such a row and rolls the whole transaction back, so the
 * global catalog tables are left exactly as found.
 *
 * Reverting either thread-through makes the pooled read miss the row, and the
 * helper throws "That Pathways project no longer exists."
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pathwaysPaths,
	pathwaysProjects,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	type TestTx,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveProjectDisplay } = await import("./project-picker-logic");
const { attachSpeechToSlot, editSlotSpeech } = await import("./slots-logic");

class Rollback extends Error {}

/**
 * Run `work` in a transaction holding an UNCOMMITTED allowlisted project, then
 * roll everything back. Returns what `work` returned.
 */
async function withUncommittedProject<T>(
	name: string,
	work: (tx: TestTx, projectId: string) => Promise<T>,
): Promise<T> {
	let out!: T;
	await testDb
		.transaction(async (tx) => {
			// 8701 is a real allowlisted course code and globally unique, so adopt
			// the shared row when the catalog is seeded; otherwise create it here,
			// uncommitted, where the rollback takes it away again.
			const [existing] = await tx
				.select({ id: pathwaysPaths.id })
				.from(pathwaysPaths)
				.where(eq(pathwaysPaths.courseCode, "8701"));
			const pathId =
				existing?.id ??
				(
					await tx
						.insert(pathwaysPaths)
						.values({ courseCode: "8701", name: "Presentation Mastery" })
						.returning({ id: pathwaysPaths.id })
				)[0]!.id;
			const [project] = await tx
				.insert(pathwaysProjects)
				.values({ pathId, level: 2, name, isRequired: true })
				.returning({ id: pathwaysProjects.id });
			out = await work(tx, project!.id);
			throw new Rollback();
		})
		.catch((err) => {
			if (!(err instanceof Rollback)) throw err;
		});
	return out;
}

describe.skipIf(!hasTestDb)(
	"catalog read inside the transaction (#1005)",
	() => {
		let seed: SeededClub;
		let slotId: string;
		const tag = randomUUID().slice(0, 8);

		beforeEach(async () => {
			seed = await seedClub();
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: def!.id,
					status: "claimed",
					assignedMemberId: seed.memberId,
				})
				.returning({ id: roleSlots.id });
			slotId = slot!.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("control: the pool cannot see a project the transaction has not committed", async () => {
			const name = `Uncommitted ${tag}`;
			const err = await withUncommittedProject(name, (_tx, projectId) =>
				resolveProjectDisplay(projectId).then(
					() => null,
					(e: Error) => e.message,
				),
			);
			expect(err).toBe("That Pathways project no longer exists.");
		});

		it("resolveProjectDisplay reads through the connection it is given", async () => {
			const name = `Direct ${tag}`;
			const display = await withUncommittedProject(name, (tx, projectId) =>
				resolveProjectDisplay(projectId, tx),
			);
			expect(display.projectName).toBe(name);
			expect(display.projectLevel).toBe("Level 2");
		});

		it("attachSpeechToSlot (the claim path) resolves the project through its tx", async () => {
			const name = `Claim ${tag}`;
			const stored = await withUncommittedProject(
				name,
				async (tx, projectId) => {
					const speechId = await attachSpeechToSlot(tx, {
						slotId,
						personId: seed.personId,
						input: { speechTitle: "A talk", projectId },
					});
					const [row] = await tx
						.select({ projectName: speeches.projectName })
						.from(speeches)
						.where(eq(speeches.id, speechId!));
					return row?.projectName;
				},
			);
			expect(stored).toBe(name);
		});

		it("editSlotSpeech (updating an existing speech) resolves the project through its tx", async () => {
			const speechId = await attachSpeechToSlot(testDb, {
				slotId,
				personId: seed.personId,
				input: { speechTitle: "Before" },
			});
			const name = `Edit ${tag}`;
			const stored = await withUncommittedProject(
				name,
				async (tx, projectId) => {
					await editSlotSpeech(tx, {
						slotId,
						personId: seed.personId,
						currentSpeechId: speechId,
						input: { speechTitle: "After", projectId },
					});
					const [row] = await tx
						.select({ projectName: speeches.projectName })
						.from(speeches)
						.where(eq(speeches.id, speechId!));
					return row?.projectName;
				},
			);
			expect(stored).toBe(name);
		});
	},
);
