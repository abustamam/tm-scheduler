// The role-op predicate (#1638), apart from `offline-minutes-queue.ts` so a
// test that mocks the queue module with an explicit export list does not lose it.
import type { QueuedOp, RoleSlotOp } from "#/lib/offline-minutes-queue";

export const isRoleSlotOp = (op: QueuedOp): op is RoleSlotOp =>
	op.type === "assignSlot" || op.type === "releaseSlot";
