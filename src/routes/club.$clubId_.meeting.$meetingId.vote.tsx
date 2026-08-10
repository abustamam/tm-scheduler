import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { Ballot, type VoterIdentity } from "#/components/club/ballot";
import { PickNameForm } from "#/components/club/pick-name-form";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { resolveClubOrRedirect } from "#/lib/club-route";
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
		const detail = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		});
		if (detail.meeting.clubId !== club.id) throw notFound();
		return {
			clubId: club.id,
			clubName: club.name,
			clubNumber: club.clubNumber,
			meetingId: detail.meeting.id,
		};
	},
	component: VotePage,
	head: () => ({
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
});

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

function VotePage() {
	const { clubId, clubName, clubNumber, meetingId } = Route.useLoaderData();
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
				{voter ? (
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
