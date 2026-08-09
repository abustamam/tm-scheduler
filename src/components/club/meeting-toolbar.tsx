import { Link } from "@tanstack/react-router";
import {
	CheckCircle2,
	ClipboardList,
	Loader2,
	LockOpen,
	Presentation,
} from "lucide-react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { MeetingExportMenu } from "#/components/club/meeting-export-menu";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";

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
}: {
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
}) {
	// Spec D2 primary matrix: guests never get a primary; members get Present
	// on meeting day; only officers get the completed-phase Minutes primary.
	const presentIsPrimary = phase === "today" && (hasIdentity || canManage);
	const minutesIsPrimary = phase === "completed" && canManage;
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
					{/* In-page anchor: the minutes section carries id="minutes"
					    (wired in the route in this same PR). */}
					<a href="#minutes">
						<ClipboardList />
						Minutes
					</a>
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
			{canManage && !locked && hasAddableRoles ? (
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
				>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<LockOpen className="size-4" />
					)}
					Reopen meeting
				</Button>
			) : null}
			{canManage && !locked && canComplete ? (
				<Button size="sm" onClick={onComplete} disabled={lifecycleBusy}>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<CheckCircle2 className="size-4" />
					)}
					Complete meeting
				</Button>
			) : null}
		</div>
	);
}
