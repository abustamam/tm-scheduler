/**
 * CSV officer approval opens no term on a non-active membership (#1326).
 * The harness mirrors `import-officer-term-reopen.integration.test.ts`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => {
		throw new Error("no request");
	},
}));

describe.skipIf(!hasTestDb)(
	"CSV officer approval and membership status",
	() => {
		let seed: SeededClub;
		let text: string;
		let logic: typeof import("./upload-members-logic");
		beforeEach(async () => {
			seed = await seedClub();
			logic = await import("./upload-members-logic");
			text = `Customer ID,Name,Email,Status (*),Current Position\n,Member User,member-${seed.memberUserId}@test.example,PaidMember,Club President\n`;
		});
		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});
		const offices = () =>
			testDb
				.select()
				.from(officerTerms)
				.where(
					and(
						eq(officerTerms.membershipId, seed.memberId),
						isNull(officerTerms.termEnd),
					),
				);
		const approve = async () => {
			const p = await logic.previewMemberImport(
				seed.clubId,
				text,
				seed.adminUserId,
			);
			return logic.commitMemberImport(seed.clubId, text, {
				userId: seed.adminUserId,
				officerApprovals: p.officerAccessChanges.map((x) => x.approval),
			});
		};

		// protects=an approved CSV office is not opened on a former or inactive membership, and the row is not counted as a grant;
		// fails_when=the commit inserts a term on a non-active membership;
		// no_claim=the preview still proposing the row (planOfficerAccess is not status-aware).
		it.each([
			"former",
			"inactive",
		] as const)("opens no term on a %s membership", async (status) => {
			await testDb
				.update(members)
				.set({ status })
				.where(eq(members.id, seed.memberId));
			const result = await approve();
			expect(result.officerGrants).toBe(0);
			// Still a skipped assignment: the decrement sits after the skip.
			expect(result.stats.skippedOfficerAssignments).toBe(1);
			expect(await offices()).toHaveLength(0);
		});

		// protects=the same row on an ACTIVE membership still opens its term (the skip is status-specific);
		// fails_when=the status check refuses every approval;
		// no_claim=none beyond protects.
		it("still opens the term on an active membership", async () => {
			const result = await approve();
			expect(result.officerGrants).toBe(1);
			expect(result.stats.skippedOfficerAssignments).toBe(0);
			expect(await offices()).toHaveLength(1);
		});
	},
);
