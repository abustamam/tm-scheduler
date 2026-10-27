import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import {
	currentOrigin,
	mentorRequestErrorText,
} from "#/components/members/mentor-request-shared";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { formatShortDate } from "#/lib/format";
import {
	MENTORS_MEMBERS_ONLY_MESSAGE,
	MENTORSHIP_FOCUS_LABELS,
	MENTORSHIP_FOCUS_OTHER_MAX,
	MENTORSHIP_FOCUSES,
	type MentorshipFocus,
	mentorshipFocusText,
} from "#/lib/mentorship";
import {
	getMyMentorRequests,
	getMyMentorships,
	listMentors,
	type MentorListing,
	type MentorRequestParty,
	type MentorshipRow,
	type OutgoingMentorRequest,
	requestMentor,
	withdrawMentorRequest,
} from "#/server/mentorship";

const FIND_A_MENTOR_HEADING = "Find a mentor";
const NO_MENTORS_MESSAGE =
	"Nobody in your club has offered to mentor yet. Ask your VP Education.";
const NO_BIO_TEXT = "No bio yet";

/**
 * Find a mentor (#945, #1209): the club's members who said they are willing to
 * mentor, with the bio each wrote and how many people they mentor now, and a
 * way to ask one. For active members of the club only, never public (the route
 * sits under `_authed`, and `listMentors` refuses a caller with no membership of
 * their own, such as a read-only impersonation). No contact details on the
 * cards; the draft after asking carries the one mentor's, as their member page
 * already shows them to club members.
 *
 * The member's own mentors and latest request ride along so the page can show
 * "Your mentor", disable the focuses already paired, and hold the pending
 * banner. Both are best-effort: a failed read leaves the buttons on and the
 * server refuses what it must.
 */
export const Route = createFileRoute("/_authed/mentors")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		if (!clubId) throw redirect({ to: "/dashboard" });
		try {
			const [mentors, mine, requests, timezone] = await Promise.all([
				listMentors({ data: { clubId } }),
				getMyMentorships({ data: { clubId } }).catch(() => null),
				getMyMentorRequests({ data: { clubId } }).catch(() => null),
				// The club's zone, for the date on the pending banner. Imported
				// here as the dashboard does; a failed read falls back to UTC.
				import("#/server/clubs")
					.then(({ loadClubTimezoneSettings }) =>
						loadClubTimezoneSettings({ data: clubId }),
					)
					.then((settings) => settings.timezone)
					.catch(() => "UTC"),
			]);
			return {
				clubId,
				timezone,
				mentors,
				refused: null as string | null,
				pairings: mine?.mentors ?? ([] as MentorshipRow[]),
				request: requests?.outgoing ?? (null as OutgoingMentorRequest | null),
			};
		} catch (err) {
			// The one refusal the page explains: the default error page never shows
			// a message. Anything else is a real failure and keeps that page.
			if (
				err instanceof Error &&
				err.message === MENTORS_MEMBERS_ONLY_MESSAGE
			) {
				return {
					clubId,
					timezone: "UTC",
					mentors: [] as MentorListing[],
					refused: err.message,
					pairings: [] as MentorshipRow[],
					request: null as OutgoingMentorRequest | null,
				};
			}
			throw err;
		}
	},
	component: MentorsPage,
});

/** "Mentoring 2 people now" / "Not mentoring anyone yet". */
function menteeCountText(n: number): string {
	if (n === 0) return "Not mentoring anyone yet";
	return `Mentoring ${n} ${n === 1 ? "person" : "people"} now`;
}

function MentorsPage() {
	const { clubId, timezone, mentors, refused, pairings, request } =
		Route.useLoaderData();
	const pending = request?.status === "pending" ? request : null;
	return (
		<PageContainer className="space-y-5">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{FIND_A_MENTOR_HEADING}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Members of your club who have offered to mentor.
				</p>
			</div>
			<RequestStatus request={request} timezone={timezone} />
			{refused ? (
				<p role="alert" className="text-sm">
					{refused}
				</p>
			) : mentors.length === 0 ? (
				<p className="text-sm text-muted-foreground">{NO_MENTORS_MESSAGE}</p>
			) : (
				<ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
					{mentors.map((m) => (
						<li
							key={m.memberId}
							data-mentor={m.memberId}
							className="rounded-2xl border border-border bg-surface-raised px-5 py-4"
						>
							<h2 className="flex flex-wrap items-center gap-2 text-base font-bold text-foreground">
								{m.name}
								{pairings.some((p) => p.member.id === m.memberId) ? (
									<span className="rounded-full bg-link/10 px-2 py-0.5 text-xs font-semibold text-link">
										Your mentor
									</span>
								) : null}
							</h2>
							<p
								className={
									m.mentorBio
										? "mt-1 text-sm whitespace-pre-wrap"
										: "mt-1 text-sm text-muted-foreground"
								}
							>
								{m.mentorBio ?? NO_BIO_TEXT}
							</p>
							<p className="mt-2 text-xs text-muted-foreground">
								{menteeCountText(m.activeMenteeCount)}
							</p>
							<AskToMentor
								clubId={clubId}
								mentor={m}
								pairedFocuses={pairings
									.filter((p) => p.member.id === m.memberId)
									.map((p) => p.focus)}
								disabled={pending !== null}
							/>
						</li>
					))}
				</ul>
			)}
		</PageContainer>
	);
}

/**
 * The member's latest request: while pending, who they asked and when, with
 * Withdraw; after a decline, the no-reason message. Accepted and withdrawn
 * ones say nothing here (a pairing shows as "Your mentor").
 */
function RequestStatus({
	request,
	timezone,
}: {
	request: OutgoingMentorRequest | null;
	timezone: string;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!request) return null;
	if (request.status === "declined") {
		return (
			<p className="text-sm" data-slot="request-declined">
				{request.mentor.name} can't take you on right now. You can ask someone
				else.
			</p>
		);
	}
	if (request.status !== "pending") return null;
	const pending = request;
	async function withdraw() {
		setBusy(true);
		setError(null);
		try {
			await withdrawMentorRequest({ data: { requestId: pending.id } });
			await router.invalidate();
		} catch (err) {
			setError(mentorRequestErrorText(err));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div
			className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface-raised px-5 py-3 text-sm"
			data-slot="request-pending"
		>
			<span>
				You asked {pending.mentor.name} on{" "}
				{formatShortDate(pending.createdAt, timezone)}.
			</span>
			<Button
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() => void withdraw()}
			>
				{busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
				Withdraw
			</Button>
			{error ? (
				<p role="alert" className="w-full text-xs text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}

const SELECT =
	"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/** What the Ask dialog keeps once the request is stored. */
interface SentRequest {
	mentor: MentorRequestParty;
	focus: MentorshipFocus;
	focusOther: string | null;
}

/** Shown in place of the draft when the mentor has no phone or email on file. */
export const NO_MENTOR_CONTACT_TEXT =
	"They have no contact details on file, so tell them yourself that you asked.";

/**
 * "Ask to mentor me": a focus choice, then, once sent, the draft the mentee
 * can send the mentor themselves (the app sends nothing). Disabled while the
 * member has a pending request; the focuses they already have with THIS mentor
 * are not offered.
 */
function AskToMentor({
	clubId,
	mentor,
	pairedFocuses,
	disabled,
}: {
	clubId: string;
	mentor: MentorListing;
	pairedFocuses: readonly (MentorshipFocus | null)[];
	disabled: boolean;
}) {
	const router = useRouter();
	const ids = useId();
	const firstFree =
		MENTORSHIP_FOCUSES.find((f) => !pairedFocuses.includes(f)) ?? null;
	const [open, setOpen] = useState(false);
	const [focus, setFocus] = useState<MentorshipFocus>(
		pairedFocuses.includes("new_member")
			? (firstFree ?? "new_member")
			: "new_member",
	);
	const [focusOther, setFocusOther] = useState("");
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState(false);
	// The mentor's contact as `requestMentor` returned it, with the focus just
	// sent. Held here, not taken from the loader: the draft must not wait on the
	// page's reload, nor on a second read.
	const [draftFor, setDraftFor] = useState<SentRequest | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function send() {
		setBusy(true);
		setError(null);
		try {
			const sentFocusOther =
				focus === "other" ? focusOther.trim() || null : null;
			const out = await requestMentor({
				data: {
					clubId,
					mentorMemberId: mentor.memberId,
					focus,
					focusOther: sentFocusOther,
				},
			});
			setDraftFor({
				mentor: out.mentor,
				focus,
				focusOther: sentFocusOther,
			});
			setSent(true);
			try {
				await router.invalidate();
			} catch {
				// The request is stored; the page catches up on its next load.
			}
		} catch (err) {
			setError(mentorRequestErrorText(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			{/* Outline: one per mentor, so a filled primary here would put several
			    equal primaries on the screen (DESIGN.md). */}
			<Button
				size="sm"
				variant="outline"
				className="mt-3"
				disabled={disabled || firstFree === null}
				onClick={() => {
					setSent(false);
					setDraftFor(null);
					setError(null);
					setOpen(true);
				}}
			>
				Ask to mentor me
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Ask {mentor.name} to mentor you</DialogTitle>
						<DialogDescription>
							{sent
								? draftFor && (draftFor.mentor.phone || draftFor.mentor.email)
									? `Request sent to ${mentor.name}. Let them know:`
									: `Request sent to ${mentor.name}.`
								: "They can accept or decline. You can withdraw until they answer."}
						</DialogDescription>
					</DialogHeader>
					{sent ? (
						draftFor && (draftFor.mentor.phone || draftFor.mentor.email) ? (
							<NudgeButtons
								mode="mentorRequest"
								name={draftFor.mentor.name}
								phone={draftFor.mentor.phone}
								email={draftFor.mentor.email}
								preferredContact={draftFor.mentor.preferredContact}
								focusLabel={
									mentorshipFocusText(draftFor.focus, draftFor.focusOther) ??
									MENTORSHIP_FOCUS_LABELS[draftFor.focus]
								}
								origin={currentOrigin()}
							/>
						) : (
							<p className="text-sm" data-slot="no-mentor-contact">
								{NO_MENTOR_CONTACT_TEXT}
							</p>
						)
					) : (
						<div className="flex flex-col gap-2">
							<Label htmlFor={`${ids}-focus`}>
								What would you like help with?
							</Label>
							<select
								id={`${ids}-focus`}
								className={SELECT}
								value={focus}
								disabled={busy}
								onChange={(e) => setFocus(e.target.value as MentorshipFocus)}
							>
								{MENTORSHIP_FOCUSES.map((f) => (
									<option
										key={f}
										value={f}
										disabled={pairedFocuses.includes(f)}
									>
										{MENTORSHIP_FOCUS_LABELS[f]}
									</option>
								))}
							</select>
							{focus === "other" ? (
								<Input
									aria-label="Describe the focus"
									placeholder="What would you like help with?"
									maxLength={MENTORSHIP_FOCUS_OTHER_MAX}
									value={focusOther}
									disabled={busy}
									onChange={(e) => setFocusOther(e.target.value)}
								/>
							) : null}
							{error ? (
								<p role="alert" className="text-xs text-destructive">
									{error}
								</p>
							) : null}
							<Button
								disabled={busy || pairedFocuses.includes(focus)}
								onClick={() => void send()}
							>
								{busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
								Send request
							</Button>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
