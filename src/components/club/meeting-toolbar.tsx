import { Link } from "@tanstack/react-router";
import {
	CalendarX,
	CheckCircle2,
	ChevronDown,
	ClipboardList,
	ListChecks,
	Loader2,
	LockOpen,
	Megaphone,
	Plus,
	Presentation,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { MeetingExportMenu } from "#/components/club/meeting-export-menu";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { Slide } from "#/lib/agenda-slides";
import { MINUTES_ANCHOR_ID, showsMinutesPrimary } from "#/lib/meeting-anchors";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";

// Lazy on purpose (#931): the sheet pulls in the promo server fns and the PNG
// exporter, which only an officer who opens it needs — and it keeps the
// toolbar importable in jsdom without reaching `#/db`.
const PromoteSheet = lazy(() =>
	import("./promote-sheet").then((m) => ({ default: m.PromoteSheet })),
);

/** The lifecycle writes a meeting page can have in flight (#1057). */
export type LifecycleAction = "complete" | "reopen" | "cancel" | "restore";

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
	/** WHICH lifecycle write is in flight (#1057). Every lifecycle button
	 *  disables while `lifecycleBusy`, but only this one spins and carries
	 *  `aria-busy` — Complete and Cancel used to share one spinner. Absent, the
	 *  old behaviour: every busy button spins. */
	busyAction?: LifecycleAction | null;
	/** The route's answer to "may this viewer draft a lineup blast" (#1024).
	 *  Optional with a closed default, like Cancel: a dropped prop hides the
	 *  item rather than showing a wrong one, and the route wiring guard pins
	 *  it. */
	canLineupBlast?: boolean;
	/** Opens the route's lineup blast sheet; the draft happens there. */
	onLineupBlast?: () => void;
};

/**
 * Is "I'll be there" the ONE filled button in the meeting's action area
 * (#1307, DESIGN.md)? The personal strip's `primary` prop. It leads except
 * where another control owns the emphasis: an officer on the day (Present),
 * after the meeting (Minutes for an officer, nothing for a member) and on a
 * cancelled meeting (Restore). Lives here, beside the toolbar rules it
 * mirrors, so the phase x persona table is testable without the route.
 */
export function stripIsPrimary({
	phase,
	cancelled,
	canManage,
}: {
	phase: MeetingPhase;
	cancelled: boolean;
	canManage: boolean;
}): boolean {
	return (
		!cancelled && phase !== "completed" && !(phase === "today" && canManage)
	);
}

/**
 * The meeting view's toolbar (#541 D2): at most four top-level things —
 * a phase-driven primary (today → Present, completed → Minutes anchor,
 * upcoming → none), the share chip, the Print & export menu, and one
 * "Manage" menu holding the officer extras and Lineup blast (#1307). Pure component so the phase × persona matrix is testable in
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
	busyAction,
	canLineupBlast = false,
	onLineupBlast,
}: MeetingToolbarProps) {
	// Spec D2 primary matrix: guests never get a primary; members get Present
	// on meeting day; only officers get the completed-phase Minutes primary.
	// Neither on a cancelled meeting (#1057): there is nothing to present and
	// no minutes to take, and the phase primary is the one filled control in
	// the row, so it would be the loudest thing on a page about a meeting that
	// is not happening. The export menu hands Present back, as on any other day.
	const presentIsPrimary =
		!cancelled && phase === "today" && (hasIdentity || canManage);
	const minutesIsPrimary = !cancelled && showsMinutesPrimary(phase, canManage);
	const spins = (action: LifecycleAction) =>
		lifecycleBusy && (busyAction == null || busyAction === action);
	const [promoteOpen, setPromoteOpen] = useState(false);
	// The officer edit group as a whole (#1057): nothing in it has a write the
	// server would accept on a cancelled meeting, and a Promote draft for a
	// meeting that is not happening is a flyer nobody should post.
	const canEdit = canManage && !cancelled;
	// Whether the Manage menu has any item (#1307). Each item below spells its
	// own gate inline, as its button did, because
	// `meeting-cancel-wiring.guard.test.ts` pins those exact expressions. This
	// must be true whenever ANY item's gate is: Promote is `canEdit`, and Add
	// role / Complete / Cancel are all `canEdit && …`, so `canEdit` already
	// covers them; the two gates `canEdit` does NOT cover are Lineup blast and
	// Reopen (`canManage && locked`, which stays on a cancelled meeting). A new
	// item with a gate outside those needs a term here; the property test in
	// meeting-toolbar.test.tsx (trigger renders iff the menu has an item) fails
	// if it is missed.
	const showReopen = canManage && locked;
	const showManage = canEdit || canLineupBlast || showReopen;
	// The trigger spins only for a write that lives in this menu. Restore is the
	// cancelled banner's button, so it never makes Manage busy; an absent
	// `busyAction` keeps the old rule (every busy control spins), as `spins` does.
	const manageBusy =
		lifecycleBusy && (busyAction == null || busyAction !== "restore");
	return (
		<div className="flex flex-wrap items-center gap-2 pt-1">
			{presentIsPrimary ? (
				<Button
					asChild
					size="touch"
					// Filled only for an officer (#1307): a member's one filled
					// button on the day is "I'll be there".
					variant={canManage ? "default" : "outline"}
					data-testid="toolbar-primary"
				>
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
				<Button asChild size="touch" data-testid="toolbar-primary">
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
			<ShareLinkButton
				path={sharePath}
				className="h-11 gap-2 md:h-8 md:gap-1.5"
			/>
			<MeetingExportMenu
				clubSlug={clubSlug}
				meetingId={meetingId}
				dbMeetingId={dbMeetingId}
				printLayout={printLayout}
				deck={deck}
				clubName={clubName}
				wordOfTheDay={wordOfTheDay}
				presentIsPrimary={presentIsPrimary}
				size="touch"
			/>
			{showManage ? (
				// The officer extras live in ONE menu (#1307, DESIGN.md: one primary
				// per person). Each item keeps the visibility gate its button had;
				// the trigger itself renders only when at least one item does, so a
				// plain member never sees an empty "Manage".
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" size="touch" aria-busy={manageBusy}>
							{manageBusy ? (
								<Loader2 className="animate-spin" aria-hidden />
							) : null}
							Manage
							<ChevronDown className="opacity-60" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						{/* Promote (#931): admin only — `canManage` is the effective-admin
						    answer, the same rule `requireClubRole(…, ["admin"])` states on
						    the server. Drafts only; nothing is sent from here. */}
						{canEdit ? (
							<DropdownMenuItem onSelect={() => setPromoteOpen(true)}>
								<Megaphone />
								Promote
							</DropdownMenuItem>
						) : null}
						{canEdit && !locked && hasAddableRoles ? (
							<DropdownMenuItem onSelect={onAddRole}>
								<Plus />
								Add role
							</DropdownMenuItem>
						) : null}
						{canLineupBlast ? (
							<DropdownMenuItem onSelect={() => onLineupBlast?.()}>
								<ListChecks />
								Lineup blast
							</DropdownMenuItem>
						) : null}
						{canEdit && !locked && canComplete ? (
							<DropdownMenuItem
								onSelect={onComplete}
								disabled={lifecycleBusy}
								aria-busy={spins("complete")}
							>
								{spins("complete") ? (
									<Loader2 className="animate-spin" />
								) : (
									<CheckCircle2 />
								)}
								Complete meeting
							</DropdownMenuItem>
						) : null}
						{showReopen ? (
							<DropdownMenuItem
								onSelect={onReopen}
								disabled={lifecycleBusy}
								aria-busy={spins("reopen")}
							>
								{spins("reopen") ? (
									<Loader2 className="animate-spin" />
								) : (
									<LockOpen />
								)}
								Reopen meeting
							</DropdownMenuItem>
						) : null}
						{canEdit && !locked && canCancel ? (
							<>
								{/* Cancel (#1057) opens the route's confirm rather than
								    writing — the confirm states what cancelling keeps (every
								    role), what it hides (the meeting, for members) and what it
								    sends (nothing). */}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onSelect={onCancel}
									disabled={lifecycleBusy}
									aria-busy={spins("cancel")}
								>
									{spins("cancel") ? (
										<Loader2 className="animate-spin" />
									) : (
										<CalendarX />
									)}
									Cancel meeting
								</DropdownMenuItem>
							</>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
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
		</div>
	);
}
