import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import {
	Ballot,
	BallotOff,
	type VoterIdentity,
} from "#/components/club/ballot";
import { PickNameForm } from "#/components/club/pick-name-form";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { readStoredMember } from "#/lib/member-identity";
import { getPublicMeetingByKey } from "#/server/meetings";
import { joinBallot } from "#/server/voting";

// Escapes the `/club/$clubId` shell (trailing `_`) so it never hits the
// pick-your-name member gate and never loads the shell's payload — this is the
// PUBLIC, no-auth ballot (#510), reached by scanning a QR in the room. Lean on
// purpose: twenty phones load it simultaneously on conference wifi.
export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/vote")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// An unknown meeting key is a 404, not a 500: `getPublicMeetingByKey`
		// signals it by throwing, and without this the visitor gets the error
		// boundary. Same translation `present` and `word` already do — and it
		// matters more here, because this URL is the one printed on a QR code
		// and handed to a room full of people, so a mistyped or stale key is
		// the expected case rather than the exotic one.
		const detail = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		if (detail.meeting.clubId !== club.id) throw notFound();
		return {
			clubId: club.id,
			clubName: club.name,
			clubNumber: club.clubNumber,
			meetingId: detail.meeting.id,
			// #770 — off means no name picker and no ballot, just the notice.
			digitalVoting: detail.digitalVoting,
		};
	},
	component: VotePage,
	// The loader's `notFound()` lands HERE rather than on the root's generic
	// page (#877). A stale QR is the expected case on this URL, so the person
	// holding the phone should be told it is the MEETING that is missing, in the
	// same words every other meeting sub-route uses.
	notFoundComponent: VoteNotFound,
	head: () => ({
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
});

function VoteNotFound() {
	const { clubId } = Route.useParams();
	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<MeetingNotFound clubId={clubId} />
		</div>
	);
}

const voterKey = (meetingId: string) => `gavelup:voter:${meetingId}`;

function readVoter(meetingId: string): VoterIdentity | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(voterKey(meetingId));
		if (!raw) return null;
		const v = JSON.parse(raw);
		return typeof v?.id === "string" &&
			typeof v?.name === "string" &&
			(v.kind === "member" || v.kind === "guest")
			? v
			: null;
	} catch {
		return null;
	}
}

/** How long the page waits for the session before giving up on it (#962). */
const SESSION_VOTER_TIMEOUT_MS = 3000;

/**
 * The signed-in member this phone votes as, resolved on the CLIENT (#962).
 *
 * The lookup stays out of the loader: about twenty phones load it at once, most
 * of them signed out. So a phone with no session costs nothing beyond
 * `useSession`, and only a signed-in one asks `getBallotSessionVoter`, which is
 * read-only (no cookie, no top-up, no club switch) and resolves the member the
 * same way `castVote` decides whose session may change a vote.
 *
 * The FIRST answer is final for this page view. Until there is one, `pending`
 * is true, so a signed-in member is never flashed the "Who are you?" picker.
 * But waiting is bounded: after `SESSION_VOTER_TIMEOUT_MS`, or on a failed
 * lookup, the answer is "no session member" and the page behaves as signed out.
 * Latching matters because `useSession` can drop and come back on a mounted
 * page, and a late or retried success must not swap the identity under someone
 * who has since picked their name or started voting.
 */
function useSessionVoter(meetingId: string): {
	pending: boolean;
	voter: VoterIdentity | null;
} {
	const { data: session, isPending } = authClient.useSession();
	const userId = session?.user?.id ?? null;
	const resolved = useQuery({
		queryKey: ["ballot-session-voter", meetingId, userId],
		enabled: userId !== null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async () => {
			// Lazy, like `use-offline-minutes.ts`: only a signed-in phone ever needs
			// it, and a static import would pull `#/db` into every suite that
			// imports this route to test something else.
			const { getBallotSessionVoter } = await import(
				"#/server/ballot-session-voter"
			);
			return getBallotSessionVoter({ data: { meetingId } });
		},
	});

	const [decided, setDecided] = useState<{ voter: VoterIdentity | null }>();
	const live: { voter: VoterIdentity | null } | undefined = isPending
		? undefined
		: userId === null
			? { voter: null }
			: resolved.isPending
				? undefined
				: {
						voter: resolved.data
							? {
									kind: "member",
									id: resolved.data.id,
									name: resolved.data.name,
								}
							: null,
					};
	// Set during render: React re-renders at once with the latched value and
	// never commits the intermediate output.
	if (decided === undefined && live !== undefined) setDecided(live);

	const undecided = decided === undefined;
	useEffect(() => {
		if (!undecided) return;
		const timer = setTimeout(
			() => setDecided((d) => d ?? { voter: null }),
			SESSION_VOTER_TIMEOUT_MS,
		);
		return () => clearTimeout(timer);
	}, [undecided]);

	return decided === undefined
		? { pending: true, voter: null }
		: { pending: false, voter: decided.voter };
}

function VotePage() {
	const { clubId, clubName, clubNumber, meetingId, digitalVoting } =
		Route.useLoaderData();
	const session = useSessionVoter(meetingId);
	const [voter, setVoter] = useState<VoterIdentity | null>(() => {
		const stored = readVoter(meetingId);
		if (stored) return stored;
		// Pre-fill from the club-scoped pick the public club page already made, so
		// a regular member never picks their name twice.
		const m = readStoredMember(clubId);
		return m ? { kind: "member", id: m.id, name: m.name } : null;
	});

	function chooseVoter(v: VoterIdentity) {
		localStorage.setItem(voterKey(meetingId), JSON.stringify(v));
		setVoter(v);
	}

	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				<ThemeToggle compact />
			</header>

			<main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-10">
				{!digitalVoting ? (
					<BallotOff clubName={clubName} />
				) : session.pending ? (
					<output className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" aria-hidden />
						Loading your ballot…
					</output>
				) : session.voter ? (
					// Signed in as a member of this club: the session wins over any
					// stored or picked name. There is no "not you?" here, as on `/me`
					// when signed in — a UI choice that says whose phone this is. It
					// is NOT a server rule: the ballot is honour-system and the server
					// would take a first vote from this phone under another name.
					// Nothing is written to the per-meeting store, so the pick
					// underneath resurfaces on sign-out.
					<>
						<Ballot meetingId={meetingId} voter={session.voter} />
						<p className="self-center text-xs text-muted-foreground">
							Voting as {session.voter.name}
						</p>
					</>
				) : voter ? (
					<>
						<Ballot meetingId={meetingId} voter={voter} />
						<Button
							variant="ghost"
							className="self-center text-xs text-muted-foreground"
							onClick={() => {
								localStorage.removeItem(voterKey(meetingId));
								setVoter(null);
							}}
						>
							Voting as {voter.name} — not you?
						</Button>
					</>
				) : (
					<VoterPicker
						clubId={clubId}
						meetingId={meetingId}
						onPick={chooseVoter}
					/>
				)}
			</main>
			<PublicFooter />
		</div>
	);
}

function VoterPicker({
	clubId,
	meetingId,
	onPick,
}: {
	clubId: string;
	meetingId: string;
	onPick: (v: VoterIdentity) => void;
}) {
	const [guestName, setGuestName] = useState("");
	const join = useMutation({
		mutationFn: () =>
			joinBallot({ data: { meetingId, name: guestName.trim() } }),
		onSuccess: (g) => onPick({ kind: "guest", id: g.id, name: g.name }),
	});

	return (
		<div className="flex flex-col gap-6">
			<div className="text-center">
				<h1 className="font-display text-2xl font-semibold">Who are you?</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					So we count one vote per person.
				</p>
			</div>

			<PickNameForm
				clubUuid={clubId}
				onPicked={(m) => onPick({ kind: "member", id: m.id, name: m.name })}
			/>

			<div className="rounded-2xl border border-border bg-card p-5">
				<h2 className="text-sm font-semibold">Visiting us today?</h2>
				<form
					className="mt-3 flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (!guestName.trim() || join.isPending) return;
						join.mutate();
					}}
				>
					<Input
						value={guestName}
						onChange={(e) => setGuestName(e.target.value)}
						placeholder="Your name"
						aria-label="Your name"
					/>
					<Button type="submit" disabled={!guestName.trim() || join.isPending}>
						{join.isPending ? "Joining…" : "Join as a guest"}
					</Button>
					{join.isError ? (
						<p className="text-sm text-destructive">
							Couldn't join — try again, or ask the Vote Counter.
						</p>
					) : null}
				</form>
			</div>
		</div>
	);
}
