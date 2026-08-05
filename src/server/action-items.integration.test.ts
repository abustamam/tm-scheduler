/**
 * DB-backed tests for club action items (#529). Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run --pool=threads --no-file-parallelism \
 *     src/server/action-items.integration.test.ts
 *
 * `#/db` is mocked to the test client so the logic module imports cleanly
 * without a production DATABASE_URL. Skipped when TEST_DATABASE_URL is unset —
 * a bare `bun run test` silently drops this whole file.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubActionItems, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	createActionItem,
	listActionItems,
	loadActionItemsForMinutes,
	resolveActionItem,
	reopenActionItem,
	updateActionItem,
	deleteActionItem,
} = await import("#/server/action-items-logic");
const { requireClubRole, requireClubViewAccess } = await import(
	"#/server/guards"
);

const AT = (iso: string) => new Date(iso);

describe.skipIf(!hasTestDb)("club action items (#529)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/**
	 * Force a row's timestamps so the pinning tests are deterministic.
	 *
	 * `resolution` is written alongside `resolvedAt` because the check
	 * constraint refuses the half-closed row — which it caught this helper
	 * doing on the first run.
	 */
	async function backdate(
		id: string,
		createdAt: string,
		resolvedAt: string | null = null,
	) {
		await testDb
			.update(clubActionItems)
			.set({
				createdAt: AT(createdAt),
				...(resolvedAt
					? { resolvedAt: AT(resolvedAt), resolution: "done" as const }
					: {}),
			})
			.where(eq(clubActionItems.id, id));
	}

	describe("creating", () => {
		it("creates an item with text alone — no owner, no due date", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
			});
			const [row] = await listActionItems(seed.clubId);
			expect(row.id).toBe(id);
			expect(row.text).toBe("Book the venue");
			expect(row.ownerMemberId).toBeNull();
			expect(row.dueDate).toBeNull();
			expect(row.resolvedAt).toBeNull();
			expect(row.resolution).toBeNull();
		});

		it("records an owner and a due date when given", async () => {
			await createActionItem({
				clubId: seed.clubId,
				text: "Order ribbons",
				ownerMemberId: seed.memberId,
				dueDate: "2026-05-01",
			});
			const [row] = await listActionItems(seed.clubId);
			expect(row.ownerMemberId).toBe(seed.memberId);
			expect(row.ownerName).toBe("Member User");
			// A calendar day round-trips as the SAME string — no Date, so no zone to shift it.
			expect(row.dueDate).toBe("2026-05-01");
		});

		it("rejects an item for a member of a different club", async () => {
			const other = await seedClub();
			try {
				await expect(
					createActionItem({
						clubId: seed.clubId,
						text: "Cross-club owner",
						ownerMemberId: other.memberId,
					}),
				).rejects.toThrow();
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});

	describe("resolving", () => {
		it("closes an item with a done reason", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
			});
			await resolveActionItem({
				clubId: seed.clubId,
				id,
				resolution: "done",
			});
			const [row] = await listActionItems(seed.clubId);
			expect(row.resolution).toBe("done");
			expect(row.resolvedAt).not.toBeNull();
		});

		it("closes an item as dropped, distinctly from done", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Order custom banners",
			});
			await resolveActionItem({
				clubId: seed.clubId,
				id,
				resolution: "dropped",
			});
			const [row] = await listActionItems(seed.clubId);
			expect(row.resolution).toBe("dropped");
		});

		it("reopens a resolved item, clearing both fields together", async () => {
			const id = await createActionItem({ clubId: seed.clubId, text: "Redo" });
			await resolveActionItem({ clubId: seed.clubId, id, resolution: "done" });
			await reopenActionItem({ clubId: seed.clubId, id });
			const [row] = await listActionItems(seed.clubId);
			expect(row.resolvedAt).toBeNull();
			expect(row.resolution).toBeNull();
		});

		it("cannot be resolved through another club", async () => {
			const other = await seedClub();
			try {
				const id = await createActionItem({
					clubId: seed.clubId,
					text: "Mine",
				});
				await expect(
					resolveActionItem({ clubId: other.clubId, id, resolution: "done" }),
				).rejects.toThrow();
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});

	describe("the database refuses a half-closed row", () => {
		// The check constraint is the only thing stopping a row that renders in
		// NEITHER the open list nor the resolved list — it would simply vanish
		// from the record.
		it("rejects a resolved_at with no resolution", async () => {
			const id = await createActionItem({ clubId: seed.clubId, text: "x" });
			await expect(
				testDb
					.update(clubActionItems)
					.set({ resolvedAt: new Date() })
					.where(eq(clubActionItems.id, id)),
			).rejects.toThrow();
		});

		it("rejects a resolution with no resolved_at", async () => {
			const id = await createActionItem({ clubId: seed.clubId, text: "x" });
			await expect(
				testDb
					.update(clubActionItems)
					.set({ resolution: "done" })
					.where(eq(clubActionItems.id, id)),
			).rejects.toThrow();
		});
	});

	describe("the owner reference survives the owner leaving", () => {
		it("keeps the item and drops the name when the member is deleted", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
				ownerMemberId: seed.memberId,
			});
			await testDb.delete(members).where(eq(members.id, seed.memberId));

			const rows = await listActionItems(seed.clubId);
			const row = rows.find((r) => r.id === id);
			expect(row).toBeDefined();
			expect(row?.ownerMemberId).toBeNull();
			expect(row?.ownerName).toBeNull();
		});
	});

	describe("minutes are reconstructed from timestamps, never live state", () => {
		// The single most important behaviour in this change. A past meeting's
		// minutes must render identically no matter when they are generated.
		it("shows an item as open at a meeting that predates its resolution", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
			});
			await backdate(id, "2026-01-05T00:00:00Z");
			await resolveActionItem({ clubId: seed.clubId, id, resolution: "done" });
			// Resolved "now"; the meeting was in February.
			await testDb
				.update(clubActionItems)
				.set({ resolvedAt: AT("2026-04-01T00:00:00Z") })
				.where(eq(clubActionItems.id, id));

			const minutes = await loadActionItemsForMinutes({
				clubId: seed.clubId,
				meetingAt: AT("2026-02-10T19:00:00Z"),
				previousMeetingAt: AT("2026-01-10T19:00:00Z"),
			});
			expect(minutes.open.map((i) => i.id)).toEqual([id]);
			expect(minutes.resolved).toEqual([]);
		});

		it("shows the same item as resolved at a later meeting", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
			});
			await backdate(id, "2026-01-05T00:00:00Z", "2026-04-01T00:00:00Z");
			await testDb
				.update(clubActionItems)
				.set({ resolution: "done" })
				.where(eq(clubActionItems.id, id));

			const minutes = await loadActionItemsForMinutes({
				clubId: seed.clubId,
				meetingAt: AT("2026-05-10T19:00:00Z"),
				previousMeetingAt: AT("2026-03-10T19:00:00Z"),
			});
			expect(minutes.open).toEqual([]);
			expect(minutes.resolved.map((i) => i.id)).toEqual([id]);
			expect(minutes.resolved[0].resolution).toBe("done");
		});

		it("excludes an item raised after the meeting", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Raised later",
			});
			await backdate(id, "2026-06-01T00:00:00Z");

			const minutes = await loadActionItemsForMinutes({
				clubId: seed.clubId,
				meetingAt: AT("2026-02-10T19:00:00Z"),
				previousMeetingAt: null,
			});
			expect(minutes.open).toEqual([]);
		});

		it("returns an identical answer when generated twice", async () => {
			const a = await createActionItem({ clubId: seed.clubId, text: "A" });
			const b = await createActionItem({ clubId: seed.clubId, text: "B" });
			await backdate(a, "2026-01-05T00:00:00Z");
			await backdate(b, "2026-01-06T00:00:00Z");

			const args = {
				clubId: seed.clubId,
				meetingAt: AT("2026-02-10T19:00:00Z"),
				previousMeetingAt: AT("2026-01-10T19:00:00Z"),
			};
			const first = await loadActionItemsForMinutes(args);
			const second = await loadActionItemsForMinutes(args);
			expect(first.open.map((i) => i.id)).toEqual(second.open.map((i) => i.id));
			expect(first.open.map((i) => i.id)).toEqual([a, b]);
		});

		it("does not leak another club's items into the minutes", async () => {
			const other = await seedClub();
			try {
				const mine = await createActionItem({
					clubId: seed.clubId,
					text: "Mine",
				});
				const theirs = await createActionItem({
					clubId: other.clubId,
					text: "Theirs",
				});
				await backdate(mine, "2026-01-05T00:00:00Z");
				await backdate(theirs, "2026-01-05T00:00:00Z");

				const minutes = await loadActionItemsForMinutes({
					clubId: seed.clubId,
					meetingAt: AT("2026-02-10T19:00:00Z"),
					previousMeetingAt: null,
				});
				expect(minutes.open.map((i) => i.id)).toEqual([mine]);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});

	describe("editing and deleting", () => {
		it("updates text, owner and due date", async () => {
			const id = await createActionItem({ clubId: seed.clubId, text: "Old" });
			await updateActionItem({
				clubId: seed.clubId,
				id,
				text: "New",
				ownerMemberId: seed.memberId,
				dueDate: "2026-07-01",
			});
			const [row] = await listActionItems(seed.clubId);
			expect(row.text).toBe("New");
			expect(row.ownerMemberId).toBe(seed.memberId);
			expect(row.dueDate).toBe("2026-07-01");
		});

		it("clears an owner back to the club collectively", async () => {
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Everyone bring a guest",
				ownerMemberId: seed.memberId,
			});
			await updateActionItem({
				clubId: seed.clubId,
				id,
				text: "Everyone bring a guest",
				ownerMemberId: null,
				dueDate: null,
			});
			const [row] = await listActionItems(seed.clubId);
			expect(row.ownerMemberId).toBeNull();
		});

		it("deletes an item", async () => {
			const id = await createActionItem({ clubId: seed.clubId, text: "Bye" });
			await deleteActionItem({ clubId: seed.clubId, id });
			expect(await listActionItems(seed.clubId)).toEqual([]);
		});

		it("cannot delete through another club", async () => {
			const other = await seedClub();
			try {
				const id = await createActionItem({
					clubId: seed.clubId,
					text: "Mine",
				});
				await expect(
					deleteActionItem({ clubId: other.clubId, id }),
				).rejects.toThrow();
				expect(await listActionItems(seed.clubId)).toHaveLength(1);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});
	// -------------------------------------------------------------------------
	// Authorization, behaviorally.
	//
	// `action-items-authz.guard.test.ts` asserts the WIRING (that each server fn
	// awaits the right guard) by reading source, because a `createServerFn`
	// handler cannot be invoked outside a request context. These assert the
	// guards themselves actually reject, which the source grep cannot: together
	// they cover "the server rejects the write, not just the UI".
	// -------------------------------------------------------------------------

	describe("authorization", () => {
		it("the club's own admin passes (positive control for the rejections below)", async () => {
			await expect(
				requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
			).resolves.toMatchObject({ clubRole: "admin" });
		});

		it("rejects a signed-in NON-ADMIN member from the write gate", async () => {
			await expect(
				requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
			).rejects.toThrow(/permission/i);
		});

		it("still lets that same member READ — action items are club business", async () => {
			// The split is the point: hiding an open item from the people who have
			// to act on it would defeat the feature.
			await expect(
				requireClubViewAccess(seed.memberUserId, seed.clubId),
			).resolves.toBeDefined();
		});

		it("rejects an admin of a DIFFERENT club", async () => {
			const other = await seedClub();
			try {
				await expect(
					requireClubRole(other.adminUserId, seed.clubId, ["admin"]),
				).rejects.toThrow(/permission|not a member/i);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});

	describe("guarding the historical record", () => {
		it("refuses to re-close an item, so its resolution date cannot be rewritten", async () => {
			// The DATE is what is under protection. A second close that stamped
			// today would flip this item from resolved back to OPEN in every set of
			// minutes issued between the two closes — the exact instability the
			// whole feature exists to prevent, through the one path nobody used.
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
			});
			await resolveActionItem({ clubId: seed.clubId, id, resolution: "done" });
			const [before] = await listActionItems(seed.clubId);

			await expect(
				resolveActionItem({ clubId: seed.clubId, id, resolution: "dropped" }),
			).rejects.toThrow(/already resolved/i);

			const [after] = await listActionItems(seed.clubId);
			expect(after.resolvedAt).toEqual(before.resolvedAt);
			expect(after.resolution).toBe("done");
		});

		it("refuses to edit a CLOSED item", async () => {
			// Its old text is already printed in every set of minutes issued since
			// it closed. Reopen it first if it genuinely needs correcting.
			const id = await createActionItem({ clubId: seed.clubId, text: "Old" });
			await resolveActionItem({ clubId: seed.clubId, id, resolution: "done" });

			await expect(
				updateActionItem({
					clubId: seed.clubId,
					id,
					text: "Rewritten",
					ownerMemberId: null,
					dueDate: null,
				}),
			).rejects.toThrow(/already closed/i);

			const [row] = await listActionItems(seed.clubId);
			expect(row.text).toBe("Old");
		});

		it("cannot be reopened through another club", async () => {
			const other = await seedClub();
			try {
				const id = await createActionItem({
					clubId: seed.clubId,
					text: "Mine",
				});
				await resolveActionItem({
					clubId: seed.clubId,
					id,
					resolution: "done",
				});
				await expect(
					reopenActionItem({ clubId: other.clubId, id }),
				).rejects.toThrow();
				// Assert the row too: a version that threw AFTER writing would pass a
				// throw-only assertion.
				const [row] = await listActionItems(seed.clubId);
				expect(row.resolvedAt).not.toBeNull();
				expect(row.resolution).toBe("done");
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("cannot be edited through another club", async () => {
			const other = await seedClub();
			try {
				const id = await createActionItem({
					clubId: seed.clubId,
					text: "Mine",
				});
				await expect(
					updateActionItem({
						clubId: other.clubId,
						id,
						text: "Theirs",
						ownerMemberId: null,
						dueDate: null,
					}),
				).rejects.toThrow();
				const [row] = await listActionItems(seed.clubId);
				expect(row.text).toBe("Mine");
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});
});
