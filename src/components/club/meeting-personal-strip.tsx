import { Loader2 } from "lucide-react";
import { ViewingAs } from "#/components/club/viewing-as";
import { Button } from "#/components/ui/button";
import type { StoredMember } from "#/lib/member-identity";

/**
 * One row for everything about YOU on the meeting page (#541 D3): identity
 * (anon surfaces only — a session already knows who you are), the
 * availability chip, or the post-meeting attendance statement. Replaces the
 * full-width availability button that used to float among the page actions.
 * No identity → no availability control: the claim flow bootstraps identity
 * when the visitor first acts.
 *
 * The attendance statement below reads the pre-meeting AVAILABILITY
 * declaration (`myUnavailable`), NOT `meeting_attendance` rows — relocated
 * verbatim from the route (#541 D3). So it says "You attended this meeting"
 * to anyone who never declared themselves unavailable, whether or not they
 * turned up. Pre-existing, deliberately not fixed here (the fix is in the
 * loader, not the chrome), and tracked as issue #548.
 */
export function MeetingPersonalStrip({
	source,
	member,
	promptIdentity,
	over,
	myUnavailable,
	availBusy,
	canToggleAvailability,
	onToggleAvailability,
}: {
	source: "anon" | "session";
	member: StoredMember | null;
	promptIdentity: () => void;
	over: boolean;
	myUnavailable: boolean;
	availBusy: boolean;
	canToggleAvailability: boolean;
	onToggleAvailability: () => void;
}) {
	// Identity IS the member object — a separate boolean was two flags that
	// had to agree, with no caller able to make them diverge.
	const hasIdentity = member !== null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			{source === "anon" ? (
				<ViewingAs member={member} promptIdentity={promptIdentity} />
			) : null}
			{!hasIdentity ? null : over ? (
				// Availability-derived, not attendance-derived — see doc comment above.
				<p className="text-sm font-medium text-muted-foreground">
					{myUnavailable
						? "You did not attend this meeting."
						: "You attended this meeting."}
				</p>
			) : (
				<Button
					type="button"
					// `secondary`, NOT `default`, for the marked-unavailable state. This
					// strip renders directly above the toolbar, so a `default` chip wore
					// the same `bg-primary` fill as the phase primary and put TWO filled
					// controls in the header on meeting day — the exact collision the
					// /qa pass had just fixed by outlining `Complete meeting`, recreated
					// across the component boundary. `secondary` still reads as an
					// engaged toggle against the `outline` not-marked state without
					// competing for the one emphasis D2 reserves for the phase primary.
					// Neither component's own test can see this: each renders alone.
					variant={myUnavailable ? "secondary" : "outline"}
					size="sm"
					onClick={onToggleAvailability}
					disabled={!canToggleAvailability || availBusy}
					aria-busy={availBusy}
				>
					{availBusy ? <Loader2 className="size-4 animate-spin" /> : null}
					{myUnavailable
						? "You can't make this one — undo?"
						: "I can't make this one"}
				</Button>
			)}
		</div>
	);
}
