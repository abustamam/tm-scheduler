import { Link } from "@tanstack/react-router";
import {
	CalendarX,
	CheckCircle2,
	ClipboardList,
	Loader2,
	LockOpen,
	Megaphone,
	Presentation,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { MeetingExportMenu } from "#/components/club/meeting-export-menu";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";
import { MINUTES_ANCHOR_ID, showsMinutesPrimary } from "#/lib/meeting-anchors";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";

// Lazy on purpose (#931): the sheet pulls in the promo server fns and the PNG
// exporter, which only an officer who opens it needs — and it keeps the
// toolbar importable in jsdom without reaching `#/db`.
const PromoteSheet = lazy(() =>
	import("./promote-sheet").then((m) => ({ default: m.PromoteSheet })),
);

export type MeetingToolbarProps = {
	phase: MeetingPhase;
	clubSlug: string;
	/** URL key (date or uuid) — used by the Present/print links. */
	meetingId: string;
	/** Database uuid — used by the per-meeting role-sheet PDF endpoints. */
	dbMeetingId: string;
	sharePath: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
	// required (not optional) on purpose — optional would let the Word poster
	// affordance vanish for every user if the wiring dropped the prop,
	// silently, with typecheck and suite green (rationale carried from the
	// retired MeetingViewActions).
	wordOfTheDay: string | null;
	/** Session member OR picked anon identity. Gates the phase primary:
	 *  spec D2 keeps guest chrome quiet (review decision 1A) — guests reach
	 *  Present via the export menu instead. */
	hasIdentity: boolean;
	canManage: boolean;
	locked: boolean;
	canComplete: boolean;
	hasAddableRoles: boolean;
	lifecycleBusy: boolean;
	onAddRole: () => void;
	onComplete: () => void;
	onReopen: () => void;
	/** The meeting is cancelled (#1057): the officer edit group and Promote
	 *  go, because every write they lead to is refused server-side; share
	 *  and export stay. Restore lives in the route's banner, not here. */
	cancelled?: boolean;
	/** The route's answer to "may this meeting be cancelled now": an officer
	 *  on a scheduled meeting that is not completed and whose club-local
	 *  date has not passed. The server re-decides under the meeting lock. */
	canCancel?: boolean;
	/** Opens the route's confirm; the write happens there. */
	onCancel?: () => void;
};

/**
 * The meeting view's toolbar (#541 D2): at most four top-level things —
 * a phase-driven primary (today → Present, completed → Minutes anchor,
 * upcoming → none), the share chip, the Print & export menu, and the
 * officer edit group (Add role / Complete meeting, or Reopen meeting when
 * locked). Pure component so the phase × persona matrix is testable in
 * jsdom; the route only wires props and owns the mutation handlers.
 */
export function MeetingToolbar({
	phase,
	clubSlug,
	meetingId,
	dbMeetingId,
	sharePath,
	printLayout,
	deck,
	clubName,
	wordOfTheDay,
	hasIdentity,
	canManage,
	locked,
	canComplete,
	hasAddableRoles,
	lifecycleBusy,
	onAddRole,
	onComplete,
	onReopen,
	// Optional with defaults, unlike `wordOfTheDay` above, and the trade is
	// named: a dropped prop here HIDES Cancel rather than showing a wrong
	// state, and `meeting-cancel-wiring.guard.test.ts` pins the route's
	// wiring of all three, which is the half a prop default cannot see.
	cancelled = false,
	canCancel = false,
	onCancel,
}: MeetingToolbarProps) {
	// Spec D2 primary matrix: guests never get a primary; members get Present
	// on meeting day; only officers get the completed-phase Minutes primary.
	const presentIsPrimary = phase === "today" && (hasIdentity || canManage);
	const minutesIsPrimary = showsMinutesPrimary(phase, canManage);
	const [promoteOpen, setPromoteOpen] = useState(false);
	// The officer edit group as a whole (#1057): nothing in it has a write the
	// server would accept on a cancelled meeting, and a Promote draft for a
	// meeting that is not happening is a flyer nobody should post.
	const canEdit = canManage && !cancelled;
	return (
		<div className="flex flex-wrap items-center gap-2 pt-1">
			{presentIsPrimary ? (
				<Button asChild size="sm" data-testid="toolbar-primary">
					<Link
						to="/club/$clubId/meeting/$meetingId/present"
						params={{ clubId: clubSlug, meetingId }}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Presentation />
						Present
					</Link>
				</Button>
			) : null}
			{minutesIsPrimary ? (
				<Button asChild size="sm" data-testid="toolbar-primary">
					{/* Router-owned hash link, not a raw <a href="#…">: a raw anchor
					    creates a history entry TanStack Router doesn't own — the
					    router's location goes stale and its back/forward index math
					    (and scroll restoration keys) degrade afterward. `Link hash`
					    keeps the navigation inside the router and uses its own hash
					    scrolling. The minutes section carries
					    id={MINUTES_ANCHOR_ID} (wired in the route in this same PR). */}
					<Link to="." hash={MINUTES_ANCHOR_ID}>
						<ClipboardList />
						Minutes
					</Link>
				</Button>
			) : null}
			{/* One label for the SAME action on every audience (#542): officers
			    used to see "Copy member link" here while everyone else saw
			    "Copy share link" — the copied URL is identical. */}
			<ShareLinkButton path={sharePath} />
			<MeetingExportMenu
				clubSlug={clubSlug}
				meetingId={meetingId}
				dbMeetingId={dbMeetingId}
				printLayout={printLayout}
				deck={deck}
				clubName={clubName}
				wordOfTheDay={wordOfTheDay}
				presentIsPrimary={presentIsPrimary}
			/>
			{/* Promote (#931): admin only — `canManage` is the effective-admin
			    answer, the same rule `requireClubRole(…, ["admin"])` states on the
			    server. Drafts only; nothing is sent from here. */}
			{canEdit ? (
				<Button
					size="sm"
					variant="outline"
					onClick={() => setPromoteOpen(true)}
				>
					<Megaphone className="size-4" aria-hidden />
					Promote
				</Button>
			) : null}
			{canEdit && promoteOpen ? (
				<Suspense fallback={null}>
					<PromoteSheet
						open={promoteOpen}
						onOpenChange={setPromoteOpen}
						meetingId={dbMeetingId}
					/>
				</Suspense>
			) : null}
			{canEdit && !locked && hasAddableRoles ? (
				<Button size="sm" variant="outline" onClick={onAddRole}>
					+ Add role
				</Button>
			) : null}
			{canManage && locked ? (
				<Button
					size="sm"
					variant="outline"
					onClick={onReopen}
					disabled={lifecycleBusy}
					// The spinner below is a childless lucide icon, which lucide-react
					// marks aria-hidden — so without this a screen-reader user gets NO
					// signal the mutation is in flight, and `disabled` has already
					// pulled the button out of the focus order. Matches the
					// availability chip in MeetingPersonalStrip, which already does it.
					aria-busy={lifecycleBusy}
				>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<LockOpen className="size-4" />
					)}
					Reopen meeting
				</Button>
			) : null}
			{canEdit && !locked && canComplete ? (
				// `outline`, like every other button in this group: the phase primary
				// is the ONLY filled control in the row (D2). Left at the default
				// (filled) variant, an officer on meeting day saw TWO identically
				// weighted CTAs — Present and Complete meeting — competing for the
				// emphasis the phase primary exists to own. The completed phase
				// already did this correctly (Minutes filled, Reopen outline).
				<Button
					size="sm"
					variant="outline"
					onClick={onComplete}
					disabled={lifecycleBusy}
					aria-busy={lifecycleBusy}
				>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<CheckCircle2 className="size-4" />
					)}
					Complete meeting
				</Button>
			) : null}
			{canEdit && !locked && canCancel ? (
				// Cancel (#1057): beside Complete, same weight, same busy signal.
				// It opens the route's confirm rather than writing — the confirm
				// states what cancelling keeps (every role), what it hides (the
				// meeting, for members) and what it sends (nothing).
				<Button
					size="sm"
					variant="outline"
					onClick={onCancel}
					disabled={lifecycleBusy}
					aria-busy={lifecycleBusy}
				>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<CalendarX className="size-4" />
					)}
					Cancel meeting
				</Button>
			) : null}
		</div>
	);
}
