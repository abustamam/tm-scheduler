import { Loader2 } from "lucide-react";
import { ViewingAs } from "#/components/club/viewing-as";
import { Button } from "#/components/ui/button";
import type { PlanStatus } from "#/lib/attendance-panel";
import type { StoredMember } from "#/lib/member-identity";

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
 * The attendance statement below reads the pre-meeting PLAN status, not real
 * roll-taking data — relocated verbatim from the route (#541 D3). So it says
 * "You attended this meeting" to anyone who never declared `not_coming`,
 * whether or not they turned up. Pre-existing, deliberately not fixed here
 * (the fix is in the loader, not the chrome), and tracked as issue #548.
 */
export function MeetingPersonalStrip({
	source,
	member,
	promptIdentity,
	over,
	myStatus,
	availBusy,
	canToggleAvailability,
	onSetStatus,
}: {
	source: "anon" | "session";
	member: StoredMember | null;
	promptIdentity: () => void;
	over: boolean;
	myStatus: PlanStatus | null;
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
				// Plan-status-derived, not attendance-derived — see doc comment above.
				<p className="text-sm font-medium text-muted-foreground">
					{myStatus === "not_coming"
						? "You did not attend this meeting."
						: "You attended this meeting."}
				</p>
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
