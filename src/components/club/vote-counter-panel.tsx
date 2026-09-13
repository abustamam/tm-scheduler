import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Lock, LockOpen, Undo2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	DISQUALIFICATION_LIMITS,
	DISQUALIFICATION_PRESETS,
} from "#/lib/disqualification";
import type { AwardCategory } from "#/server/minutes-logic";
import {
	closeVoteFn,
	disqualifyCandidateFn,
	getVoteTally,
	openVoteFn,
	undoDisqualificationFn,
} from "#/server/voting";

const CATEGORY_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as AwardCategory[];

/** One entry in a category's candidate list, as the tally reports it. Derived
 *  off the server payload rather than re-declared, so the console cannot
 *  disagree with what `loadTally` actually sends. */
type TallyEntry = Awaited<
	ReturnType<typeof getVoteTally>
>["categories"][AwardCategory]["results"][number];

/** Who a disqualify/undo call names. A write-in has no row, so it travels as
 *  its NAME — the same asymmetry `castVote` carries, and for the same reason. */
type CandidatePayload =
	| { kind: "member" | "guest"; id: string }
	| { kind: "writeIn"; name: string };

function candidatePayload(r: {
	kind: "member" | "guest" | "writeIn";
	id: string;
	name: string;
}): CandidatePayload {
	return r.kind === "writeIn"
		? { kind: "writeIn", name: r.name }
		: { kind: r.kind, id: r.id };
}

/**
 * The Ballot Counter's console (#510 Task 10): per award category, open/close
 * the vote, watch the count arrive (polled — a live leaderboard belongs
 * nowhere near the projector), see who has voted, rule a candidate out of the
 * award (#723), and — once closed — confirm a winner.
 *
 * Deliberately does NOT auto-write an award on close. `onSetWinner` is always
 * an explicit human tap, so a tie, a winner who left early, or a late paper
 * slip are all handled by the person running the room rather than a rule that
 * has to anticipate them.
 *
 * `onClearWinner` is the undo for a mis-tapped `onSetWinner` (#510): the only
 * other reachable "Clear" control lives in the admin-only minutes AwardsSection
 * (`meeting-minutes.tsx`), which a non-admin Vote Counter never sees — this
 * console is otherwise their only avenue to `clearMinutesAward`, so without a
 * button here the grant would be real server-side but unreachable in practice.
 * Shown whenever the category is closed, independent of the tally: a mistaken
 * award can exist even with zero votes recorded (e.g. set from a previous
 * session), and `clearMinutesAward` is a harmless no-op when nothing is set.
 *
 * DISQUALIFICATION is reachable while the vote is OPEN, which is the whole
 * point of it (#723): the Vote Counter rules someone out so the room stops
 * spending votes on a candidate who cannot win, and a control that only
 * appeared after the close would arrive too late to do that. So an open
 * category now renders its candidate list — WITHOUT counts. That omission is
 * load-bearing, not an oversight: the closed-vote list below carries counts
 * because the winner is picked off them, and showing them while the vote runs
 * would put a live leaderboard in front of the person announcing the result.
 */
export function VoteCounterPanel({
	meetingId,
	selfMemberId,
	onSetWinner,
	onClearWinner,
}: {
	meetingId: string;
	selfMemberId: string | null;
	/** Calls the EXISTING setAward path the minutes UI already uses — the winner
	 *  lives in `meeting_awards`, not in the vote tables. */
	onSetWinner: (
		category: AwardCategory,
		winner:
			| { kind: "member" | "guest"; id: string }
			| { kind: "writeIn"; name: string },
	) => void;
	/** Calls the EXISTING clearAward path — see the doc comment above. */
	onClearWinner: (category: AwardCategory) => void;
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

	/** Which candidate's reason form is open, as `${category}:${kind}:${id}`.
	 *  One at a time across the whole console: the form replaces the row it
	 *  belongs to, and two open at once on a laptop mid-meeting is noise. */
	const [reasonFor, setReasonFor] = useState<string | null>(null);

	const disqualify = useMutation({
		mutationFn: (v: {
			category: AwardCategory;
			candidate: CandidatePayload;
			reason: string;
		}) =>
			disqualifyCandidateFn({
				data: {
					meetingId,
					category: v.category,
					candidate: v.candidate,
					reason: v.reason,
					selfMemberId,
				},
			}),
		onSuccess: () => {
			setReasonFor(null);
			return qc.invalidateQueries({ queryKey: ["vote-tally", meetingId] });
		},
	});

	const undo = useMutation({
		mutationFn: (v: { category: AwardCategory; candidate: CandidatePayload }) =>
			undoDisqualificationFn({
				data: {
					meetingId,
					category: v.category,
					candidate: v.candidate,
					selfMemberId,
				},
			}),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: ["vote-tally", meetingId] }),
	});

	return (
		<div className="flex flex-col gap-4">
			{CATEGORIES.map((category) => {
				// `getVoteTally` now also carries the Table Topics speaker list
				// (#510) alongside the per-category tally, so the counts live one
				// level down under `categories`.
				const t = tally.data?.categories[category];
				const total = t?.results.reduce((n, r) => n + r.count, 0) ?? 0;
				const top = t?.results[0]?.count ?? 0;
				const tied = (t?.results ?? []).filter(
					(r) => r.count === top && top > 0,
				);

				/** The disqualify control, plus its reason form when this is the row
				 *  the Vote Counter opened. Shared by the open and closed lists so the
				 *  two cannot drift on what a ruling costs. */
				const disqualifyControl = (r: TallyEntry) => {
					const key = `${category}:${r.kind}:${r.id}`;
					if (reasonFor === key) {
						return (
							<ReasonForm
								name={r.name}
								pending={disqualify.isPending}
								error={
									disqualify.isError &&
									disqualify.variables?.category === category
										? (disqualify.error as Error).message
										: null
								}
								onCancel={() => setReasonFor(null)}
								onSubmit={(reason) =>
									disqualify.mutate({
										category,
										candidate: candidatePayload(r),
										reason,
									})
								}
							/>
						);
					}
					return (
						<Button
							size="sm"
							variant="ghost"
							className="text-muted-foreground"
							disabled={disqualify.isPending}
							onClick={() => setReasonFor(key)}
						>
							<Ban className="mr-1 size-4" aria-hidden />
							<span className="sr-only">Disqualify {r.name}</span>
							<span aria-hidden>Disqualify</span>
						</Button>
					);
				};

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

						{/* While the vote is OPEN: names with no counts, so a candidate can
						    be ruled out mid-vote without turning this into a live
						    leaderboard. See the component doc comment. */}
						{t?.isOpen && t.results.length > 0 ? (
							<div className="mt-3 flex flex-col gap-2">
								{t.results.map((r) => (
									<div
										key={`${r.kind}:${r.id}`}
										className="flex items-center justify-between gap-3"
									>
										<span className="text-sm">{r.name}</span>
										{disqualifyControl(r)}
									</div>
								))}
							</div>
						) : null}

						{/* Counts are visible HERE and nowhere else. The projector gets a
						    participation badge only — a live leaderboard in the room
						    produces bandwagon voting and kills the reveal. */}
						{t && !t.isOpen ? (
							<div className="mt-3 flex flex-col gap-2">
								{total > 0 ? (
									<>
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
												<div className="flex items-center gap-1">
													{disqualifyControl(r)}
													<Button
														size="sm"
														variant="outline"
														onClick={() =>
															onSetWinner(
																category,
																// A write-in has no row to point at, so the award
																// carries the NAME. `r.name` is the first spelling
																// cast, which is what the room saw on the ballot.
																candidatePayload(r),
															)
														}
													>
														Set winner
													</Button>
												</div>
											</div>
										))}
									</>
								) : null}
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="self-start text-muted-foreground"
									onClick={() => onClearWinner(category)}
								>
									Clear winner
								</Button>
							</div>
						) : null}

						{/* Ruled out (#723). Shown in EVERY window state, open or closed:
						    this is the only place the ruling can be undone, and a Vote
						    Counter who mistyped must not have to re-open the vote to fix
						    it. The excluded count is shown rather than hidden — "3 votes,
						    excluded" is the sentence they have to be able to give the
						    room. */}
						{t?.disqualified.length ? (
							<div className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
								<p className="text-xs font-medium text-muted-foreground">
									Disqualified — votes kept on file, excluded from the count
								</p>
								{t.disqualified.map((r) => (
									<div
										key={`${r.kind}:${r.id}`}
										className="flex items-start justify-between gap-3"
									>
										<span className="text-sm text-muted-foreground">
											<span className="line-through">{r.name}</span> — {r.count}{" "}
											excluded
											<span className="block text-xs">{r.reason}</span>
										</span>
										<Button
											size="sm"
											variant="ghost"
											disabled={undo.isPending}
											onClick={() =>
												undo.mutate({
													category,
													candidate: candidatePayload(r),
												})
											}
										>
											<Undo2 className="mr-1 size-4" aria-hidden />
											<span className="sr-only">
												Undo disqualification of {r.name}
											</span>
											<span aria-hidden>Undo</span>
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

/**
 * Capture the reason a candidate is being ruled out.
 *
 * The two rulings the Timer's own printed script already describes are one tap
 * each (`DISQUALIFICATION_PRESETS`), because they are what almost every real
 * disqualification is and the person using this is running a meeting. The free
 * text arm exists because a club will have a third reason nobody anticipated,
 * and a closed vocabulary would push that back into the console-only flag this
 * feature replaces.
 *
 * There is no confirm step. The ruling is undoable in one tap from the list it
 * lands in, which is a better guard than a dialog: it is visible afterwards
 * rather than only before.
 */
function ReasonForm({
	name,
	pending,
	error,
	onSubmit,
	onCancel,
}: {
	name: string;
	pending: boolean;
	error: string | null;
	onSubmit: (reason: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState("");
	const trimmed = text.trim();
	return (
		<div className="flex w-full flex-col gap-2 rounded-lg border border-border p-2">
			<p className="text-xs text-muted-foreground">
				Why can't {name} win this award?
			</p>
			<div className="flex flex-wrap gap-1">
				{DISQUALIFICATION_PRESETS.map((preset) => (
					<Button
						key={preset}
						size="sm"
						variant="outline"
						disabled={pending}
						onClick={() => onSubmit(preset)}
					>
						{preset}
					</Button>
				))}
			</div>
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!trimmed) return;
					onSubmit(trimmed);
				}}
			>
				<Input
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="Another reason"
					// Mirrors the server cap so the field cannot accept what the server
					// will reject. The server is still the boundary — this is a
					// courtesy, not the gate.
					maxLength={DISQUALIFICATION_LIMITS.reason}
					className="h-9"
					aria-label={`Reason ${name} can't win`}
				/>
				<Button type="submit" size="sm" disabled={pending || !trimmed}>
					Disqualify
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={pending}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</form>
			{error ? (
				<p className="text-xs font-medium text-destructive">{error}</p>
			) : null}
		</div>
	);
}
