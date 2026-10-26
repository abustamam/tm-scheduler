import { HeartHandshake } from "lucide-react";
import { useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { Button } from "#/components/ui/button";
import { formatShortDate } from "#/lib/format";
import { mentorshipFocusText } from "#/lib/mentorship";
import type { IncomingMentorRequest } from "#/server/mentorship";
import {
	currentOrigin,
	DecideButtons,
	MENTOR_REQUEST_FAILED_MESSAGE,
	mentorRequestErrorText,
} from "./mentor-request-shared";

export const MENTOR_REQUESTS_HEADING = "Mentor requests";
export { MENTOR_REQUEST_FAILED_MESSAGE };

/**
 * Pending mentor requests addressed to the member (#1209): each row names the
 * mentee, the focus and the date, with Accept and Decline. After Accept the row
 * becomes "Now mentoring {name}. Say hi:" with a draft for the mentor to send
 * (the app never sends one itself). That row is held in THIS component's state
 * until dismissed or the page reloads, because the server stops listing the
 * request the moment it is answered; it is not persisted.
 *
 * Presentational and controlled: the route owns the server call and the
 * reload. `onDecide` must reject when the ANSWER failed, so the row keeps its
 * buttons; a reload that fails after the answer landed is `onDecide`'s to
 * swallow (see the dashboard), never a reason to hide the welcome draft.
 * `timezone` is the club's, for the date on each row.
 */
export function MentorRequestsCard({
	requests,
	onDecide,
	timezone,
}: {
	requests: readonly IncomingMentorRequest[];
	onDecide: (requestId: string, accept: boolean) => Promise<void>;
	timezone?: string;
}) {
	const [accepted, setAccepted] = useState<IncomingMentorRequest[]>([]);
	const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const acceptedIds = new Set(accepted.map((r) => r.id));
	const pending = requests.filter(
		(r) => !declined.has(r.id) && !acceptedIds.has(r.id),
	);
	if (pending.length === 0 && accepted.length === 0) return null;

	async function decide(request: IncomingMentorRequest, accept: boolean) {
		setBusy(request.id);
		setError(null);
		try {
			await onDecide(request.id, accept);
			if (accept) setAccepted((a) => [...a, request]);
			else setDeclined((d) => new Set(d).add(request.id));
		} catch (err) {
			setError(mentorRequestErrorText(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<section
			aria-labelledby="mentor-requests-heading"
			className="overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-[0_10px_24px_rgba(23,58,64,.05)]"
		>
			<div className="flex items-center gap-2 px-5 pt-4 pb-2.5">
				<HeartHandshake className="size-4 text-link" aria-hidden />
				<h2 id="mentor-requests-heading" className="text-sm font-bold">
					{MENTOR_REQUESTS_HEADING}
				</h2>
			</div>
			{error ? (
				<p role="alert" className="px-5 pb-2 text-xs text-destructive">
					{error}
				</p>
			) : null}
			<ul className="m-0 list-none p-0">
				{pending.map((r) => {
					const focus = mentorshipFocusText(r.focus, r.focusOther);
					return (
						<li
							key={r.id}
							data-request={r.id}
							className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3"
						>
							<div className="text-sm">
								<span className="font-bold text-foreground">
									{r.mentee.name}
								</span>
								<span className="ml-2 text-xs text-muted-foreground">
									{focus} · {formatShortDate(r.createdAt, timezone)}
								</span>
							</div>
							<DecideButtons
								busy={busy === r.id}
								disabled={busy !== null}
								onDecide={(accept) => void decide(r, accept)}
							/>
						</li>
					);
				})}
				{accepted.map((r) => (
					<li
						key={r.id}
						data-request={r.id}
						data-accepted="true"
						className="border-t border-border px-5 py-3"
					>
						<p className="mb-2 text-sm font-semibold">
							Now mentoring {r.mentee.name}. Say hi:
						</p>
						<NudgeButtons
							mode="mentorWelcome"
							name={r.mentee.name}
							phone={r.mentee.phone}
							email={r.mentee.email}
							preferredContact={r.mentee.preferredContact}
							origin={currentOrigin()}
						/>
						<Button
							size="sm"
							variant="ghost"
							className="mt-2"
							onClick={() => setAccepted((a) => a.filter((x) => x.id !== r.id))}
						>
							Dismiss
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
