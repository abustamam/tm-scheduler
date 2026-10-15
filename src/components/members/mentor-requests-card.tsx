import { HeartHandshake, Loader2 } from "lucide-react";
import { useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { Button } from "#/components/ui/button";
import { formatShortDate } from "#/lib/format";
import { mentorshipFocusText } from "#/lib/mentorship";
import type { IncomingMentorRequest } from "#/server/mentorship";

export const MENTOR_REQUESTS_HEADING = "Mentor requests";
export const MENTOR_REQUEST_FAILED_MESSAGE = "Something went wrong. Try again.";

/** Absolute origin for a draft's link; only read after a click, never in SSR. */
function currentOrigin(): string {
	return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * Pending mentor requests addressed to the member (#1209): each row names the
 * mentee, the focus and the date, with Accept and Decline. After Accept the row
 * becomes "Now mentoring {name}. Say hi:" with a draft for the mentor to send
 * (the app never sends one itself). That row is held in THIS component's state
 * until dismissed or the page reloads, because the server stops listing the
 * request the moment it is answered; it is not persisted.
 *
 * Presentational and controlled: the route owns the server call and the
 * reload. `onDecide` must reject on failure, so the row keeps its buttons.
 */
export function MentorRequestsCard({
	requests,
	onDecide,
}: {
	requests: readonly IncomingMentorRequest[];
	onDecide: (requestId: string, accept: boolean) => Promise<void>;
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
			setError(
				err instanceof Error && err.message
					? err.message
					: MENTOR_REQUEST_FAILED_MESSAGE,
			);
		} finally {
			setBusy(null);
		}
	}

	return (
		<section
			aria-labelledby="mentor-requests-heading"
			className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]"
		>
			<div className="flex items-center gap-2 px-5 pt-4 pb-2.5">
				<HeartHandshake
					className="size-4 text-[var(--lagoon-deep)]"
					aria-hidden
				/>
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
							className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3"
						>
							<div className="text-sm">
								<span className="font-bold text-[var(--sea-ink)]">
									{r.mentee.name}
								</span>
								<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
									{focus} · {formatShortDate(r.createdAt, "UTC")}
								</span>
							</div>
							<div className="flex gap-2">
								<Button
									size="sm"
									disabled={busy !== null}
									onClick={() => void decide(r, true)}
								>
									{busy === r.id ? (
										<Loader2 className="animate-spin" aria-hidden />
									) : null}
									Accept
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={busy !== null}
									onClick={() => void decide(r, false)}
								>
									Decline
								</Button>
							</div>
						</li>
					);
				})}
				{accepted.map((r) => (
					<li
						key={r.id}
						data-request={r.id}
						data-accepted="true"
						className="border-t border-[var(--line)] px-5 py-3"
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
