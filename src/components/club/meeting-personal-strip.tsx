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
 * verbatim from the route (#541 D3). Whether that derivation should instead
 * be backed by real attendance records is tracked separately (#541 follow-up).
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
					variant={myUnavailable ? "default" : "outline"}
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
