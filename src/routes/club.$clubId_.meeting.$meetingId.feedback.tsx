import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Check, ChevronLeft, MessageSquareHeart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { CancelledMeetingNotice } from "#/components/club/cancelled-meeting-notice";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
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
	GENERAL_FEEDBACK_LABEL,
	TABLE_TOPICS_SPEAKER_LABEL,
} from "#/lib/role-feedback-input";
import {
	type FeedbackRoleChoice,
	type FeedbackTargetsPublic,
	getFeedbackTargetsPublic,
	leaveFeedback,
	type PublicFeedbackTarget,
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
		// null for an archived club or an unknown key — the same not-found to a
		// visitor. The reader answers null rather than throwing, but a "Meeting
		// not found." is translated too, like every sibling sub-route (#877).
		const data = await getFeedbackTargetsPublic({
			data: { clubId: club.id, meetingKey: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		if (!data) throw notFound();
		// #1057: a cancelled meeting is VISIBLE and says so (the maintainer's
		// decision on #1084), so it is not a not-found. The same reader says so,
		// off the same row, with the meeting's id and status and nothing else.
		if ("status" in data) {
			return {
				cancelled: true as const,
				clubName: club.name,
				clubNumber: club.clubNumber,
				meetingId: data.meetingId,
			};
		}
		// The server decided the state on ITS clock; the visitor's clock may be
		// wrong, and must not choose between "not yet" and "closed".
		const state = data.window.state;
		return {
			clubName: club.name,
			clubNumber: club.clubNumber,
			meeting: data.meeting,
			targets: data.targets,
			others: data.others,
			roleOptions: data.roleOptions,
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
 * Per-meeting reminder of which PEOPLE this TAB has sent to. Only a reminder:
 * the row stays tappable, and nothing server-side reads it.
 *
 * `sessionStorage`, never `localStorage`: a phone passed round the room, or a
 * shared family tablet, would otherwise keep a durable record of who wrote to
 * whom — the one thing an anonymous note must not leave behind. It ends with
 * the tab. Every access is wrapped: a private window can refuse storage.
 *
 * Keyed by member id since #1021, whatever role the note was sent under, so
 * every row for that person shows "Sent" in both sections. Keys the page wrote
 * before that (`slot:<id>`, `tableTopics:<id>`) match no member id and are
 * simply ignored: they only ever lived for the tab.
 */
const sentKey = (meetingId: string) => `gavelup:feedback-sent:${meetingId}`;
/** One agenda row's key: the list's React key and its picker option value. */
const targetKey = (t: Pick<PublicFeedbackTarget, "kind" | "id">) =>
	`${t.kind}:${t.id}`;

type Targets = FeedbackTargetsPublic["targets"];
type RoleOptions = FeedbackTargetsPublic["roleOptions"];

interface PickerOption {
	value: string;
	label: string;
	choice: FeedbackRoleChoice;
}

/** Who the form is for, and the role it opens on: the tapped agenda row, or
 *  "General" from "Someone else". An OPTION, not a value to look up, so the
 *  form never has to guess what to send. */
interface Recipient {
	memberId: string;
	name: string;
	preset: PickerOption;
}

const GENERAL_OPTION: PickerOption = {
	value: "general",
	label: GENERAL_FEEDBACK_LABEL,
	choice: { kind: "general" },
};

const heldOption = (t: PublicFeedbackTarget): PickerOption => ({
	value: targetKey(t),
	label: t.roleLabel,
	choice:
		t.kind === "slot"
			? { kind: "slot", slotId: t.id }
			: { kind: "tableTopics", speakerId: t.id },
});

/**
 * The roles the picker offers for one recipient (#1021), in order:
 *  1. every role they hold at this meeting, with its numbered label;
 *  2. the club's enabled roles, minus every definition they already hold
 *     (so "Speaker 2" is offered and bare "Speaker" is not);
 *  3. "Table Topics speaker", unless they are on the Table Topics list;
 *  4. "General".
 * An INACTIVE recipient (reachable only from the agenda) gets 1 alone. The
 * SERVER is the authority on that rule (`resolvePersonNote` refuses kinds 2-4
 * for an inactive member); this only mirrors it so the picker does not offer
 * a choice that would be refused.
 */
function pickerOptions(
	memberId: string,
	targets: Targets,
	roleOptions: RoleOptions,
): PickerOption[] {
	const held = targets.filter((t) => t.recipientMemberId === memberId);
	const out: PickerOption[] = held.map(heldOption);
	// Mirrors the server's rule, which is the one that holds (see above).
	if (held.some((t) => !t.recipientActive)) return out;
	const heldDefs = new Set(held.map((t) => t.roleDefinitionId));
	for (const r of roleOptions) {
		if (heldDefs.has(r.roleDefinitionId)) continue;
		out.push({
			value: `definition:${r.roleDefinitionId}`,
			label: r.name,
			choice: { kind: "definition", roleDefinitionId: r.roleDefinitionId },
		});
	}
	if (!held.some((t) => t.kind === "tableTopics")) {
		out.push({
			value: "tableTopicsSpeaker",
			label: TABLE_TOPICS_SPEAKER_LABEL,
			choice: { kind: "tableTopicsSpeaker" },
		});
	}
	out.push(GENERAL_OPTION);
	return out;
}

/** Case-insensitive, anywhere in the name or the name they go by. */
function matchesQuery(
	m: { name: string; preferredName: string | null },
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return (
		m.name.toLowerCase().includes(q) ||
		(m.preferredName ?? "").toLowerCase().includes(q)
	);
}

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

/** The loader's open-meeting branch, stated rather than derived: deriving it
 *  from `Route` is circular (the route names this page as its component). */
interface OpenFeedbackData {
	clubName: string;
	clubNumber: string | null;
	meeting: FeedbackTargetsPublic["meeting"];
	targets: FeedbackTargetsPublic["targets"];
	others: FeedbackTargetsPublic["others"];
	roleOptions: FeedbackTargetsPublic["roleOptions"];
	state: FeedbackTargetsPublic["window"]["state"];
}

function FeedbackPage() {
	const data = Route.useLoaderData();
	if ("cancelled" in data && data.cancelled) {
		return <FeedbackCancelled {...data} />;
	}
	return <FeedbackOpen data={data as OpenFeedbackData} />;
}

/** A cancelled meeting (#1057): there is nobody to write to, so the page says
 *  why instead of listing names. */
function FeedbackCancelled({
	clubName,
	clubNumber,
	meetingId,
}: {
	clubName: string;
	clubNumber: string | null;
	meetingId: string;
}) {
	const { clubId } = Route.useParams();
	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				<ThemeToggle compact />
			</header>
			<main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-10">
				<CancelledMeetingNotice
					clubId={clubId}
					meetingId={meetingId}
					detail="There's no feedback to leave for a cancelled meeting."
				/>
			</main>
			<PublicFooter />
		</div>
	);
}

function FeedbackOpen({ data }: { data: OpenFeedbackData }) {
	const { clubName, clubNumber, meeting, targets, others, roleOptions, state } =
		data;
	const [selected, setSelected] = useState<Recipient | null>(null);
	const [query, setQuery] = useState("");
	// Read after mount, so the server render and the first client render agree.
	const [sent, setSent] = useState<string[]>([]);
	useEffect(() => setSent(readSent(meeting.id)), [meeting.id]);

	function markSent(memberId: string) {
		const next = [...new Set([...readSent(meeting.id), memberId])];
		writeSent(meeting.id, next);
		setSent(next);
		setSelected(null);
	}

	const shownOthers = useMemo(
		() => others.filter((m) => matchesQuery(m, query)),
		[others, query],
	);
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
						recipient={selected}
						options={pickerOptions(selected.memberId, targets, roleOptions)}
						onBack={() => setSelected(null)}
						onSent={() => markSent(selected.memberId)}
					/>
				) : targets.length === 0 && others.length === 0 ? (
					<p className="text-center text-sm text-muted-foreground">
						No one holds a role on this meeting's agenda yet.
					</p>
				) : (
					<>
						<p className="text-center text-sm text-muted-foreground">
							Pick someone to leave them an anonymous note about their role.
							They'll see it after the meeting, and they won't see who wrote it.
						</p>
						<section className="flex flex-col gap-2">
							<h2 className="text-sm font-semibold text-muted-foreground">
								At this meeting
							</h2>
							{targets.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No one holds a role on this meeting's agenda yet.
								</p>
							) : (
								<ul
									className="flex flex-col gap-2"
									aria-label="People to thank"
								>
									{targets.map((t) => (
										<li key={targetKey(t)}>
											<PersonRow
												name={t.memberName}
												detail={t.roleLabel}
												sent={sent.includes(t.recipientMemberId)}
												onClick={() =>
													setSelected({
														memberId: t.recipientMemberId,
														name: t.memberName,
														preset: heldOption(t),
													})
												}
											/>
										</li>
									))}
								</ul>
							)}
						</section>
						{others.length > 0 ? (
							<section className="flex flex-col gap-2">
								<h2 className="text-sm font-semibold text-muted-foreground">
									Someone else
								</h2>
								<Input
									type="search"
									aria-label="Search members"
									placeholder="Search by name…"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									autoComplete="off"
								/>
								<ul className="flex flex-col gap-2" aria-label="Other members">
									{shownOthers.map((m) => (
										<li key={m.memberId}>
											<PersonRow
												name={m.name}
												sent={sent.includes(m.memberId)}
												onClick={() =>
													setSelected({
														memberId: m.memberId,
														name: m.name,
														preset: GENERAL_OPTION,
													})
												}
											/>
										</li>
									))}
								</ul>
								{shownOthers.length === 0 ? (
									<p className="text-sm text-muted-foreground">
										No one matches that name.
									</p>
								) : null}
							</section>
						) : null}
					</>
				)}
			</main>
			<PublicFooter />
		</div>
	);
}

function PersonRow({
	name,
	detail,
	sent,
	onClick,
}: {
	name: string;
	detail?: string;
	sent: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/60"
		>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium">{name}</span>
				{detail ? (
					<span className="block truncate text-sm text-muted-foreground">
						{detail}
					</span>
				) : null}
			</span>
			{sent ? (
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
	);
}

function FeedbackForm({
	meetingId,
	recipient,
	options,
	onBack,
	onSent,
}: {
	meetingId: string;
	recipient: Recipient;
	options: PickerOption[];
	onBack: () => void;
	onSent: () => void;
}) {
	const [wentWell, setWentWell] = useState("");
	const [tryNext, setTryNext] = useState("");
	// The option itself, not a string to look up again at send time: what is
	// selected is exactly what is sent. The preset is built by the same helpers
	// as `options`, so its value is always among them.
	const [picked, setPicked] = useState<PickerOption>(recipient.preset);
	const send = useMutation({
		mutationFn: () =>
			leaveFeedback({
				data: {
					meetingId,
					recipientMemberId: recipient.memberId,
					role: picked.choice,
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
			<h2 className="font-display text-xl font-semibold">{recipient.name}</h2>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="feedback-role">Role</Label>
				<select
					id="feedback-role"
					value={picked.value}
					onChange={(e) => {
						const next = options[e.target.selectedIndex];
						if (next) setPicked(next);
					}}
					className="h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm"
				>
					{options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
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
