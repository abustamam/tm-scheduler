import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Check, ChevronLeft, MessageSquareHeart } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { resolveClubOrRedirect } from "#/lib/club-route";
import {
	FEEDBACK_CLOSED_MESSAGE,
	FEEDBACK_NOT_OPEN_MESSAGE,
	FEEDBACK_TEXT_MAX,
} from "#/lib/feedback-window";
import { formatMeetingDate } from "#/lib/format";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	type FeedbackTarget,
	getFeedbackTargetsPublic,
	leaveFeedback,
} from "#/server/role-feedback";

// Escapes the `/club/$clubId` shell (trailing `_`), like the ballot: this is the
// PUBLIC, no-auth page where anyone in the room leaves an anonymous note about a
// role someone served (#981 / #984). Linked from the meeting page and the
// in-room strip while the window is open. `noindex`: it lists names.
export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/feedback",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// null for an archived club, an unknown key or a cancelled meeting — all
		// the same not-found to a visitor.
		// The reader answers null rather than throwing, but a "Meeting not
		// found." is translated too, like every sibling sub-route (#877).
		const data = await getFeedbackTargetsPublic({
			data: { clubId: club.id, meetingKey: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		if (!data) throw notFound();
		// The server decided the state on ITS clock; the visitor's clock may be
		// wrong, and must not choose between "not yet" and "closed".
		const state = data.window.state;
		return {
			clubName: club.name,
			clubNumber: club.clubNumber,
			meeting: data.meeting,
			targets: data.targets,
			state,
		};
	},
	component: FeedbackPage,
	notFoundComponent: FeedbackNotFound,
	head: () => ({
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
});

function FeedbackNotFound() {
	const { clubId } = Route.useParams();
	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<MeetingNotFound clubId={clubId} />
		</div>
	);
}

/**
 * Per-meeting reminder of which cards this TAB has sent to. Only a reminder:
 * the card stays tappable, and nothing server-side reads it.
 *
 * `sessionStorage`, never `localStorage`: a phone passed round the room, or a
 * shared family tablet, would otherwise keep a durable record of who wrote to
 * whom — the one thing an anonymous note must not leave behind. It ends with
 * the tab. Every access is wrapped: a private window can refuse storage.
 */
const sentKey = (meetingId: string) => `gavelup:feedback-sent:${meetingId}`;
const targetKey = (t: Pick<FeedbackTarget, "kind" | "id">) =>
	`${t.kind}:${t.id}`;

function readSent(meetingId: string): string[] {
	try {
		const raw = sessionStorage.getItem(sentKey(meetingId));
		const v = raw ? JSON.parse(raw) : [];
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function writeSent(meetingId: string, keys: string[]): void {
	try {
		sessionStorage.setItem(sentKey(meetingId), JSON.stringify(keys));
	} catch {
		// Storage refused; the mark is only a reminder.
	}
}

function FeedbackPage() {
	const { clubName, clubNumber, meeting, targets, state } =
		Route.useLoaderData();
	const [selected, setSelected] = useState<FeedbackTarget | null>(null);
	// Read after mount, so the server render and the first client render agree.
	const [sent, setSent] = useState<string[]>([]);
	useEffect(() => setSent(readSent(meeting.id)), [meeting.id]);

	function markSent(t: FeedbackTarget) {
		const next = [...new Set([...readSent(meeting.id), targetKey(t)])];
		writeSent(meeting.id, next);
		setSent(next);
		setSelected(null);
	}

	const dateLabel = formatMeetingDate(meeting.date, meeting.timezone);

	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				<ThemeToggle compact />
			</header>

			<main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-8">
				<div className="text-center">
					<h1 className="font-display text-2xl font-semibold">
						Leave feedback
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{meeting.title ? `${meeting.title} · ${dateLabel}` : dateLabel}
					</p>
				</div>

				{state === "notYet" ? (
					<p
						data-testid="feedback-state"
						className="rounded-xl border border-border bg-muted/60 px-4 py-3 text-center text-sm font-medium text-muted-foreground"
					>
						{FEEDBACK_NOT_OPEN_MESSAGE}
					</p>
				) : state === "closed" ? (
					<p
						data-testid="feedback-state"
						className="rounded-xl border border-border bg-muted/60 px-4 py-3 text-center text-sm font-medium text-muted-foreground"
					>
						{FEEDBACK_CLOSED_MESSAGE}
					</p>
				) : selected ? (
					<FeedbackForm
						meetingId={meeting.id}
						target={selected}
						onBack={() => setSelected(null)}
						onSent={() => markSent(selected)}
					/>
				) : targets.length === 0 ? (
					<p className="text-center text-sm text-muted-foreground">
						No one holds a role on this meeting's agenda yet.
					</p>
				) : (
					<>
						<p className="text-center text-sm text-muted-foreground">
							Pick someone to leave them an anonymous note about their role.
							They'll see it after the meeting, and they won't see who wrote it.
						</p>
						<ul className="flex flex-col gap-2" aria-label="People to thank">
							{targets.map((t) => {
								const isSent = sent.includes(targetKey(t));
								return (
									<li key={targetKey(t)}>
										<button
											type="button"
											onClick={() => setSelected(t)}
											className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/60"
										>
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium">
													{t.memberName}
												</span>
												<span className="block truncate text-sm text-muted-foreground">
													{t.roleLabel}
												</span>
											</span>
											{isSent ? (
												<span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
													Sent
													<Check className="size-4" aria-hidden />
												</span>
											) : (
												<MessageSquareHeart
													className="size-5 shrink-0 text-muted-foreground"
													aria-hidden
												/>
											)}
										</button>
									</li>
								);
							})}
						</ul>
					</>
				)}
			</main>
			<PublicFooter />
		</div>
	);
}

function FeedbackForm({
	meetingId,
	target,
	onBack,
	onSent,
}: {
	meetingId: string;
	target: FeedbackTarget;
	onBack: () => void;
	onSent: () => void;
}) {
	const [wentWell, setWentWell] = useState("");
	const [tryNext, setTryNext] = useState("");
	const send = useMutation({
		mutationFn: () =>
			leaveFeedback({
				data: {
					meetingId,
					target: { kind: target.kind, id: target.id },
					wentWell,
					tryNext,
				},
			}),
		onSuccess: onSent,
	});
	const tooLong =
		wentWell.trim().length > FEEDBACK_TEXT_MAX ||
		tryNext.trim().length > FEEDBACK_TEXT_MAX;
	const empty = !wentWell.trim() && !tryNext.trim();

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (empty || tooLong || send.isPending) return;
				send.mutate();
			}}
		>
			<Button
				type="button"
				variant="ghost"
				className="self-start"
				onClick={onBack}
			>
				<ChevronLeft className="size-4" aria-hidden />
				Everyone
			</Button>
			<div>
				<h2 className="font-display text-xl font-semibold">
					{target.memberName}
				</h2>
				<p className="text-sm text-muted-foreground">{target.roleLabel}</p>
			</div>
			<p className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
				Don't write anything you wouldn't say to them in person.
			</p>
			<FeedbackBox
				id="feedback-went-well"
				label="What went well"
				value={wentWell}
				onChange={setWentWell}
			/>
			<FeedbackBox
				id="feedback-try-next"
				label="One thing to try"
				value={tryNext}
				onChange={setTryNext}
			/>
			<Button
				type="submit"
				size="lg"
				disabled={empty || tooLong || send.isPending}
			>
				{send.isPending ? "Sending…" : "Send anonymously"}
			</Button>
			{send.isError ? (
				<p role="alert" className="text-sm text-destructive">
					{send.error instanceof Error && send.error.message
						? send.error.message
						: "Couldn't send. Try again."}
				</p>
			) : null}
		</form>
	);
}

function FeedbackBox({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	const n = value.trim().length;
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				rows={3}
				aria-describedby={`${id}-count`}
			/>
			<span
				id={`${id}-count`}
				className={
					n > FEEDBACK_TEXT_MAX
						? "self-end text-xs text-destructive"
						: "self-end text-xs text-muted-foreground"
				}
			>
				{n}/{FEEDBACK_TEXT_MAX}
			</span>
		</div>
	);
}
