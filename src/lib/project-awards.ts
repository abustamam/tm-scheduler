// The award winners as they WILL be once this browser's queued award edits
// drain (#1654, D7). PURE and client-safe: it imports types only.
//
// A queued `setAward` / `clearAward` was typed in this very browser, so showing
// it on the projected deck leaks nothing. `projectAwards` applies, in
// `queuedAt` order, first the overlay (ops that already drained but whose
// effect a server read has not yet confirmed, so the deck never flashes back to
// the pre-queue winner) and then the live queue, on top of the fetched winners.
// Every non-award op is ignored.
import { AWARD_CATEGORIES } from "#/lib/award-categories";
import type { QueuedOp } from "#/lib/offline-minutes-queue";

export type AwardCategoryKey = (typeof AWARD_CATEGORIES)[number];
export type AwardWinner = { category: AwardCategoryKey; name: string };
export type AwardOp = Extract<QueuedOp, { type: "setAward" | "clearAward" }>;

export const isAwardOp = (op: QueuedOp): op is AwardOp =>
	op.type === "setAward" || op.type === "clearAward";

const byQueuedAt = (a: AwardOp, b: AwardOp) => a.queuedAt - b.queuedAt;

export function projectAwards(
	fetched: AwardWinner[] | null,
	queue: QueuedOp[],
	overlay: AwardOp[],
): AwardWinner[] {
	const names = new Map<AwardCategoryKey, string>(
		(fetched ?? []).map((w) => [w.category, w.name]),
	);
	const apply = (op: AwardOp) => {
		if (op.type === "setAward") names.set(op.category, op.name);
		else names.delete(op.category);
	};
	[...overlay].sort(byQueuedAt).forEach(apply);
	queue.filter(isAwardOp).sort(byQueuedAt).forEach(apply);
	const out: AwardWinner[] = [];
	for (const category of AWARD_CATEGORIES) {
		const name = names.get(category)?.trim();
		if (name) out.push({ category, name });
	}
	return out;
}
