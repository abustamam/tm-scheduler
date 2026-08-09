import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "#/components/ui/button";
import type { AwardCategory } from "#/server/minutes-logic";
import { closeVoteFn, getVoteTally, openVoteFn } from "#/server/voting";

const CATEGORY_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as AwardCategory[];

/**
 * The Ballot Counter's console (#510 Task 10): per award category, open/close
 * the vote, watch the count arrive (polled — a live leaderboard belongs
 * nowhere near the projector), see who has voted, and — once closed — confirm
 * a winner.
 *
 * Deliberately does NOT auto-write an award on close. `onSetWinner` is always
 * an explicit human tap, so a tie, a winner who left early, or a late paper
 * slip are all handled by the person running the room rather than a rule that
 * has to anticipate them.
 */
export function VoteCounterPanel({
	meetingId,
	selfMemberId,
	onSetWinner,
}: {
	meetingId: string;
	selfMemberId: string | null;
	/** Calls the EXISTING setAward path the minutes UI already uses — the winner
	 *  lives in `meeting_awards`, not in the vote tables. */
	onSetWinner: (
		category: AwardCategory,
		winner: { kind: "member" | "guest"; id: string },
	) => void;
}) {
	const qc = useQueryClient();
	const tally = useQuery({
		queryKey: ["vote-tally", meetingId],
		queryFn: () => getVoteTally({ data: { meetingId, selfMemberId } }),
		refetchInterval: 5000,
	});

	const toggle = useMutation({
		mutationFn: (v: { category: AwardCategory; open: boolean }) =>
			v.open
				? openVoteFn({
						data: { meetingId, category: v.category, selfMemberId },
					})
				: closeVoteFn({
						data: { meetingId, category: v.category, selfMemberId },
					}),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: ["vote-tally", meetingId] }),
	});

	return (
		<div className="flex flex-col gap-4">
			{CATEGORIES.map((category) => {
				const t = tally.data?.[category];
				const total = t?.results.reduce((n, r) => n + r.count, 0) ?? 0;
				const top = t?.results[0]?.count ?? 0;
				const tied = (t?.results ?? []).filter(
					(r) => r.count === top && top > 0,
				);
				return (
					<section
						key={category}
						className="rounded-xl border border-border bg-card p-4"
					>
						<div className="flex items-center justify-between gap-3">
							<h3 className="font-semibold">{CATEGORY_LABELS[category]}</h3>
							<Button
								size="sm"
								variant={t?.isOpen ? "destructive" : "default"}
								disabled={toggle.isPending}
								onClick={() => toggle.mutate({ category, open: !t?.isOpen })}
							>
								{t?.isOpen ? (
									<>
										<Lock className="mr-1 size-4" aria-hidden /> Close voting
									</>
								) : (
									<>
										<LockOpen className="mr-1 size-4" aria-hidden /> Open voting
									</>
								)}
							</Button>
						</div>

						<p className="mt-2 text-sm text-muted-foreground">
							{total} {total === 1 ? "vote" : "votes"} in
						</p>

						{/* Counts are visible HERE and nowhere else. The projector gets a
						    participation badge only — a live leaderboard in the room
						    produces bandwagon voting and kills the reveal. */}
						{t && !t.isOpen && total > 0 ? (
							<div className="mt-3 flex flex-col gap-2">
								{tied.length > 1 ? (
									<p className="text-sm font-medium text-warning-foreground">
										{tied.length} tied on {top} — pick the winner.
									</p>
								) : null}
								{t.results.map((r) => (
									<div
										key={`${r.kind}:${r.id}`}
										className="flex items-center justify-between gap-3"
									>
										<span className="text-sm">
											{r.name} — {r.count}
										</span>
										<Button
											size="sm"
											variant="outline"
											onClick={() =>
												onSetWinner(category, { kind: r.kind, id: r.id })
											}
										>
											Set winner
										</Button>
									</div>
								))}
							</div>
						) : null}

						{t?.voterNames.length ? (
							/* WHO voted, never WHAT they voted for. Lets the Ballot Counter
							   spot a ballot from someone who already went home. */
							<details className="mt-3">
								<summary className="cursor-pointer text-xs text-muted-foreground">
									Who has voted ({t.voterNames.length})
								</summary>
								<p className="mt-1 text-xs text-muted-foreground">
									{t.voterNames.join(" · ")}
								</p>
							</details>
						) : null}
					</section>
				);
			})}
		</div>
	);
}
