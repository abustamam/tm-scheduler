import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { WRITE_IN_LIMITS, writeInKey } from "#/lib/write-in-limits";
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

type CategoryKey = keyof typeof CATEGORY_LABELS;
type Category = BallotData["categories"][CategoryKey];

/** Someone this phone can vote for: either a row the server listed, or a name
 *  being typed into the write-in field for the first time. The write-in arm has
 *  no id because it has no row yet — `selectionKey` derives one. */
type Nominee =
	| { kind: "member" | "guest"; id: string; name: string }
	| { kind: "writeIn"; name: string };

/**
 * The ONE derivation of a nominee's selection key. Both the candidate buttons
 * and the write-in field route through it, which is what keeps a fresh write-in
 * matching the row that comes back on the next poll: `loadWriteInCandidates`
 * ids a write-in by `writeInKey(name)`, so folding here is what makes
 * `writeIn:${cand.id}` and the just-typed selection the same string.
 *
 * They used to be derived in two places, and the write-in half stored the raw
 * spelling — so the returning button was never ticked for the very voter who
 * typed the name. One function, called from both, is the structural fix.
 */
function selectionKey(n: Nominee): string {
	return n.kind === "writeIn"
		? `writeIn:${writeInKey(n.name)}`
		: `${n.kind}:${n.id}`;
}

/** What this phone has chosen in one category. The NAME is stored alongside the
 *  key because a write-in is not in `c.candidates` until the next poll returns
 *  it, so there would be nothing to name for up to 5s. Once it IS there the
 *  card prefers the listed spelling — see `confirmedName`. */
interface Choice {
	id: string;
	name: string;
}

/** Per category, what happened to the vote this phone last sent. Distinct from
 *  `Choice`: the choice is what the voter tapped, this is whether the SERVER has
 *  it. They are two facts and the ballot must not conflate them — a tap that has
 *  not landed yet, or has failed, must never render as counted (#722). */
type CastState = "sending" | "recorded" | "failed";

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

	const [picked, setPicked] = useState<Record<string, Choice>>({});
	const [cast, setCast] = useState<Record<string, CastState>>({});

	const send = useMutation({
		mutationFn: (v: {
			category: CategoryKey;
			candidate:
				| { kind: "member" | "guest"; id: string }
				| { kind: "writeIn"; name: string };
		}) =>
			submitVote({
				data: {
					meetingId,
					category: v.category,
					voter: { kind: voter.kind, id: voter.id },
					candidate: v.candidate,
				},
			}),
		// Keyed by CATEGORY, not by "the last mutation", because two categories can
		// be open at once and a phone can have both in flight. Each mutation carries
		// its own variables into these callbacks, so the states never cross.
		onSuccess: (_r, v) => setCast((s) => ({ ...s, [v.category]: "recorded" })),
		onError: (_e, v) => setCast((s) => ({ ...s, [v.category]: "failed" })),
	});

	/** Tap-to-cast: the vote goes the moment a name is tapped, and the card says
	 *  "sending" until the server answers. There is deliberately no state in which
	 *  a chosen name is sitting unsent behind a Submit button (#722).
	 *
	 *  One `nominee` in, both derivations here: the local selection key and the
	 *  wire payload. Neither call site computes either. */
	function vote(category: CategoryKey, nominee: Nominee) {
		setPicked((p) => ({
			...p,
			[category]: { id: selectionKey(nominee), name: nominee.name },
		}));
		setCast((s) => ({ ...s, [category]: "sending" }));
		send.mutate({
			category,
			// A write-in posts the NAME, never the folded key: the server re-derives
			// the key, and the first spelling cast stays the display form. Sending
			// the key back would lowercase someone's name on the awards slide the
			// moment a second person voted for them.
			candidate:
				nominee.kind === "writeIn"
					? { kind: "writeIn", name: nominee.name }
					: { kind: nominee.kind, id: nominee.id },
		});
	}

	if (ballot.isPending) {
		return (
			<div className="flex justify-center py-10">
				<Loader2 className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	// A category earns a card only while it is OPEN. Nothing else: a closed one
	// carries no candidates (`loadBallot` withholds them by design) and nothing a
	// voter can do, so its card was a dead rectangle that people tapped and read
	// as a broken app (#722).
	//
	// This reverses #510 review finding 2, which asked that closing a vote not
	// look like never having opened one. That is the right distinction for the
	// Vote Counter's console — which still shows every category and its state,
	// unchanged — and the wrong one for the phone in the room: a voter does not
	// need a tombstone for a vote they can no longer cast.
	//
	// `hasOpened` is the field that finding added, and this component was its
	// only reader. Checked on this branch with `git grep hasOpened -- src`: what
	// is left is the producer (`voting-logic.ts`), two server integration suites
	// asserting it, and this component's test fixtures. Nothing in production
	// reads it — the Vote Counter console imports neither `BallotData` nor
	// `getBallot`. It stays on the payload only because #722 rules out changing
	// `getBallot`; deciding its fate is a separate call.
	const visible = (
		Object.entries(ballot.data?.categories ?? {}) as [CategoryKey, Category][]
	).filter(([, c]) => c.isOpen);

	// Zero open categories covers BOTH "nothing has opened yet" and "the last
	// vote just closed", so the copy must not claim nothing has happened: it says
	// what is true in either case, that no vote is open and the page will notice
	// when one is. Never a blank screen — this is the whole ballot when the room
	// is between votes.
	if (visible.length === 0) {
		return (
			<div className="rounded-2xl border border-border bg-card px-6 py-10 text-center">
				<h2 className="font-display text-xl font-semibold">
					No vote is open right now
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Keep this page open — it updates by itself as soon as the Vote Counter
					opens a vote.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			{/* Read by someone who has never seen this screen, standing up, with
			    about ninety seconds. It says the three things a first-time voter
			    gets wrong: how many votes they get, that tapping IS the vote, and
			    that they are not locked in by tapping. */}
			<p className="text-sm text-muted-foreground">
				One vote per award. Tap a name to cast it — it's counted straight away,
				and you can tap a different name to change it while the vote is open.
			</p>
			{visible.map(([category, c]) => {
				const chosen = picked[category];
				const state = cast[category];
				const nominees: Nominee[] = c.candidates.map((cand) =>
					cand.kind === "writeIn"
						? { kind: "writeIn", name: cand.name }
						: { kind: cand.kind, id: cand.id, name: cand.name },
				);
				// The confirmation names whatever the TICKED BUTTON names. It matters
				// for a write-in: `loadWriteInCandidates` displays the FIRST spelling
				// cast, so a voter who types "bob smith" after someone else cast "Bob
				// Smith" gets a button reading "Bob Smith" — and the card must not then
				// confirm "bob smith" beside it. Falls back to the typed spelling for
				// the up-to-5s window before the poll lists it at all.
				const confirmedName =
					nominees.find((n) => selectionKey(n) === chosen?.id)?.name ??
					chosen?.name;
				return (
					<section
						key={category}
						className="rounded-2xl border border-border bg-card p-5"
					>
						<h2 className="font-display text-lg font-semibold">
							{CATEGORY_LABELS[category]}
						</h2>
						<div className="mt-4 flex flex-col gap-2">
							{nominees.map((nominee) => {
								const id = selectionKey(nominee);
								const isChosen = chosen?.id === id;
								return (
									<Button
										key={id}
										variant={isChosen ? "default" : "outline"}
										// Large tap target: this is used one-handed, standing up,
										// in a room, on a phone.
										className="h-14 justify-start text-base"
										onClick={() => vote(category, nominee)}
									>
										{isChosen ? (
											<CheckCircle2 className="mr-2 size-5" aria-hidden />
										) : null}
										{nominee.name}
									</Button>
								);
							})}
							<WriteInField
								// Keyed by CATEGORY, like every other piece of cast state here.
								// `send.isPending` is one flag for one shared mutation, so it
								// disabled the write-in field of every OTHER open category while
								// a vote was in flight in this one — which is exactly the
								// two-categories-at-once case the states above are keyed for.
								disabled={state === "sending"}
								onSubmit={(name) => vote(category, { kind: "writeIn", name })}
							/>
						</div>
						{/* One live region per card, always mounted so a screen reader
						    announces the change rather than a newly-appearing node.
						    `<output>` rather than `<div role="status">`: same implicit
						    role, and it is the element Biome's a11y rule asks for. */}
						<output className="block">
							{state === "failed" ? (
								// The selection is KEPT on failure, and a failure NEVER reads as
								// counted. A dropped vote that looks cast is worse than a
								// visible retry.
								<p className="mt-3 text-sm font-medium text-destructive">
									Couldn't send that — tap your choice again.
								</p>
							) : state === "sending" ? (
								<p className="mt-3 text-sm text-muted-foreground">
									Sending your vote…
								</p>
							) : state === "recorded" && confirmedName ? (
								// The confirmation the muted sentence never gave: it names who
								// it counted, and it only appears once the SERVER has said yes.
								// Not a button — a "Submit" here would imply the tap had not
								// already cast the vote, which is the opposite of true.
								<p className="mt-3 flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5 text-sm text-foreground">
									<CheckCircle2
										className="size-5 shrink-0 text-primary"
										aria-hidden
									/>
									<span>
										<span className="font-semibold">
											Vote counted for {confirmedName}.
										</span>{" "}
										Tap another name to change it.
									</span>
								</p>
							) : null}
						</output>
					</section>
				);
			})}
		</div>
	);
}

/**
 * "Someone else" — the free-text arm of the ballot (#582).
 *
 * Exists because the derived candidate list cannot contain a Table Topics
 * respondent nobody keyed in, and nobody keys them in: the people who would are
 * running the meeting. So the common case for Best Table Topics is a ballot
 * with a short list or none at all.
 *
 * Collapsed to a link until tapped. The roster names are the answer most of the
 * time, and a text input sitting open under them invites typing a name that is
 * already a button two inches above — which is exactly the duplicate this
 * feature has to avoid. Once a write-in is cast it comes BACK as a button for
 * every later voter (`loadWriteInCandidates`), so the second person to vote for
 * the same person taps rather than types.
 */
function WriteInField({
	onSubmit,
	disabled,
}: {
	onSubmit: (name: string) => void;
	disabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const trimmed = name.trim();

	if (!open) {
		return (
			<Button
				variant="ghost"
				className="h-11 justify-start text-sm text-muted-foreground"
				onClick={() => setOpen(true)}
			>
				Someone else…
			</Button>
		);
	}
	return (
		<form
			className="flex gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!trimmed) return;
				onSubmit(trimmed);
				setName("");
				setOpen(false);
			}}
		>
			<Input
				autoFocus
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Their name"
				// Mirrors the server cap so the field cannot accept what the server
				// will reject. The server is still the boundary — this is a courtesy,
				// not the gate.
				maxLength={WRITE_IN_LIMITS.name}
				className="h-11"
				aria-label="Name of someone not listed"
			/>
			<Button type="submit" className="h-11" disabled={disabled || !trimmed}>
				Vote
			</Button>
		</form>
	);
}
