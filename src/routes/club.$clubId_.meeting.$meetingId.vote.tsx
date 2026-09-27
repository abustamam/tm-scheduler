import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
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
import { publicShellDecision, sessionMemberFor } from "#/lib/public-shell";
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

/**
 * The signed-in member of this club, resolved on the CLIENT (#962).
 *
 * This route escapes the club shell, so it never receives the shell's
 * `effectiveMemberId` — and the member resolution deliberately stays out of the
 * loader: about twenty phones load it at once, most of them signed out, and
 * `getAuthContext` is not free (it can top up the club's schedule). So a phone
 * with no session costs nothing beyond `useSession`, and only a signed-in one
 * asks the server who it is, through the same `publicShellDecision` the shell
 * uses (`sessionMemberFor`).
 *
 * A member whose ACTIVE club is another one is switched first, exactly as the
 * shell does on any `/club/$clubId` page, because `currentMemberId` is only
 * resolved for the active club. Once, not in a loop: if the switch does not
 * take, they fall back to the signed-out path rather than spinning.
 *
 * `pending` stays true until the answer is known, so a signed-in member is
 * never flashed the "Who are you?" picker while their session loads. A failure
 * to resolve is NOT pending: it degrades to the signed-out behaviour, because a
 * spinner that never ends is worse than a picker during a meeting.
 */
function useSessionVoter(clubId: string): {
	pending: boolean;
	voter: VoterIdentity | null;
} {
	const { data: session, isPending } = authClient.useSession();
	const userId = session?.user?.id ?? null;
	const resolved = useQuery({
		queryKey: ["ballot-session-member", clubId, userId],
		enabled: userId !== null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async () => {
			// Lazy, like `use-offline-minutes.ts`: only a signed-in phone ever needs
			// it, and a static import would pull `#/db` into every suite that
			// imports this route to test something else.
			const { getAuthContext, setActiveClub } = await import(
				"#/server/auth-context"
			);
			const ctx = await getAuthContext();
			if (!publicShellDecision(ctx, clubId).switchActiveTo) {
				return sessionMemberFor(ctx, clubId);
			}
			await setActiveClub({ data: { clubId } });
			return sessionMemberFor(await getAuthContext(), clubId);
		},
	});
	if (isPending) return { pending: true, voter: null };
	if (userId === null) return { pending: false, voter: null };
	if (resolved.isPending) return { pending: true, voter: null };
	const m = resolved.data ?? null;
	return {
		pending: false,
		voter: m ? { kind: "member", id: m.id, name: m.name } : null,
	};
}

function VotePage() {
	const { clubId, clubName, clubNumber, meetingId, digitalVoting } =
		Route.useLoaderData();
	const session = useSessionVoter(clubId);
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
					// stored or picked name, and there is no "not you?" — re-picking
					// would let a signed-in phone vote as someone else. Nothing is
					// written to the per-meeting store, so the pick underneath
					// resurfaces on sign-out.
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
