import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	BookOpenCheck,
	ClipboardList,
	ListChecks,
	Sparkles,
	Vote,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { MEETING_AGENDA_ANCHOR_ID } from "#/lib/meeting-hub";
import type { StoredMember } from "#/lib/member-identity";
import { hasWordOfTheDay } from "#/lib/word-poster";
import { getBallot } from "#/server/voting";

/** How often the strip asks whether a vote is open. Slower than the ballot's
 *  own 5s: this only decides whether a button shows, and every phone that
 *  scanned the agenda is polling it. */
export const ROOM_VOTE_POLL_MS = 10_000;

/** Large, full-width-on-a-phone buttons, 48px minimum height (#913). */
const BIG = "h-auto min-h-12 w-full justify-start text-base";

/**
 * The meeting page "in the room" (#913): the short strip of live calls to action
 * a person sees after scanning the printed agenda's QR (`?room=1`).
 *
 * `visible` is the route's `isInRoom(search) && phase === "today"`, off the
 * route's ONE frozen clock — so the strip does not vanish mid-visit at
 * club-local midnight, like everything else on the page. When it is false the
 * strip renders nothing AND the vote poll is disabled: nothing polls for a
 * button nobody can see.
 *
 * It branches on identity (session member or picked name, handed in exactly as
 * `MeetingPersonalStrip` gets it) and shows only what is live:
 *
 * | # | identified                              | no identity         |
 * |---|-----------------------------------------|---------------------|
 * | 1 | Vote, while ≥1 category is open         | Vote, same rule     |
 * | 2 | What I'm doing today, if they hold a slot | Sign the guest book |
 * | 3 | Word of the Day, if set                 | Word of the Day     |
 * | 4 | Today's agenda (in-page anchor)         | Today's agenda      |
 *
 * plus "Member? Pick your name" under the strip when there is no identity,
 * which opens the page's existing identity picker; the pick lands in the shared
 * member store, so the strip switches columns without a reload.
 *
 * Vote status comes from `getBallot`, the existing PUBLIC read the phone ballot
 * already polls — no new server fn, nothing new exposed. `retry: false` and a
 * status check rather than a data check: TanStack Query keeps the last good
 * `data` through a failed refetch, so reading `data` alone would keep offering
 * Vote on a stale "open". Any error hides the button until the next success.
 * `digitalVoting` off means no poll and no button — no category can open then.
 */
export function MeetingRoomStrip({
	visible,
	clubId,
	meetingKey,
	dbMeetingId,
	digitalVoting,
	member,
	holdsRole,
	wordOfTheDay,
	promptIdentity,
}: {
	visible: boolean;
	/** The club segment as it appears in the URL (slug or uuid). */
	clubId: string;
	/** The meeting's URL key. */
	meetingKey: string;
	/** The meeting's real DB id, which `getBallot` is keyed on. */
	dbMeetingId: string;
	digitalVoting: boolean;
	member: StoredMember | null;
	/** Whether `member` holds any slot in this meeting. Ignored without one. */
	holdsRole: boolean;
	wordOfTheDay: string | null;
	promptIdentity: () => void;
}) {
	const ballot = useQuery({
		queryKey: ["meeting-room-ballot", dbMeetingId],
		queryFn: () => getBallot({ data: { meetingId: dbMeetingId } }),
		enabled: visible && digitalVoting,
		refetchInterval: ROOM_VOTE_POLL_MS,
		retry: false,
	});

	if (!visible) return null;

	const voteOpen =
		digitalVoting &&
		ballot.status === "success" &&
		Object.values(ballot.data.categories).some((c) => c.isOpen);
	const identified = member !== null;
	const params = { clubId, meetingId: meetingKey };

	return (
		<section
			aria-label="In the room"
			data-testid="meeting-room-strip"
			className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
		>
			<div className="grid gap-2 sm:grid-cols-2">
				{voteOpen ? (
					<Button asChild size="lg" className={BIG}>
						<Link to="/club/$clubId/meeting/$meetingId/vote" params={params}>
							<Vote className="size-5" aria-hidden />
							Vote
						</Link>
					</Button>
				) : null}
				{identified ? (
					holdsRole ? (
						<Button asChild size="lg" variant="outline" className={BIG}>
							<Link
								to="/club/$clubId/meeting/$meetingId/me"
								params={params}
								search={{ as: undefined }}
							>
								<ListChecks className="size-5" aria-hidden />
								What I'm doing today
							</Link>
						</Button>
					) : null
				) : (
					<Button asChild size="lg" variant="outline" className={BIG}>
						<Link to="/club/$clubId/guest-book" params={{ clubId }}>
							<BookOpenCheck className="size-5" aria-hidden />
							Sign the guest book
						</Link>
					</Button>
				)}
				{hasWordOfTheDay(wordOfTheDay) ? (
					<Button asChild size="lg" variant="outline" className={BIG}>
						<Link to="/club/$clubId/meeting/$meetingId/word" params={params}>
							<Sparkles className="size-5" aria-hidden />
							Word of the Day
						</Link>
					</Button>
				) : null}
				<Button asChild size="lg" variant="outline" className={BIG}>
					{/* Router-owned hash link, like the toolbar's Minutes primary: a raw
					    `<a href="#…">` makes a history entry the router does not own.
					    `search` is kept so the strip is still there after the jump. */}
					<Link to="." search={true} hash={MEETING_AGENDA_ANCHOR_ID}>
						<ClipboardList className="size-5" aria-hidden />
						Today's agenda
					</Link>
				</Button>
			</div>
			{identified ? null : (
				<button
					type="button"
					onClick={promptIdentity}
					className="text-sm font-medium text-primary underline-offset-4 hover:underline"
				>
					Member? Pick your name
				</button>
			)}
		</section>
	);
}
