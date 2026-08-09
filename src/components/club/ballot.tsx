import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import type { BallotData } from "#/server/voting";
import { getBallot, submitVote } from "#/server/voting";

/** Who this phone is voting as. Meeting-scoped, not club-scoped: a guest
 *  identity is not a standing one, and a shared phone should not carry last
 *  month's pick. */
export interface VoterIdentity {
	kind: "member" | "guest";
	id: string;
	name: string;
}

const CATEGORY_LABELS = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
} as const;

export function Ballot({
	meetingId,
	voter,
}: {
	meetingId: string;
	voter: VoterIdentity;
}) {
	// Polling, not push. The payload is a few hundred bytes; twenty phones on a
	// 5s interval is nothing, and it means no realtime infrastructure exists to
	// reconnect, buffer or proxy.
	const ballot = useQuery({
		queryKey: ["ballot", meetingId],
		queryFn: () => getBallot({ data: { meetingId } }),
		refetchInterval: 5000,
	});

	const [picked, setPicked] = useState<Record<string, string>>({});
	const [failed, setFailed] = useState<Record<string, boolean>>({});

	const cast = useMutation({
		mutationFn: (v: {
			category: keyof typeof CATEGORY_LABELS;
			candidate: { kind: "member" | "guest"; id: string };
		}) =>
			submitVote({
				data: {
					meetingId,
					category: v.category,
					voter: { kind: voter.kind, id: voter.id },
					candidate: v.candidate,
				},
			}),
		onSuccess: (_r, v) => setFailed((f) => ({ ...f, [v.category]: false })),
		onError: (_e, v) => setFailed((f) => ({ ...f, [v.category]: true })),
	});

	if (ballot.isPending) {
		return (
			<div className="flex justify-center py-10">
				<Loader2 className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	const open = Object.entries(ballot.data?.categories ?? {}).filter(
		([, c]) => c.isOpen,
	);

	if (open.length === 0) {
		return (
			<div className="rounded-2xl border border-border bg-card px-6 py-10 text-center">
				<h2 className="font-display text-xl font-semibold">
					Voting isn't open yet
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Hang tight — this page updates by itself when the Vote Counter opens a
					vote.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			{open.map(([category, c]) => {
				const key = category as keyof typeof CATEGORY_LABELS;
				const chosen = picked[key];
				return (
					<section
						key={key}
						className="rounded-2xl border border-border bg-card p-5"
					>
						<h2 className="font-display text-lg font-semibold">
							{CATEGORY_LABELS[key]}
						</h2>
						<div className="mt-4 flex flex-col gap-2">
							{c.candidates.map((cand) => {
								const id = `${cand.kind}:${cand.id}`;
								const isChosen = chosen === id;
								return (
									<Button
										key={id}
										variant={isChosen ? "default" : "outline"}
										// Large tap target: this is used one-handed, standing up,
										// in a room, on a phone.
										className="h-14 justify-start text-base"
										onClick={() => {
											setPicked((p) => ({ ...p, [key]: id }));
											cast.mutate({
												category: key,
												candidate: { kind: cand.kind, id: cand.id },
											});
										}}
									>
										{isChosen ? (
											<CheckCircle2 className="mr-2 size-5" aria-hidden />
										) : null}
										{cand.name}
									</Button>
								);
							})}
						</div>
						{failed[key] ? (
							// The selection is KEPT on failure. A dropped vote that looks
							// cast is worse than a visible retry.
							<p className="mt-3 text-sm text-destructive">
								Couldn't send that — tap your choice again.
							</p>
						) : chosen ? (
							<p className="mt-3 text-sm text-muted-foreground">
								Vote recorded. Tap another name to change it.
							</p>
						) : null}
					</section>
				);
			})}
		</div>
	);
}

export type { BallotData };
