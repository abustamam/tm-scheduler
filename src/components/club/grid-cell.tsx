import { Loader2 } from "lucide-react";
import type { ViewCell } from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";
import { MeetingLink } from "./meeting-link";

// The cells are 12px text, so WCAG AA needs 4.5:1. The success/warning/
// destructive token values are AA-verified in BOTH themes (see styles.css,
// #219): success fill pairs ≥6.4:1, warning/destructive text-on-surface ≥5:1.
const KIND_CLASS: Record<ViewCell["kind"], string> = {
	assigned: "bg-success text-success-foreground",
	open: "border border-dashed border-warning/60 text-warning-foreground",
	free: "border border-border text-muted-foreground/60",
	na: "border border-dashed border-destructive/60 text-destructive",
	blank: "opacity-0",
};

// h-11 below md: cells are the primary tap target on the phone sheet, so the
// row itself grows to the 44px touch minimum (#224). md+ keeps the h-8 desktop
// density unchanged.
const BASE =
	"flex h-11 min-w-[3rem] items-center justify-center rounded-md px-2 text-xs font-semibold md:h-8";

/**
 * One season-grid cell. Read-only by default (links to the meeting). When a
 * `currentMemberId` is supplied (the interactive sign-up sheet, #198) the cell
 * becomes act-on-your-own: an OPEN slot is one-tap claimable, your own slot is
 * releasable, everyone else's is greyed and read-only.
 */
export function GridCell({
	cell,
	currentMemberId,
	busy = false,
	onClaim,
	onRelease,
	availabilityEditable = false,
	onAvailability,
	clubSlug,
	meetingLabel,
}: {
	cell: ViewCell;
	currentMemberId?: string | null;
	busy?: boolean;
	onClaim?: (slotId: string) => void;
	onRelease?: (slotId: string) => void;
	/** Members × Meetings, your own row, upcoming meeting: the cell toggles your
	 *  availability (#204). free → NA, NA → free, assigned → release + NA. */
	availabilityEditable?: boolean;
	onAvailability?: (cell: ViewCell) => void;
	/** Club slug — when set (public club shell), cell links target the public
	 *  meeting view instead of the signed-in `/meetings/$id` route. */
	clubSlug?: string;
	/** Formatted meeting date (e.g. from `formatMeetingDate`) — appended to
	 *  every button/link accessible name so a screen reader tabbing across the
	 *  row hears which meeting each identical "Claim"/"NA"/member-name control
	 *  belongs to, not just the repeated label (#213). Omitted ⇒ unchanged. */
	meetingLabel?: string;
}) {
	const interactive = !!currentMemberId && !!cell.slotId;
	const isMine =
		interactive &&
		cell.kind === "assigned" &&
		cell.memberId === currentMemberId;
	const isClaimable = interactive && cell.kind === "open";
	const dateSuffix = meetingLabel ? ` — ${meetingLabel}` : "";

	// Availability toggle (Members × Meetings, your row). "blank" cells (the
	// meeting has no slots) aren't toggleable.
	if (availabilityEditable && onAvailability && cell.kind !== "blank") {
		const label =
			(cell.kind === "na"
				? "Mark yourself available again"
				: cell.kind === "assigned"
					? `Release ${cell.text} and mark yourself unavailable`
					: "Mark yourself unavailable — I can't make this one") + dateSuffix;
		const tone =
			cell.kind === "na"
				? "border border-dashed border-destructive/70 text-destructive hover:bg-destructive hover:text-white dark:hover:bg-destructive/60"
				: cell.kind === "assigned"
					? "bg-success text-success-foreground ring-2 ring-success-strong hover:opacity-80"
					: "border border-border text-muted-foreground/70 hover:border-destructive/50 hover:text-destructive";
		return (
			<button
				type="button"
				disabled={busy}
				title={label}
				aria-label={label}
				onClick={() => onAvailability(cell)}
				className={cn(
					BASE,
					"w-full cursor-pointer transition-colors disabled:opacity-50",
					tone,
				)}
			>
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : cell.text}
			</button>
		);
	}

	// Claim an OPEN slot as the current member.
	if (isClaimable && onClaim && cell.slotId) {
		const slotId = cell.slotId;
		return (
			<button
				type="button"
				disabled={busy}
				title={`${cell.title} — tap to claim${dateSuffix}`}
				aria-label={`Claim ${cell.title}${dateSuffix}`}
				onClick={() => onClaim(slotId)}
				className={cn(
					BASE,
					"w-full cursor-pointer border border-success/70 text-success transition-colors hover:bg-success hover:text-success-foreground disabled:opacity-50",
				)}
			>
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : "Claim"}
			</button>
		);
	}

	// Release your own slot.
	if (isMine && onRelease && cell.slotId) {
		const slotId = cell.slotId;
		return (
			<button
				type="button"
				disabled={busy}
				title={`${cell.title} — tap to release${dateSuffix}`}
				aria-label={`Release ${cell.title}${dateSuffix}`}
				onClick={() => onRelease(slotId)}
				className={cn(
					BASE,
					"w-full cursor-pointer bg-success text-success-foreground ring-2 ring-success-strong transition-opacity hover:opacity-80 disabled:opacity-50",
				)}
			>
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : cell.text}
			</button>
		);
	}

	const inner = (
		<span
			title={cell.title ? cell.title + dateSuffix : undefined}
			className={cn(
				BASE,
				KIND_CLASS[cell.kind],
				// In the interactive sheet, everyone else's filled cells recede so
				// it's obvious you can only act on your own. A light success wash +
				// full-strength foreground text (not opacity) keeps the receded
				// names AA-readable in both themes (≥9.8:1 measured).
				interactive &&
					cell.kind === "assigned" &&
					"bg-success/15 text-foreground",
			)}
		>
			{cell.text}
		</span>
	);
	if (cell.kind === "blank") return inner;
	return (
		<MeetingLink
			clubSlug={clubSlug}
			meetingId={cell.meetingId}
			className="block"
			aria-label={(cell.title || "meeting") + dateSuffix}
		>
			{inner}
		</MeetingLink>
	);
}
