import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { ViewCell } from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";

const KIND_CLASS: Record<ViewCell["kind"], string> = {
	assigned: "bg-emerald-600 text-white",
	open: "border border-dashed border-amber-500/60 text-amber-600",
	free: "border border-border text-muted-foreground/60",
	na: "border border-dashed border-rose-500/60 text-rose-600",
	blank: "opacity-0",
};

const BASE =
	"flex h-8 min-w-[3rem] items-center justify-center rounded-md px-2 text-xs font-semibold";

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
}) {
	const interactive = !!currentMemberId && !!cell.slotId;
	const isMine =
		interactive &&
		cell.kind === "assigned" &&
		cell.memberId === currentMemberId;
	const isClaimable = interactive && cell.kind === "open";

	// Availability toggle (Members × Meetings, your row). "blank" cells (the
	// meeting has no slots) aren't toggleable.
	if (availabilityEditable && onAvailability && cell.kind !== "blank") {
		const label =
			cell.kind === "na"
				? "Mark yourself available again"
				: cell.kind === "assigned"
					? `Release ${cell.text} and mark yourself unavailable`
					: "Mark yourself unavailable — I can't make this one";
		const tone =
			cell.kind === "na"
				? "border border-dashed border-rose-500/70 text-rose-600 hover:bg-rose-500 hover:text-white"
				: cell.kind === "assigned"
					? "bg-emerald-600 text-white ring-2 ring-emerald-800 hover:opacity-80"
					: "border border-border text-muted-foreground/70 hover:border-rose-400 hover:text-rose-600";
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
				title={`${cell.title} — tap to claim`}
				aria-label={`Claim ${cell.title}`}
				onClick={() => onClaim(slotId)}
				className={cn(
					BASE,
					"w-full cursor-pointer border border-emerald-500/70 text-emerald-700 transition-colors hover:bg-emerald-600 hover:text-white disabled:opacity-50",
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
				title={`${cell.title} — tap to release`}
				aria-label={`Release ${cell.title}`}
				onClick={() => onRelease(slotId)}
				className={cn(
					BASE,
					"w-full cursor-pointer bg-emerald-600 text-white ring-2 ring-emerald-800 transition-opacity hover:opacity-80 disabled:opacity-50",
				)}
			>
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : cell.text}
			</button>
		);
	}

	const inner = (
		<span
			title={cell.title || undefined}
			className={cn(
				BASE,
				KIND_CLASS[cell.kind],
				// In the interactive sheet, everyone else's filled cells are greyed
				// so it's obvious you can only act on your own.
				interactive && cell.kind === "assigned" && "opacity-45",
			)}
		>
			{cell.text}
		</span>
	);
	if (cell.kind === "blank") return inner;
	if (clubSlug)
		return (
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId: clubSlug, meetingId: cell.meetingId }}
				className="block"
				aria-label={cell.title || "meeting"}
			>
				{inner}
			</Link>
		);
	return (
		<Link
			to="/meetings/$id"
			params={{ id: cell.meetingId }}
			className="block"
			aria-label={cell.title || "meeting"}
		>
			{inner}
		</Link>
	);
}
