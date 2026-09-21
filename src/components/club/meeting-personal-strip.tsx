import { Loader2 } from "lucide-react";
import { ViewingAs } from "#/components/club/viewing-as";
import { Button } from "#/components/ui/button";
import type { PlanStatus } from "#/lib/attendance-panel";
import type { StoredMember } from "#/lib/member-identity";
import type { AttendanceStatus } from "#/server/minutes-logic";

/**
 * One row for everything about YOU on the meeting page (#541 D3): identity
 * (anon surfaces only — a session already knows who you are), the
 * plan-status control, or the post-meeting attendance statement. Replaces the
 * full-width availability button that used to float among the page actions.
 * No identity → no plan control: the claim flow bootstraps identity when the
 * visitor first acts.
 *
 * `myStatus` is the member's OWN rung on the ladder (spec D6): no answer yet
 * offers both "I'll be there" (`coming`) and "I can't make this one"
 * (`not_coming`); an answer already given collapses to one confirmation with
 * an inline undo back to "no answer" (`null`). `reached_out` is an officer's
 * record of having asked — a member offering it about themselves is
 * nonsense, and the server rejects a self-write of it, so it is never one of
 * the choices rendered here.
 *
 * ## The undo is SESSION-ONLY since #762
 *
 * Clearing a row back to "no answer" destroys an answer a person put there, so
 * ADR-0026 puts `clearPlannedAttendance` behind a session — which makes the
 * inline undo, for an `anon` viewer, a control that cannot run. Offering it
 * anyway means every tap ends in a refusal toast, and the one surface that
 * exists to make answering easy would teach that answering is broken.
 *
 * So `source` decides: a session keeps the undo chip; an anonymous viewer gets
 * the same sentence as a plain statement, with one line saying what would let
 * them change it. That line is deliberately TEXT and not a link — the strip
 * mounts in tests with no router, and a sign-in `<Link>` here would trade a
 * dead control for a dead import. The refusal path still carries a real
 * one-tap link wherever a write is actually attempted (`showWriteError`).
 *
 * ADR-0026 decided this directly rather than inheriting it: "a same-device undo
 * for a mis-tapped answer" was considered and declined, because the device is
 * not the person.
 */
export function MeetingPersonalStrip({
	source,
	member,
	promptIdentity,
	over,
	myStatus,
	myAttendance,
	availBusy,
	canToggleAvailability,
	onSetStatus,
}: {
	source: "anon" | "session";
	member: StoredMember | null;
	promptIdentity: () => void;
	over: boolean;
	myStatus: PlanStatus | null;
	// The RECORDED row, never the plan. `undefined` means this viewer cannot be
	// told (no session); `null` means a session exists and no row was
	// recorded. Both say nothing rather than inventing a record (#548).
	myAttendance?: AttendanceStatus | null;
	availBusy: boolean;
	canToggleAvailability: boolean;
	onSetStatus: (s: PlanStatus | null) => void;
}) {
	// Identity IS the member object — a separate boolean was two flags that
	// had to agree, with no caller able to make them diverge.
	const hasIdentity = member !== null;
	const disabled = !canToggleAvailability || availBusy;
	const spinner = availBusy ? (
		<Loader2 className="size-4 animate-spin" />
	) : null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			{source === "anon" ? (
				<ViewingAs member={member} promptIdentity={promptIdentity} />
			) : null}
			{!hasIdentity ? null : over ? (
				// From the RECORDED row, never the plan. `undefined` means this viewer
				// cannot be told (no session — see the panel's DP2 note); `null` means a
				// session exists and no row was recorded. Both say nothing rather than
				// inventing a record. Fixes #548.
				myAttendance === undefined || myAttendance === null ? null : (
					<p className="text-sm font-medium text-muted-foreground">
						{myAttendance === "present"
							? "You attended this meeting."
							: myAttendance === "excused"
								? "You were excused from this meeting."
								: "You did not attend this meeting."}
					</p>
				)
			) : myStatus === null ? (
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onSetStatus("coming")}
						disabled={disabled}
						aria-busy={availBusy}
					>
						{spinner}
						I'll be there
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onSetStatus("not_coming")}
						disabled={disabled}
						aria-busy={availBusy}
					>
						{spinner}I can't make this one
					</Button>
				</div>
			) : source === "anon" ? (
				// No session ⇒ no undo (see the header). The STATEMENT is the same
				// sentence the chip carries, minus the affordance that would refuse.
				<div className="flex flex-wrap items-baseline gap-x-2">
					<p className="text-sm font-medium">
						{myStatus === "coming"
							? "You'll be there."
							: "You can't make this one."}
					</p>
					<p className="text-muted-foreground text-xs">
						Sign in to change your answer.
					</p>
				</div>
			) : (
				<Button
					type="button"
					// `secondary`, NOT `default`, for an already-answered state. This
					// strip renders directly above the toolbar, so a `default` chip wore
					// the same `bg-primary` fill as the phase primary and put TWO filled
					// controls in the header on meeting day — the exact collision the
					// /qa pass had just fixed by outlining `Complete meeting`, recreated
					// across the component boundary. `secondary` still reads as an
					// engaged toggle against the `outline` no-answer state without
					// competing for the one emphasis D2 reserves for the phase primary.
					// Neither component's own test can see this: each renders alone.
					variant="secondary"
					size="sm"
					onClick={() => onSetStatus(null)}
					disabled={disabled}
					aria-busy={availBusy}
				>
					{spinner}
					{myStatus === "coming"
						? "You'll be there — undo?"
						: "You can't make this one — undo?"}
				</Button>
			)}
		</div>
	);
}
