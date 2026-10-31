import { Link } from "@tanstack/react-router";
import { Loader2, Lock, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CoverSheet, type CoverSlot } from "#/components/club/cover-sheet";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
import { showWriteError } from "#/components/write-error-toast";
import { opensCoverSheet } from "#/lib/cover-sheet-logic";
import { formatMeetingDate } from "#/lib/format";
import { noteClaim } from "#/lib/install-hint";
import { mailtoHref } from "#/lib/mailto";
import type { StoredMember } from "#/lib/member-identity";
import { meetingRoleOptions } from "#/lib/member-role-picker";
import {
	DUTY_TOAST_MS,
	notComingToast,
	roleDutyConfirmText,
	roleFreedDutyText,
} from "#/lib/role-duty-copy";
import { scrollAnchorClearOfPinnedColumn } from "#/lib/season-grid-anchor-scroll";
import {
	DEFAULT_PAST_COUNT,
	FREE_CELL,
	limitPastMeetings,
	type MemberMeetingStatus,
	memberMeetingStatus,
	NA_CELL,
	type Orientation,
	PAST_COUNTS,
	projectGrid,
	type SeasonGridPast,
} from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";
import {
	clearAvailability,
	markUnavailableReleasing,
	setAvailability,
} from "#/server/availability";
import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";
import { claimSlot, releaseSlot } from "#/server/slots";
import {
	CELL_BASE,
	CELL_KIND_CLASS,
	GridCell,
	type PendingWrite,
} from "./grid-cell";
import { MeetingLink } from "./meeting-link";
import { MemberRolePicker } from "./member-role-picker";

/*
 * Sticky row-label cell colours (#1302). The table is border-separate with a 4px
 * spacing, so a sticky cell's background stops at its border box and cells
 * scrolled underneath show through the gap around it. Each cell therefore
 * paints a 4px spread shadow (`0_0_0_4px_<colour>`) in its OWN fill colour,
 * stacked after the edge shadow. Full literal class strings so Tailwind sees
 * them. Where a row is hovered or is the self row its label cell is raised to
 * z-[11] (over the base z-10, via cn) so its spread paints over the next row's card-coloured spread in the
 * gap; both stay below the header's z-20. DESIGN.md "Elevation & Depth" bans a
 * zero-offset glow; this is a zero-offset fill in the cell's own colour.
 */
const STICKY_LABEL_ROW =
	"group-hover:z-[11] bg-card group-hover:bg-muted shadow-[4px_0_6px_-4px_rgba(0,0,0,0.35),0_0_0_4px_var(--card)] group-hover:shadow-[4px_0_6px_-4px_rgba(0,0,0,0.35),0_0_0_4px_var(--muted)]";
// The self row: opaque tinted fill + a 3px inset accent bar; the spread repeats
// the fill's colour-mix (a test asserts the two stay equal).
const STICKY_LABEL_SELF =
	"z-[11] bg-[color-mix(in_oklab,var(--card),var(--primary)_8%)] shadow-[inset_3px_0_0_0_var(--primary),4px_0_6px_-4px_rgba(0,0,0,0.35),0_0_0_4px_color-mix(in_oklab,var(--card),var(--primary)_8%)]";

const COUNTS: SeasonGridCount[] = [4, 8, "all"];
const VIEWS: { value: Orientation; label: string }[] = [
	{ value: "roles", label: "Roles × Meetings" },
	{ value: "members", label: "Members × Meetings" },
];

/** A completed or past meeting takes no new claim and no role-picker edit (#1107). */
function isLocked(m: { isCompleted: boolean; isPast: boolean }): boolean {
	return m.isCompleted || m.isPast;
}

export function SeasonGrid({
	data: fullData,
	orientation,
	count,
	pastCount = DEFAULT_PAST_COUNT,
	currentMemberId,
	currentMemberSource = "anon",
	canManageOthers = false,
	clubId,
	publicShell,
	showContact = false,
	onOrientationChange,
	onCountChange,
	onPastCountChange,
	onChanged,
	requireIdentity,
}: {
	data: SeasonGridData;
	orientation: Orientation;
	count: SeasonGridCount;
	/** Past meetings shown (#1048). Reads the "Show past" button, and trims
	 *  `data` down to this many past columns when it carries more (#1316). */
	pastCount?: SeasonGridPast;
	/** When set, the grid becomes interactive as this member: claim/release
	 *  roles (Roles × Meetings) and toggle availability (Members × Meetings). */
	currentMemberId?: string | null;
	/**
	 * WHERE `currentMemberId` came from (#762, ADR-0026) — a session bound to
	 * this club's roster, or a localStorage name-pick.
	 *
	 * Named for the pairing rather than as a bare `isSignedIn`, because the two
	 * facts have to agree and a separate boolean is two flags with nothing
	 * keeping them in step — the objection `meeting-personal-strip.tsx` makes
	 * about identity in its own header.
	 *
	 * It exists because three of this grid's writes are session-gated
	 * (`clearAvailability` twice, `markUnavailableReleasing` once) while every
	 * control that reaches them keys on `currentMemberId` alone. That mismatch IS
	 * the bug: an anonymous roster pick was shown a confirm dialog promising to
	 * free their role and got "you need to be signed in", losing the answer too.
	 *
	 * Defaults to `"anon"`, the narrow side. A caller that forgets it loses the
	 * release and the un-decline; the opposite default loses a member's answer.
	 */
	currentMemberSource?: "anon" | "session";
	/** An officer/admin: may toggle ANY member's availability (Members ×
	 *  Meetings), not just their own row. Attribution stays `currentMemberId`. */
	canManageOthers?: boolean;
	/** Club uuid — required for the availability calls. */
	clubId?: string;
	/** PUBLIC-SHELL flag (#1401), not a slug: set only on the public club page.
	 *  It gates public-only behaviour (plain-text "Roster view"); links take
	 *  `data.clubSlug` on both surfaces. */
	publicShell?: boolean;
	/** Show member Email/Phone columns (Members × Meetings, signed-in only). */
	showContact?: boolean;
	onOrientationChange?: (o: Orientation) => void;
	onCountChange?: (c: SeasonGridCount) => void;
	/** The "Show past" control renders only when this is set. The public sheet
	 *  omits it: it always gets 2 past meetings (#1048). */
	onPastCountChange?: (p: SeasonGridPast) => void;
	/** Called after a successful mutation so the page can refetch. */
	onChanged?: () => void | Promise<void>;
	/** Public surface: resolve/collect identity before a claim when there's no
	 *  `currentMemberId`. */
	requireIdentity?: () => Promise<StoredMember | null>;
}) {
	// The loader fetches for the URL alone; a phone with no `?past=` shows fewer
	// past columns than it was sent (#1316).
	const data = limitPastMeetings(fullData, pastCount);
	const rows = projectGrid(data, orientation);
	// Members × Meetings contact columns (signed-in only) resolve email/phone
	// off the member axis; role rows have no memberId and never render these.
	const showContactCols = orientation === "members" && showContact;
	const contactByMember = new Map(data.members.map((m) => [m.id, m]));
	const meetingStatus = memberMeetingStatus(data, currentMemberId ?? null);
	// The session-gated capabilities this grid offers: releasing a role (tapping
	// your own cell, #763, or while declining), and taking a decline back. Both refuse an asserted caller
	// server-side (ADR-0026), so both have to disappear rather than refuse.
	const provenIdentity = currentMemberSource === "session";
	const labelHead = orientation === "roles" ? "Role" : "Member";
	const anchorRef = useRef<HTMLTableCellElement>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const labelHeadRef = useRef<HTMLTableCellElement>(null);
	const selfRowRef = useRef<HTMLTableRowElement>(null);
	// Optimistic claim/release, keyed by slotId (#1315). The entry is an object
	// so a later write on the same slot is not cleared by an earlier one's
	// `finally`. It applies only while loader data still shows the pre-write
	// state (`pendingApplies`), so fresh data never double-counts.
	const [pending, setPending] = useState<ReadonlyMap<string, PendingWrite>>(
		new Map(),
	);
	// A claim's identity-picker window is not yet `pending`; this ref keeps a
	// second tap on the same cell from opening a duplicate claim meanwhile.
	const claimingRef = useRef(new Set<string>());
	const latestMeetingRef = useRef<
		(slotId: string) => { openNow: number; date: string } | null
	>(() => null);
	const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null);
	// An own release inside 48h waits here for the cover sheet (#1439).
	const [cover, setCover] = useState<CoverSlot | null>(null);
	// The assigned-cell confirm: releasing a role + marking unavailable. When
	// `memberName` is set, an officer is acting on that member (not themselves).
	const [confirm, setConfirm] = useState<{
		memberId: string;
		memberName: string | null;
		meetingId: string;
		roleLabel: string;
		date: string;
	} | null>(null);

	// Roles × Meetings is the claim/release sheet.
	const actingMemberId = orientation === "roles" ? currentMemberId : null;
	// No-identity visitor on the public sign-up sheet: OPEN cells still show
	// "Claim" — the click resolves identity first (via requireIdentity).
	const prospectiveClaim =
		orientation === "roles" && !currentMemberId && !!requireIdentity;

	// Bring the anchor meeting into view to the RIGHT of the pinned label
	// column, not centred under it on a phone (#930).
	// Re-runs when the rendered past-column count changes (#1316): a phone hydrates
	// with the desktop default of 2, then drops them, moving the anchor to
	// column 0 while scrollLeft would still sit two columns along.
	const renderedPastCount = data.meetings.filter((m) => m.isPast).length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: renderedPastCount is the trigger, not a value read
	useEffect(() => {
		const scroller = scrollerRef.current;
		const anchor = anchorRef.current;
		if (!scroller || !anchor) return;
		scrollAnchorClearOfPinnedColumn(scroller, labelHeadRef.current, anchor);
	}, [renderedPastCount]);

	// Members × Meetings: bring the viewer's own row into view on load (and when
	// switching into this orientation), mirroring the horizontal anchor scroll.
	useEffect(() => {
		if (orientation !== "members") return;
		selfRowRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
	}, [orientation]);

	function startPending(slotId: string, write: PendingWrite) {
		setPending((prev) => new Map(prev).set(slotId, write));
	}
	function endPending(slotId: string, write: PendingWrite) {
		setPending((prev) => {
			if (prev.get(slotId) !== write) return prev;
			const next = new Map(prev);
			next.delete(slotId);
			return next;
		});
	}
	const memberNameById = new Map(data.memberNames.map((n) => [n.id, n.name]));
	// The slot's state in loader data, for `pendingApplies`.
	const slotState = new Map(
		data.cells.map((c) => [
			c.slotId,
			{ open: c.memberId === null && c.guestId === null, memberId: c.memberId },
		]),
	);
	function pendingApplies(slotId: string | null): PendingWrite | null {
		if (!slotId) return null;
		const write = pending.get(slotId);
		const state = slotState.get(slotId);
		if (!write || !state) return null;
		if (write.kind === "claim") return state.open ? write : null;
		if (currentMemberId && state.memberId === currentMemberId) return write;
		// The Undo of a resolved claim while the claim's refetch is still in
		// flight: loader data shows the slot open, yet the cell must read as
		// releasing (open, busy), not as a tappable Claim.
		return write.afterClaim && state.open ? write : null;
	}
	const meetingOpenDelta = new Map<string, number>();
	for (const c of data.cells) {
		const w = pendingApplies(c.slotId);
		if (!w) continue;
		// A release over a slot loader data already shows open adds nothing: the
		// column's count already includes it.
		const delta =
			w.kind === "claim"
				? -1
				: c.memberId === null && c.guestId === null
					? 0
					: 1;
		meetingOpenDelta.set(
			c.meetingId,
			(meetingOpenDelta.get(c.meetingId) ?? 0) + delta,
		);
	}

	// The LATEST render's view of a slot's meeting: its open count (loader count
	// plus the pending writes, this claim's -1 included) and its date. Read after
	// the claim's server write succeeds, where this closure's own `data` is the
	// render the tap happened in. Best-effort: a concurrent claim by someone else
	// can make the last role go to a different claimer, or to nobody (#1425).
	latestMeetingRef.current = (slotId: string) => {
		const meetingId = data.cells.find((c) => c.slotId === slotId)?.meetingId;
		const m = meetingId ? data.meetings.find((x) => x.id === meetingId) : null;
		if (!m) return null;
		return {
			openNow: Math.max(0, m.openCount + (meetingOpenDelta.get(m.id) ?? 0)),
			date: formatMeetingDate(m.scheduledAt, m.timezone),
		};
	};

	/** The sheet's target for one slot, read off loader data: its meeting (date,
	 *  URL key, zone) and its role row's label. Null when the grid cannot place
	 *  it (no slug for the link, no row for the label): a caller that has
	 *  already decided the drop is late must then refuse, never release. */
	function coverTargetFor(slotId: string): CoverSlot | null {
		const cell = data.cells.find((c) => c.slotId === slotId);
		const m = cell ? data.meetings.find((x) => x.id === cell.meetingId) : null;
		if (!cell || !m || !data.clubSlug) return null;
		const row = data.rows.find(
			(r) =>
				r.roleDefinitionId === cell.roleDefinitionId &&
				r.slotIndex === cell.slotIndex,
		);
		if (!row) return null;
		return {
			slotId,
			meetingId: m.id,
			roleLabel: row.label,
			scheduledAt: m.scheduledAt,
			clubSlug: data.clubSlug,
			urlKey: m.urlKey ?? m.id,
			timeZone: m.timezone,
		};
	}

	/** An own late drop that the grid cannot build the sheet for. Nothing is
	 *  released until Ask or Drop it anyway (#1439 AC1), so it stops here. */
	function coverUnavailable() {
		toast.error("Couldn't open the cover sheet. Reload and try again.");
	}

	// The write succeeded, so a failed refetch is not the write's error.
	async function refetchQuietly(what: string) {
		try {
			await onChanged?.();
		} catch (err) {
			console.error(`Refetch after ${what} failed`, err);
		}
	}

	async function claim(slotId: string, afterRelease = false) {
		// Guard the (possibly multi-second) identity-picker await: a second tap
		// while the picker is open must not fire a duplicate claim.
		if (claimingRef.current.has(slotId)) return;
		claimingRef.current.add(slotId);
		let entry: PendingWrite | null = null;
		try {
			let memberId = currentMemberId;
			if (!memberId && requireIdentity) {
				const me = await requireIdentity();
				if (!me) return; // dismissed — nothing was set
				memberId = me.id;
			}
			if (!memberId) return;
			entry = { kind: "claim", name: memberNameById.get(memberId) ?? null };
			startPending(slotId, entry);
			const { proof } = await claimSlot({
				data: { slotId, memberId, actorMemberId: memberId },
			});
			// The write is done: free the slot for an Undo-then-claim during the
			// refetch below (a held ref would swallow that tap).
			claimingRef.current.delete(slotId);
			// UNDO ONLY FOR A PROVEN WRITER (#763, ADR-0026). Undo is
			// `releaseSlot`, which needs a session; a claim is open to an anonymous
			// roster pick and reports which of the two just happened. Read from the
			// RESPONSE, as `markUnavailable` below does and for its reason: a signed-
			// in account with no membership here is refused the release too, and
			// only the server knows that. Anything but `"session"` fails closed.
			const after = latestMeetingRef.current(slotId);
			toast.success(
				after && after.openNow === 0
					? `That's every role filled for ${after.date}. Thank you.`
					: "Role claimed.",
				{
					...(proof === "session"
						? {
								action: { label: "Undo", onClick: () => release(slotId, true) },
							}
						: {}),
				},
			);
			// The Undo of a release re-takes a role the member already held: not a
			// new claim, so it must not count toward the install hint (#1428).
			if (!afterRelease) noteClaim();
			await refetchQuietly("claim");
		} catch (err) {
			showWriteError(err, "Couldn't claim role.");
		} finally {
			claimingRef.current.delete(slotId);
			if (entry) endPending(slotId, entry);
		}
	}

	// No actor on the wire (#763): the server credits the session.
	async function release(slotId: string, afterClaim = false) {
		// The claim's Undo is not a drop: only a deliberate release of your own
		// role inside 48h goes through the cover sheet (#1439).
		if (!afterClaim) {
			const cell = data.cells.find((c) => c.slotId === slotId);
			const meeting = cell
				? data.meetings.find((x) => x.id === cell.meetingId)
				: null;
			const own = !!currentMemberId && cell?.memberId === currentMemberId;
			if (
				meeting &&
				opensCoverSheet({ isOwnRole: own, scheduledAt: meeting.scheduledAt })
			) {
				const target = coverTargetFor(slotId);
				if (target) setCover(target);
				else coverUnavailable();
				return;
			}
		}
		const entry: PendingWrite = { kind: "release", afterClaim };
		startPending(slotId, entry);
		try {
			await releaseSlot({ data: { slotId } });
			// Only your OWN cell is wired to `release` (`onRelease` is passed to
			// GridCell, which renders it for `isMine` alone, and the claim-Undo is
			// your own claim), so the holder here is always the viewer.
			toast.success(roleFreedDutyText(1), {
				duration: DUTY_TOAST_MS,
				action: { label: "Undo", onClick: () => claim(slotId, true) },
			});
			await refetchQuietly("release");
		} catch (err) {
			showWriteError(err, "Couldn't release role.");
		} finally {
			endPending(slotId, entry);
		}
	}

	// `targetMemberId` is who is being marked (self, or another member when an
	// officer acts); `currentMemberId` is always the actor (attribution).
	async function markUnavailable(targetMemberId: string, meetingId: string) {
		if (!currentMemberId || !clubId) return;
		const self = targetMemberId === currentMemberId;
		setBusyMeetingId(meetingId);
		try {
			const { proof } = await setAvailability({
				data: {
					memberId: targetMemberId,
					actorMemberId: currentMemberId,
					meetingId,
					clubId,
				},
			});
			await onChanged?.();
			// UNDO ONLY FOR A PROVEN WRITER (#762, ADR-0026). Undo is
			// `clearAvailability`, which destroys an answer and so needs a session;
			// this write is open to an anonymous roster pick and reports which of
			// the two just happened. Offering the action regardless would put a
			// control on the one toast that says "it worked" whose every tap comes
			// back "you need to be signed in" — teaching that the grid is broken
			// rather than that the undo is gated.
			//
			// Read from the RESPONSE rather than guessed on the client: this
			// component is mounted by the public club shell and by the authed
			// schedule, and a second local notion of "am I signed in" is two flags
			// that have to agree with the server and nothing making them.
			const undoable = proof === "session";
			toast.success(self ? "Marked unavailable." : "Marked them unavailable.", {
				...(undoable
					? {
							action: {
								label: "Undo",
								onClick: () => clearUnavailable(targetMemberId, meetingId),
							},
						}
					: {}),
			});
		} catch (err) {
			showWriteError(err, "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	async function clearUnavailable(targetMemberId: string, meetingId: string) {
		if (!currentMemberId || !clubId) return;
		const self = targetMemberId === currentMemberId;
		setBusyMeetingId(meetingId);
		try {
			const { cleared } = await clearAvailability({
				data: {
					memberId: targetMemberId,
					actorMemberId: currentMemberId,
					meetingId,
					clubId,
				},
			});
			await onChanged?.();
			// UNDO ONLY FOR A CLEAR THAT REMOVED SOMETHING. An officer's clear of
			// another member's row deletes a decline and nothing else, so a grid that
			// still shows "declined" over an answer that has since changed deletes
			// nothing. Offering Undo then would re-decline over that newer answer.
			// The refresh above is what shows the person the row as it now stands.
			if (cleared === false) {
				toast.message(
					self
						? "Nothing changed. Your answer changed since this page loaded."
						: "Nothing changed. Their answer changed since this page loaded.",
				);
				return;
			}
			toast.success(
				self ? "You're marked available." : "Marked them available.",
				{
					action: {
						label: "Undo",
						onClick: () => markUnavailable(targetMemberId, meetingId),
					},
				},
			);
		} catch (err) {
			showWriteError(err, "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	async function releaseAndMark(targetMemberId: string, meetingId: string) {
		if (!currentMemberId || !clubId) return;
		const self = targetMemberId === currentMemberId;
		setConfirm(null);
		setBusyMeetingId(meetingId);
		try {
			const { released } = await markUnavailableReleasing({
				data: {
					memberId: targetMemberId,
					actorMemberId: currentMemberId,
					meetingId,
					clubId,
				},
			});
			await onChanged?.();
			if (!self) {
				toast.success("Role released — they're marked unavailable.");
			} else {
				const t = notComingToast(released, false);
				toast.success(t.text, { duration: t.duration });
			}
		} catch (err) {
			showWriteError(err, "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	// Header chip: decline (or un-decline) a whole meeting for YOURSELF. Holding a
	// role routes through the same release-and-mark confirm as the members cells.
	function onHeaderAvailability(
		m: SeasonGridData["meetings"][number],
		status: MemberMeetingStatus | undefined,
	) {
		if (!status || !currentMemberId) return;
		if (status.declined) {
			// Un-declining is `clearAvailability`, which needs a session. The chip
			// is not even rendered as a button without one (see its own note), so
			// this branch is unreachable for an asserted viewer — belt and braces,
			// because the render and the handler are far apart in this file.
			if (provenIdentity) clearUnavailable(currentMemberId, m.id);
		} else if (status.heldRoleLabels.length > 0 && provenIdentity) {
			setConfirm({
				memberId: currentMemberId,
				memberName: null,
				meetingId: m.id,
				roleLabel: status.heldRoleLabels.join(", "),
				date: formatMeetingDate(m.scheduledAt, m.timezone),
			});
		} else {
			// Includes the ROLE-HOLDER with no session, which is the case that used
			// to dead-end. ADR-0026 allows their first answer and forbids the
			// release, so they get the answer: `setAvailability`, which frees
			// nothing. Before this they were shown a dialog promising a release and
			// then refused, and the answer was lost with it.
			markUnavailable(currentMemberId, m.id);
		}
	}

	// Picker "Not available": if the target holds roles in the meeting, route
	// through the release-and-mark confirm; otherwise mark directly.
	function requestUnavailable(
		targetMemberId: string,
		meetingId: string,
		targetName: string,
		isOwnRow: boolean,
	) {
		const held = meetingRoleOptions(data, meetingId, targetMemberId).filter(
			(o) => o.state === "mine",
		);
		const m = data.meetings.find((x) => x.id === meetingId);
		// `provenIdentity`, same as the header chip: a caller who cannot free the
		// role still gets to record the answer rather than a refusal.
		if (held.length > 0 && provenIdentity) {
			setConfirm({
				memberId: targetMemberId,
				memberName: isOwnRow ? null : targetName,
				meetingId,
				roleLabel: held.map((o) => o.label).join(", "),
				date: m ? formatMeetingDate(m.scheduledAt, m.timezone) : "this meeting",
			});
		} else {
			markUnavailable(targetMemberId, meetingId);
		}
	}

	if (data.meetings.length === 0) {
		return (
			<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No upcoming meetings yet. Create meetings to start planning the season.
			</p>
		);
	}

	if (orientation === "members" && data.members.length === 0) {
		return (
			<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No members yet. Add members from the{" "}
				{publicShell ? (
					"Roster view"
				) : (
					<Link to="/roster" className="font-semibold text-primary underline">
						Roster view
					</Link>
				)}
				.
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-nowrap items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:gap-4 md:overflow-visible">
				<div className="inline-flex shrink-0 overflow-hidden rounded-lg border">
					{VIEWS.map((v) => (
						<button
							key={v.value}
							type="button"
							onClick={() => onOrientationChange?.(v.value)}
							className={cn(
								"px-3 py-1.5 text-xs font-semibold",
								orientation === v.value
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{v.label}
						</button>
					))}
				</div>
				<div className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
					<span className="text-xs font-semibold text-muted-foreground">
						Meetings shown
					</span>
					<div className="inline-flex overflow-hidden rounded-lg border">
						{COUNTS.map((c) => (
							<button
								key={String(c)}
								type="button"
								onClick={() => onCountChange?.(c)}
								className={cn(
									"px-3 py-1.5 text-xs font-semibold",
									count === c
										? "bg-accent text-accent-foreground"
										: "text-muted-foreground",
								)}
							>
								{c === "all" ? "All" : c}
							</button>
						))}
					</div>
				</div>
				{onPastCountChange ? (
					<div className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
						<span className="text-xs font-semibold text-muted-foreground">
							Show past
						</span>
						<div className="inline-flex overflow-hidden rounded-lg border">
							{PAST_COUNTS.map((p) => (
								<button
									key={p}
									type="button"
									aria-label={
										p === 0
											? "Show no past meetings"
											: `Show ${p} past meetings`
									}
									aria-pressed={pastCount === p}
									onClick={() => onPastCountChange(p)}
									className={cn(
										"px-3 py-1.5 text-xs font-semibold",
										pastCount === p
											? "bg-accent text-accent-foreground"
											: "text-muted-foreground",
									)}
								>
									{p === 0 ? "None" : p}
								</button>
							))}
						</div>
					</div>
				) : null}
			</div>

			{/* Border on the wrapper, scroll + fade on the inner div (#542, F-006):
			    `scroll-fade-r` masks the scroll container's right edge as a "more
			    columns this way" hint (retracting at scroll end), and a mask on the
			    bordered element would fade the border itself. */}
			<div className="rounded-xl border">
				{/* `relative` is NOT decoration, and it is the whole of #820.
				    `overflow-auto` clips a normal-flow child, but an ABSOLUTELY
				    positioned descendant lays out against its nearest POSITIONED
				    ancestor — and without one that is the initial containing block,
				    i.e. the viewport, which no `overflow` here can reach. The
				    `sr-only` contact labels `WhatsAppPhoneLink` renders in the phone
				    column are exactly that: Tailwind's `sr-only` is
				    `position:absolute`, so they sat at the table's right edge and
				    dragged `documentElement.scrollWidth` out with them. MEASURED on
				    production at a 375px viewport: 876px of document scroll against a
				    360px client width, with this box already clipping a 978px table
				    into 326px correctly — which is why the page scrolled sideways and
				    read as the scroller's bug when it was not. Same one-line remedy as
				    the guest-book confirm table (#806); `season-grid-geometry.test.ts`
				    is the gate, with a control that removes this class. */}
				<div
					ref={scrollerRef}
					className="relative scroll-fade-r overflow-auto rounded-xl"
				>
					<table className="border-separate border-spacing-1">
						<thead>
							<tr>
								{/* shadow on the sticky label column: without an edge, columns
						    sliding beneath it read as clipped/broken instead of
						    scrolled (the grid auto-scrolls to the upcoming meeting). */}
								<th
									ref={labelHeadRef}
									className="sticky top-0 left-0 z-20 w-36 max-w-36 bg-card px-3 py-2 text-left text-xs font-semibold shadow-[4px_0_6px_-4px_rgba(0,0,0,0.35),0_0_0_4px_var(--card)]"
								>
									{labelHead}
								</th>
								{data.meetings.map((m) => {
									const status = meetingStatus.get(m.id);
									const chipVisible =
										!!currentMemberId &&
										!!clubId &&
										!m.isPast &&
										!m.isCompleted;
									// A DECLINE is a first answer an asserted caller may give
									// (`setAvailability`); taking it back is `clearAvailability`,
									// which needs a session (ADR-0026). So the pill stays — it is
									// the state signal, and dropping it would hide the answer —
									// but for an asserted viewer it stops being a control.
									// `meeting-personal-strip.tsx` makes the same split for the
									// same write.
									const chipIsControl = !status?.declined || provenIdentity;
									const openNow = Math.max(
										0,
										m.openCount + (meetingOpenDelta.get(m.id) ?? 0),
									);
									const header = (
										<>
											<div>{formatMeetingDate(m.scheduledAt, m.timezone)}</div>
											{m.isCompleted ? (
												<div className="flex items-center justify-center gap-0.5 text-xs font-semibold text-muted-foreground">
													<Lock className="size-2.5" aria-hidden />
													locked
												</div>
											) : (
												// "ended", not "done": a past meeting still accepts
												// late sign-ups (recording who stepped in), so the
												// label shouldn't read as closed.
												<div className="text-xs font-semibold text-warning-foreground tabular-nums">
													{m.isPast
														? "ended"
														: openNow === 0
															? "full"
															: `${openNow} open`}
												</div>
											)}
										</>
									);
									return (
										<th
											key={m.id}
											ref={m.isAnchor ? anchorRef : undefined}
											className={cn(
												"sticky top-0 min-w-[3.5rem] bg-card px-2 py-2 text-center text-xs font-semibold",
												m.isPast && !m.isCompleted && "opacity-45",
												m.isCompleted && "bg-muted/60",
												m.isAnchor && "rounded-md ring-2 ring-primary",
											)}
										>
											{/* py-2 below md: the date link + the chip below can't both
										    reach 44px inside today's ~60px header, so the link gets
										    real padding (the header grows a little on the phone);
										    md+ is py-0 — unchanged (#224). */}
											<MeetingLink
												clubSlug={data.clubSlug}
												meetingId={m.id}
												meetingKey={m.urlKey}
												className="block py-2 md:py-0"
											>
												{header}
											</MeetingLink>
											{chipVisible ? (
												<Chip
													as={chipIsControl ? "button" : "span"}
													disabled={busyMeetingId === m.id}
													onClick={
														chipIsControl
															? () => onHeaderAvailability(m, status)
															: undefined
													}
													title={
														chipIsControl
															? status?.declined
																? "Tap if you can make it after all"
																: "Mark yourself unavailable — I can't make this one"
															: "Sign in to say you can make it after all"
													}
													aria-label={`${
														status?.declined ? "Not going" : "Can't go"
													} — ${formatMeetingDate(m.scheduledAt, m.timezone)}`}
													className={cn(
														// px-2.5/py-1/11px (was px-1.5/py-0.5/10px): the chip is a
														// primary mobile action — 19px tall was too small to tap.
														"mx-auto mt-1 flex cursor-pointer items-center gap-0.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-colors disabled:opacity-50",
														// Below md the pill gets a bit more padding (~33px) and an
														// invisible ::after pad tops it up to a ≥44px hit area:
														// 4px up (exactly the mt-1 gap, so it never covers the
														// date link) + 12px down (exactly the th padding + row
														// gap, so it never covers the first grid row) (#224).
														"max-md:relative max-md:py-2 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-top-1 max-md:after:-bottom-3 max-md:after:content-['']",
														status?.declined
															? // Same fill recipe as the destructive Button variant, so
																// white text stays AA in dark (destructive/60 ⇒ 6.0:1).
																"border-destructive bg-destructive text-white hover:opacity-80 dark:border-destructive/60 dark:bg-destructive/60"
															: "border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive",
													)}
												>
													{busyMeetingId === m.id ? (
														<Loader2
															className="size-2.5 animate-spin"
															aria-hidden
														/>
													) : status?.declined ? (
														<>
															Not going
															<X className="size-2.5" aria-hidden />
														</>
													) : (
														"Can't go"
													)}
												</Chip>
											) : null}
										</th>
									);
								})}
								{showContactCols ? (
									<>
										<th className="sticky top-0 bg-card px-3 py-2 text-left text-xs font-semibold">
											Email
										</th>
										<th className="sticky top-0 bg-card px-3 py-2 text-left text-xs font-semibold">
											Phone
										</th>
									</>
								) : null}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const isMemberView = orientation === "members";
								const isSelfRow =
									isMemberView &&
									!!currentMemberId &&
									row.memberId === currentMemberId;
								// Recede OTHER members only on the self-serve sheet. The officer
								// schedule (canManageOthers) manages everyone, so nothing dims
								// there — every row stays full-strength.
								const dimRow =
									isMemberView &&
									!!row.memberId &&
									!isSelfRow &&
									!!currentMemberId &&
									!canManageOthers;
								// Dimmed cells brighten when the row is hovered (`group`), so any
								// member can still be traced across the meeting columns.
								const tdClass = cn(
									"p-0",
									dimRow &&
										"opacity-55 transition-opacity group-hover:opacity-100",
								);
								const contact = row.memberId
									? contactByMember.get(row.memberId)
									: undefined;
								return (
									<tr
										key={row.id}
										ref={isSelfRow ? selfRowRef : undefined}
										className={cn(
											"group transition-colors",
											isSelfRow ? "bg-primary/[0.07]" : "hover:bg-muted/40",
										)}
									>
										<th
											className={cn(
												"sticky left-0 z-10 w-36 max-w-36 px-3 py-1 text-left text-xs font-semibold",
												isSelfRow ? STICKY_LABEL_SELF : STICKY_LABEL_ROW,
											)}
										>
											<div className="flex items-center gap-1.5">
												{row.memberId ? (
													// Below md the row is already 44px tall (the cells grew),
													// so an invisible ::before pad stretches this ~17px text
													// link over the whole row height (±14px) and into the th
													// side padding (±8px) without moving a pixel visually;
													// md+ renders exactly as before (#224).
													<Link
														to="/members/$id"
														params={{ id: row.memberId }}
														className="min-w-0 hover:underline max-md:relative max-md:before:absolute max-md:before:-inset-x-2 max-md:before:-inset-y-3.5 max-md:before:content-['']"
													>
														<span className="block truncate" title={row.label}>
															{row.label}
														</span>
													</Link>
												) : (
													<span
														className="block min-w-0 truncate"
														title={row.label}
													>
														{row.label}
													</span>
												)}
												{isSelfRow ? (
													<span className="inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-0.5 align-middle text-xs font-semibold leading-none text-primary-foreground">
														You
													</span>
												) : null}
											</div>
										</th>
										{row.cells.map((cell, i) => {
											const m = data.meetings[i];
											const isOwnRow =
												!!currentMemberId && row.memberId === currentMemberId;
											const targetMemberId = row.memberId;
											// Members × Meetings, an upcoming (not past/locked) meeting →
											// the cell opens the role picker: your own row for anyone, or
											// ANY member's row for an officer (canManageOthers).
											const editable =
												orientation === "members" &&
												!!targetMemberId &&
												!!currentMemberId &&
												!!clubId &&
												!!m &&
												!isLocked(m) &&
												(isOwnRow || canManageOthers);
											if (editable && m && targetMemberId && currentMemberId) {
												const label = row.label;
												const date = formatMeetingDate(
													m.scheduledAt,
													m.timezone,
												);
												return (
													<td key={`${row.id}:${m.id}`} className={tdClass}>
														<MemberRolePicker
															data={data}
															meetingId={m.id}
															meetingDate={date}
															targetMemberId={targetMemberId}
															targetName={label}
															isOwnRow={isOwnRow}
															canReassign={canManageOthers}
															actorMemberId={currentMemberId}
															declined={cell.kind === "na"}
															onMarkUnavailable={() =>
																requestUnavailable(
																	targetMemberId,
																	m.id,
																	label,
																	isOwnRow,
																)
															}
															// Un-declining needs a session, so the item is not
															// rendered without one rather than refusing on tap.
															canMarkAvailable={provenIdentity}
															onMarkAvailable={() =>
																clearUnavailable(targetMemberId, m.id)
															}
															onChanged={() => onChanged?.()}
															scheduledAt={m.scheduledAt}
															onOwnLateRelease={(slotId) => {
																const target = coverTargetFor(slotId);
																if (target) setCover(target);
																else coverUnavailable();
															}}
														>
															<button
																type="button"
																disabled={busyMeetingId === m.id}
																title={cell.title || "Assign a role"}
																aria-label={`Edit ${label} — ${date}${cell.contacted ? " — contacted" : ""}`}
																className={cn(
																	CELL_BASE,
																	CELL_KIND_CLASS[cell.kind],
																	"w-full cursor-pointer transition-[filter,border-color] hover:brightness-95 disabled:opacity-50",
																	cell.kind === "free" &&
																		"group/cell hover:border-link-fill hover:text-link focus-visible:border-link-fill focus-visible:text-link",
																)}
															>
																{cell.kind === "free" ? (
																	// A free cell is a bare "·" — on hover/focus it
																	// becomes a "+" so the open slot reads as
																	// actionable (#542, F-008).
																	<>
																		<span className="group-hover/cell:hidden group-focus-visible/cell:hidden">
																			{cell.text}
																		</span>
																		<Plus
																			className="hidden size-3.5 group-hover/cell:inline group-focus-visible/cell:inline"
																			aria-hidden
																		/>
																	</>
																) : (
																	cell.text || (
																		<Plus
																			className="size-3.5 opacity-40"
																			aria-hidden
																		/>
																	)
																)}
																{cell.contacted ? (
																	<span
																		aria-hidden
																		className="ml-1 inline-block size-1.5 rounded-full bg-success-strong"
																	/>
																) : null}
															</button>
														</MemberRolePicker>
													</td>
												);
											}
											return (
												<td key={`${row.id}:${m?.id}`} className={tdClass}>
													<GridCell
														cell={cell}
														currentMemberId={actingMemberId}
														prospectiveClaim={prospectiveClaim}
														pending={pendingApplies(cell.slotId)}
														busy={busyMeetingId === cell.meetingId}
														// A completed or past meeting is locked: the server refuses the claim
														// (#1107), so the grid offers no control for it.
														onClaim={m && isLocked(m) ? undefined : claim}
														// Releasing is session-gated (#763), so an
														// anonymous pick's own cell is not a control.
														onRelease={provenIdentity ? release : undefined}
														clubSlug={data.clubSlug}
														meetingKey={m?.urlKey}
														meetingLabel={
															m
																? formatMeetingDate(m.scheduledAt, m.timezone)
																: undefined
														}
													/>
												</td>
											);
										})}
										{showContactCols ? (
											<>
												<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
													{contact?.email ? (
														// `mailtoHref`: a stored "a@b.com?bcc=x" would
														// otherwise become live mailto HEADERS. Same fix
														// as the guest card and the member profile.
														//
														// `data-slot="wa-email"` for the same reason the
														// phone link beside it carries `wa-phone`: the
														// unlayered `a { color }` rule in styles.css beats
														// this layered `text-primary`, so without the
														// opt-out the class is DEAD and the address renders
														// --lagoon-deep (#328f97, 3.81:1) at 12px — under AA,
														// and a different colour from its own peer action one
														// cell over (--lagoon-ink, 5.82:1). Two halves of one
														// Contact pair are not allowed to disagree.
														<a
															href={mailtoHref(contact.email)}
															data-slot="wa-email"
															className="text-primary hover:underline"
														>
															{contact.email}
														</a>
													) : (
														<span className="text-muted-foreground">—</span>
													)}
												</td>
												<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
													{/* WhatsApp, not the dialer: nobody calls a club member
													    from a sign-up sheet. `row.label` is this axis's
													    display name for the member — it is what the row
													    header renders — so it names the chat's destination.
													    No colour class: the component owns colour, because the
													    `data-slot` that escapes the unlayered `a { color }` rule
													    has to travel with it. */}
													<WhatsAppPhoneLink
														phone={contact?.phone}
														name={row.label}
														fallback={
															<span className="text-muted-foreground">—</span>
														}
													/>
												</td>
											</>
										) : null}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</div>

			{/* Legend for the Members × Meetings chips (#542, F-008): the cells
			    speak in role short-codes (TD, SP1, …), a bare "·" for free and "NA"
			    for unavailable — compact on purpose, decoded here once. Quiet: one
			    wrapping muted line under the grid. */}
			{orientation === "members" && data.rows.length > 0 ? (
				<p className="text-xs leading-relaxed text-muted-foreground">
					{data.rows.map((r) => (
						<span
							key={`${r.roleDefinitionId}:${r.slotIndex}`}
							className="mr-3 inline-block whitespace-nowrap"
						>
							<span className="font-semibold">{r.shortCode}</span> {r.label}
						</span>
					))}
					<span className="mr-3 inline-block whitespace-nowrap">
						<span className="font-semibold">{NA_CELL.text}</span>{" "}
						{NA_CELL.label}
					</span>
					<span className="inline-block whitespace-nowrap">
						<span className="font-semibold">{FREE_CELL.text}</span>{" "}
						{FREE_CELL.label}
					</span>
				</p>
			) : null}

			<CoverSheet
				slots={cover ? [cover] : []}
				onClose={() => setCover(null)}
				onChanged={() => refetchQuietly("cover")}
			/>

			<Dialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{confirm?.memberName
								? `Mark ${confirm.memberName} unavailable?`
								: "Mark yourself unavailable?"}
						</DialogTitle>
						<DialogDescription>
							{confirm?.memberName
								? `${confirm.memberName} is ${confirm?.roleLabel} on ${confirm?.date}. Release the role and mark them unavailable for the meeting?`
								: roleDutyConfirmText(
										confirm?.roleLabel ?? "",
										confirm?.date ?? "",
									)}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirm(null)}>
							Cancel
						</Button>
						<Button
							onClick={() =>
								confirm && releaseAndMark(confirm.memberId, confirm.meetingId)
							}
						>
							Release &amp; mark unavailable
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * The header availability pill, as a CONTROL or as bare STATE (#762).
 *
 * An asserted viewer may decline a meeting (`setAvailability` fills a blank)
 * and may not take it back (`clearAvailability` needs a session, ADR-0026), so
 * once they have declined the pill has to keep saying "Not going" while
 * ceasing to be tappable. Rendering it as a `<span>` is what makes that true
 * for a keyboard and a screen reader as well as for a mouse — a `disabled`
 * button would dim the one thing on that column that still carries the answer.
 *
 * Polymorphic rather than two copies of the element: the class string it wears
 * is ~10 lines of tap-target and dark-mode reasoning (see the call site), and a
 * second copy is how the two drift. `cursor-default` is appended for the span —
 * tailwind-merge keeps the last of a conflicting pair — so the only class that
 * would actively lie about tappability is the one that goes.
 */
function Chip({
	as,
	disabled,
	onClick,
	title,
	className,
	"aria-label": ariaLabel,
	children,
}: {
	as: "button" | "span";
	disabled?: boolean;
	onClick?: () => void;
	title?: string;
	className?: string;
	"aria-label"?: string;
	children: ReactNode;
}) {
	if (as === "span") {
		// No `aria-label`: an unlabelled `<span>` is not an accessibility node, so
		// a name on it is unreliable — and the date it would add is the column
		// header immediately above. The visible text is the answer.
		return (
			<span title={title} className={cn(className, "cursor-default")}>
				{children}
			</span>
		);
	}
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			title={title}
			aria-label={ariaLabel}
			className={className}
		>
			{children}
		</button>
	);
}
