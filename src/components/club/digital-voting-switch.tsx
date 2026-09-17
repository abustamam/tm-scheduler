import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";

/**
 * A club admin's control over ONE meeting's digital vote (#770), rendered in
 * the Ballot Counter console. Presentational: the route owns the write
 * (`setMeetingDigitalVoting`), so this is mountable in jsdom and its copy is
 * assertable.
 *
 * Turning OFF always asks first, and does not try to ask only when a vote is
 * open. The page's knowledge of that is a polled cache up to five seconds old,
 * and the case a stale check skips is exactly the one where a vote is
 * mid-flight — the lesson `DeclineReleaseDialog` (#663) records. Turning back
 * ON asks nothing: it opens no vote by itself.
 *
 * When the CLUB has digital voting off, this meeting cannot turn it on (a
 * meeting can only switch it further off), so the control says which switch is
 * off and points at Club settings instead of offering a button that would do
 * nothing.
 */
export function DigitalVotingSwitch({
	digitalVoting,
	clubDigitalVotingEnabled,
	busy,
	onSetDisabled,
}: {
	/** The resolved answer for this meeting (`isDigitalVotingOn`). */
	digitalVoting: boolean;
	/** The club's half alone — tells an off meeting WHICH switch is off. */
	clubDigitalVotingEnabled: boolean;
	busy: boolean;
	onSetDisabled: (disabled: boolean) => Promise<void>;
}) {
	const [confirming, setConfirming] = useState(false);

	if (!digitalVoting) {
		if (!clubDigitalVotingEnabled) {
			return (
				<p className="text-muted-foreground text-sm">
					Digital voting is off for this club.{" "}
					<Link to="/admin/club-settings" className="underline">
						Club settings
					</Link>
				</p>
			);
		}
		return (
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-muted-foreground text-sm">
					Digital voting is off for this meeting.
				</p>
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => void onSetDisabled(false)}
				>
					Turn on
				</Button>
			</div>
		);
	}

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				disabled={busy}
				onClick={() => setConfirming(true)}
			>
				Turn off digital voting for this meeting
			</Button>
			<Dialog
				open={confirming}
				onOpenChange={(o) => {
					if (!o && !busy) setConfirming(false);
				}}
			>
				{/* No `max-h` / `overflow-*`: a dialog's height belongs to the
				 *  `DialogContent` primitive (CODING_STANDARDS.md, #619). */}
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Turn off digital voting for this meeting?</DialogTitle>
						<DialogDescription>
							Any vote that's open closes now, and the ballot QR comes off the
							agenda and slides. Votes already cast are kept. Paper voting and
							recording the winners still work.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setConfirming(false)}
						>
							Keep digital voting
						</Button>
						<Button
							disabled={busy}
							onClick={async () => {
								await onSetDisabled(true);
								setConfirming(false);
							}}
						>
							Turn off
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
