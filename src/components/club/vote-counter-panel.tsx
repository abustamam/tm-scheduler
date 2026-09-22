import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, Lock, LockOpen, Undo2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	DISQUALIFICATION_LIMITS,
	DISQUALIFICATION_PRESETS,
} from "#/lib/disqualification";
import { RULING_NEEDS_SESSION_MESSAGE } from "#/lib/write-proof";
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
 *
 * DISQUALIFICATION AND ITS UNDO ALSO NEED A SESSION (#752), and those two alone.
 * WHY those two and not their neighbours is argued on
 * `requireSignedInVoteCounter` (`guards.ts`), which is the boundary and refuses
 * independently of anything rendered here.
 *
 * What this component adds is the other half: the account-less Ballot Counter
 * must never REACH a control that cannot work, because a refusal mid-meeting
 * with the room watching reads as an outage rather than as policy (ADR-0026's
 * "a control that a session gates must not be SHOWN to a viewer without one").
 * Everything else on this console is unchanged for that viewer: open, close,
 * tally, Table Topics capture, set and clear winner.
 */
export function VoteCounterPanel({
	meetingId,
	selfMemberId,
	sessionMemberId,
	canManageClub,
	onSetWinner,
	onClearWinner,
}: {
	meetingId: string;
	selfMemberId: string | null;
	/**
	 * The viewer's own membership id in this club **from their session**, or null
	 * when they have none (#752).
	 *
	 * A SEPARATE prop from `selfMemberId` rather than a `isSignedIn` boolean, and
	 * both halves of that matter. Separate, because `selfMemberId` is the
	 * localStorage name-pick and is non-null for exactly the caller being
	 * refused — reusing it would predict the opposite of the server's answer. A
	 * member id rather than a flag, because the route passes `managerActorId`
	 * (`session?.id ?? null`), which is the same value the server-side seam
	 * resolves, so the two agree by construction instead of by a rule somebody
	 * has to keep in step.
	 */
	sessionMemberId: string | null;
	/**
	 * The viewer is a club admin **as the server understands it** — `canManage`
	 * from the route, which `canManageClub` grants on an admin membership OR a
	 * `read_write` impersonation and refuses for `read_only` (#752, ADR-0016).
	 *
	 * A SECOND signal rather than folding into `sessionMemberId`, for the reason
	 * `declineFreesRoles` in the meeting route spells out at length: the client
	 * must predict the server's answer PER ARM, and the two arms here have
	 * different evidence. An impersonating superadmin has full admin parity
	 * server-side (`resolveAdminGrant` returns granted on the impersonation
	 * before the self-assert arm is reached) and yet has NO `effectiveMemberId`,
	 * so `sessionMemberId` is null for them. Gating the whole prediction on that
	 * one proxy would hide the ruling controls from the one principal the gate
	 * allows outright, and tell them to sign in while they are signed in — the
	 * exact ADR-0016 regression #762's review caught in six places at once.
	 */
	canManageClub: boolean;
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
	/**
	 * Whether this viewer may reach the two ruling controls at all (#752).
	 *
	 * The gate decides; this only predicts it, per ARM rather than through one
	 * proxy. `canManageClub` stands alone because it is already the server's
	 * answer for the admin arm, which `resolveVoteCounterAuthz` reaches BEFORE
	 * the self-assert arm and which a `read_write` impersonating superadmin
	 * satisfies with no membership id at all. The session term is the one the
	 * self-assert arm needs, and only it.
	 */
	const canRule = canManageClub || sessionMemberId !== null;
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
	 *  One at a time across the whole console: the form takes over the row it
	 *  belongs to, and two open at once on a laptop mid-meeting is noise. */
	const [reasonFor, setReasonFor] = useState<string | null>(null);

	// Clear the open row when the grant goes away, rather than only hiding it.
	// `reasonFor` is state and `open` below is derived, so suppressing the derived
	// value alone leaves the key set — and `sessionMemberId` is
	// `authClient.useSession()`'s answer, which can drop and come back on a
	// mounted panel. On the way back that would re-render a BLANK ReasonForm on a
	// row nobody re-opened, because the form's own `text` state went with the
	// unmount. Set-during-render rather than an effect: React re-renders this
	// component immediately with the new state and never commits the intermediate
	// output, so there is no flash of the stale form and no extra paint.
	if (!canRule && reasonFor !== null) setReasonFor(null);

	const disqualify = useMutation({
		mutationFn: (v: {
			category: AwardCategory;
			candidate: CandidatePayload;
			reason: string;
			/** The row this ruling belongs to, so its pending state disables one
			 *  control rather than every Disqualify button in the console. */
			key: string;
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

	/** Open one candidate's reason form, clearing any previous failure first.
	 *
	 *  The `reset()` is the fix, not decoration: `disqualify` is ONE mutation
	 *  shared by every row, so its `isError`/`error` outlive the form that
	 *  produced them. Without this, failing on Ana and then opening Bo's form
	 *  rendered Ana's rejection under Bo's name before the Vote Counter had
	 *  typed anything — which on a laptop mid-meeting reads as "Bo was refused
	 *  too". Scoping the render by category was the first attempt and was not
	 *  enough: both candidates are in the same category. */
	function openReasonForm(key: string) {
		disqualify.reset();
		setReasonFor(key);
	}

	const undo = useMutation({
		mutationFn: (v: {
			category: AwardCategory;
			candidate: CandidatePayload;
			/** The row this undo belongs to, so a failure renders under THAT name
			 *  rather than under every disqualified row in the console. */
			key: string;
		}) =>
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
				// EVERY ballot in this category, disqualified candidates' included.
				// `results` is eligible-only since #723, so summing it alone made
				// "N votes in" DROP when a ruling landed — under-reporting how many
				// people actually voted, which is the one thing this line means. The
				// exclusion belongs to the winner list, not to the participation
				// count; `loadParticipation`, which the projector reads, counts rows.
				const total =
					(t?.results.reduce((n, r) => n + r.count, 0) ?? 0) +
					(t?.disqualified.reduce((n, r) => n + r.count, 0) ?? 0);
				const top = t?.results[0]?.count ?? 0;
				const tied = (t?.results ?? []).filter(
					(r) => r.count === top && top > 0,
				);

				const rowKey = (r: TallyEntry) => `${category}:${r.kind}:${r.id}`;

				/**
				 * One candidate row: the name (with its count when the vote is
				 * closed), the disqualify control, and — when this is the row the
				 * Vote Counter opened — the reason form STACKED BENEATH it at full
				 * width, with the row's other controls out of the way.
				 *
				 * The form used to be returned into the row's right-hand control
				 * slot, which is a `flex items-center gap-1` beside "Set winner": a
				 * ~150px card wedged into a one-line row, vertically centred against
				 * the name, with the preset chips overflowing because
				 * `buttonVariants` carries `shrink-0 whitespace-nowrap` and
				 * "Spoke outside the qualifying window" is ~250px of unbreakable
				 * text. Giving the form the row is what makes it usable, and it is
				 * what the comment on `reasonFor` always claimed happened.
				 */
				const candidateRow = (r: TallyEntry, trailing?: React.ReactNode) => {
					const key = rowKey(r);
					// `&& canRule`, because `reasonFor` is STATE and outlives the prop
					// that opened it. The panel stays mounted across a session ending
					// (the route re-renders with `managerActorId` null), and without
					// this the row's Disqualify button disappears while the form it
					// opened stays on screen with a live submit path — the affordance
					// ADR-0026 says must go, still reachable by the one caller who
					// already had it open. Belt and braces with the gate, which refuses
					// either way.
					const open = reasonFor === key && canRule;
					return (
						<div key={key} className="flex flex-col gap-2">
							<div className="flex items-start justify-between gap-3">
								<span className="text-sm">
									{r.name}
									{t && !t.isOpen ? ` — ${r.count}` : ""}
								</span>
								{open ? null : (
									<div className="flex items-center gap-1">
										{/* #752. The row keeps its name, its count and its
										    `trailing` control (Set winner); only the ruling
										    affordance goes, and the card says once why. */}
										{canRule ? (
											<Button
												size="sm"
												variant="ghost"
												className="text-muted-foreground"
												// Scoped to THIS row. `disqualify.isPending` is one flag
												// for one shared mutation, so the bare form greyed every
												// Disqualify button in every category while one was in
												// flight — the one-flag-many-rows shape `ballot.tsx`
												// documents having already fixed for `send.isPending`.
												disabled={
													disqualify.isPending &&
													disqualify.variables?.key === key
												}
												onClick={() => openReasonForm(key)}
											>
												<Ban className="mr-1 size-4" aria-hidden />
												<span className="sr-only">Disqualify {r.name}</span>
												<span aria-hidden>Disqualify</span>
											</Button>
										) : null}
										{trailing}
									</div>
								)}
							</div>
							{open ? (
								<ReasonForm
									name={r.name}
									pending={disqualify.isPending}
									// No category comparison: `openReasonForm` resets the
									// mutation, so any error still set belongs to the form that
									// is open.
									error={
										disqualify.isError
											? (disqualify.error as Error).message
											: null
									}
									onCancel={() => setReasonFor(null)}
									onSubmit={(reason) =>
										disqualify.mutate({
											category,
											candidate: candidatePayload(r),
											reason,
											key,
										})
									}
								/>
							) : null}
						</div>
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

						{/* #752. Said ONCE per card, immediately above the lists whose
						    controls are missing, and only on a card that would otherwise
						    have offered one — per row it would repeat for every candidate,
						    and once for the whole console it would sit too far from the
						    absence it explains. A card with nothing to rule on says
						    nothing.

						    The sentence is imported from `#/lib/write-proof`, which is
						    where the GATE's refusal also comes from, so the console and
						    the server cannot be reworded apart. It names both routes back
						    rather than offering a "Sign in" button, because the person who
						    most often needs to act is an officer standing next to the
						    phone, not the person holding it. */}
						{!canRule &&
						t &&
						(t.results.length > 0 || t.disqualified.length > 0) ? (
							<p className="mt-2 text-xs text-muted-foreground">
								{RULING_NEEDS_SESSION_MESSAGE}
							</p>
						) : null}

						{/* While the vote is OPEN: names with no counts, so a candidate can
						    be ruled out mid-vote without turning this into a live
						    leaderboard.
						
						    Sorted BY NAME, and that is the load-bearing half. `loadTally`
						    ranks `results` by count descending, so rendering its order
						    straight through hid the digits and kept the ranking: row one
						    was the current leader and the list reshuffled every 5s poll.
						    Worse than the leak, the reshuffle moved rows under the cursor
						    of a destructive control that by design has no confirm step —
						    aim at Alice's Disqualify, a poll lands, and the button under
						    the pointer is Bob's. Alphabetical is stable and says nothing. */}
						{t?.isOpen && t.results.length > 0 ? (
							<div className="mt-3 flex flex-col gap-2">
								<p className="text-xs font-medium text-muted-foreground">
									Candidates
								</p>
								{[...t.results]
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((r) => candidateRow(r))}
							</div>
						) : null}

						{/* Counts are visible HERE and nowhere else. The projector gets a
						    participation badge only — a live leaderboard in the room
						    produces bandwagon voting and kills the reveal.
						
						    The candidate list renders whenever the category is CLOSED,
						    including with zero votes in. Gating it on `total > 0` meant a
						    category closed before anyone voted listed no candidates at
						    all, so nobody could be ruled out there — against #723's "any
						    candidate in any category". Only the tie notice and the winner
						    buttons need a vote to make sense. */}
						{t && !t.isOpen ? (
							<div className="mt-3 flex flex-col gap-2">
								{tied.length > 1 ? (
									<p className="text-sm font-medium text-warning-foreground">
										{tied.length} tied on {top} — pick the winner.
									</p>
								) : null}
								{t.results.map((r) =>
									candidateRow(
										r,
										total > 0 ? (
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
										) : null,
									),
								)}
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
								{t.disqualified.map((r) => {
									const key = rowKey(r);
									const busy = undo.isPending && undo.variables?.key === key;
									return (
										<div key={key} className="flex flex-col gap-1">
											<div className="flex items-start justify-between gap-3">
												<span className="text-sm text-muted-foreground">
													<span className="line-through">{r.name}</span>
													{" — "}
													{/* The zero case is the NORMAL one when the Vote
													    Counter rules someone out early, which is the
													    whole reason the control is reachable while the
													    vote is open. "0 excluded" implies something was
													    taken away and reads as a bug. */}
													{r.count === 0
														? "no votes to exclude"
														: `${r.count} ${r.count === 1 ? "vote" : "votes"} excluded`}
													<span className="block text-xs">{r.reason}</span>
												</span>
												{/* #752, same rule as the Disqualify control above:
												    undoing is itself a ruling on a named member's
												    record, it is gated by the same server fn pair,
												    and it is the correction path for something
												    already announced to the room — the worst place
												    to discover a refusal. The ruling, its reason and
												    its excluded count all stay rendered. */}
												{canRule ? (
													<Button
														size="sm"
														variant="ghost"
														// Scoped to this row, like the disqualify control:
														// one shared mutation must not grey every Undo in
														// the console.
														disabled={busy}
														onClick={() =>
															undo.mutate({
																category,
																candidate: candidatePayload(r),
																key,
															})
														}
													>
														{busy ? (
															<Loader2
																className="mr-1 size-4 animate-spin"
																aria-hidden
															/>
														) : (
															<Undo2 className="mr-1 size-4" aria-hidden />
														)}
														<span className="sr-only">
															Undo disqualification of {r.name}
														</span>
														<span aria-hidden>Undo</span>
													</Button>
												) : null}
											</div>
											{/* A failed undo used to say NOTHING: the row stayed put,
											    the button re-enabled, and "nothing happened" is
											    indistinguishable from a slow poll. This is the
											    correction path for a ruling already announced to the
											    room, and it was the one new mutation with no error
											    surface at all. */}
											{undo.isError && undo.variables?.key === key ? (
												<p className="text-xs font-medium text-destructive">
													{(undo.error as Error).message}
												</p>
											) : null}
										</div>
									);
								})}
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
 * The two common rulings (`DISQUALIFICATION_PRESETS`) FILL THE FIELD; they do
 * not commit. That is deliberate and was changed in review. Tapping a chip used
 * to write the ruling immediately, but two same-size outline chips sitting above
 * a primary "Disqualify" button read universally as "pick a reason, then press
 * Disqualify" — so the affordance invited exactly the mis-tap it could least
 * afford, against a named person, with no confirm step. Filling the field costs
 * one extra tap on the common case and buys a single commit point plus
 * symmetry: preset and free text now travel the same path.
 *
 * The free text arm exists because a club will have a third reason nobody
 * anticipated, and a closed vocabulary would push that back into the
 * console-only flag this feature replaces.
 *
 * There is still no confirm dialog. The ruling is undoable in one tap from the
 * list it lands in, which is a better guard: it is visible afterwards rather
 * than only before.
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
						type="button"
						size="sm"
						variant="outline"
						disabled={pending}
						onClick={() => setText(preset)}
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
					// Matches `WriteInField` on the ballot, which autofocuses for the
					// same reason: the field appeared because the operator asked for
					// it, and this console is used under time pressure. Without it the
					// click that opened the form also destroyed the focused node, so
					// focus fell to <body> and a keyboard user lost their place.
					autoFocus
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
					{/* `disabled` alone only fades the button, telling the operator
					    neither that anything is happening nor which control they hit —
					    the reason `personal-meeting-body.tsx` ships a spinner beside
					    its own pending state rather than relying on the fade. */}
					{pending ? (
						<>
							<Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
							<span className="sr-only">Disqualifying…</span>
							<span aria-hidden>Disqualify</span>
						</>
					) : (
						"Disqualify"
					)}
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
