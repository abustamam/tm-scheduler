// src/components/club/personal-meeting-body.tsx
//
// The body of the personal meeting page (#665) — everything below the route's
// identity/loading/not-found branching, plus (since #676) the SHELL and the
// four page states that branching renders.
//
// It lives HERE rather than inside the route file for the reason CLAUDE.md
// gives and the coverage audit proved: a route file cannot be mounted in
// vitest (it pulls `#/server/personal-meeting` → `#/db` → "DATABASE_URL is not
// set"), so ~260 lines of branching presentation logic had no test surface at
// all — including the confirm gate on the only irreversible write on the page.
// `meeting-personal-strip.tsx` is the precedent; `season-grid.test.tsx` already
// `vi.mock`s `#/server/availability` and `meeting-nav-strip.test.tsx` already
// mounts a TanStack `<Link>` through `createMemoryHistory`, so the "large
// brittle fixture" objection does not hold.
//
// #676 extends that boundary rather than redrawing it: `PersonalMeetingShell`,
// `PersonalMeetingNotice`, `PersonalMeetingLoading` and `formatMeetingKeyLabel`
// are the page's non-happy states, and they were unreachable for exactly the
// same reason the body was. `PersonalMeetingNotice` takes `title` as a REQUIRED
// prop, which is the structural half of the finding that earned it: the four
// states each rendered a bare grey `<p>` with no heading, and a required prop
// makes a heading-less state fail to compile rather than fail in review. Three
// of the four route through it — loading keeps the centred-spinner convention
// the issue itself cited and gains the meeting NAME instead of a heading; see
// `PersonalMeetingNotice`'s own docblock for why.
//
// ## Two stale-state rules, and they are the same rule twice
//
// These links sit in a WhatsApp thread for hours or days, so EVERY decision
// taken from `view` is taken from data that may already be wrong:
//
//   1. The decline WRITE never branches on `holdsRole`. If an officer assigns a
//      role after the page loaded, a `holdsRole`-gated branch would write plain
//      `not_coming` and leave the member declined AND still holding the role.
//   2. The CONFIRM never branches on `holdsRole` either. That was the first
//      cut's bug, and it is the same window pointing the other way: role
//      assigned after load ⇒ `holdsRole` false ⇒ the button reads "No, I can't"
//      ⇒ one tap releases the just-assigned role with no confirmation and no
//      undo. Only the COPY varies on `holdsRole`; the dialog always appears.
//
// ## The decline branches on the VIEWER, not on the view (#762, ADR-0026)
//
// Rules 1 and 2 forbid branching on `holdsRole` because it goes stale in the
// chat thread. `canRepick` does not: it is false exactly when the page was
// rendered for a signed-in member, and a session does not evaporate between
// render and tap. So the decline picks its ENDPOINT from it.
//
// It has to. This page IS the nudge link's destination and its audience is
// session-less by construction — a name in a WhatsApp message, not an account
// — and `markUnavailableReleasing` now refuses an asserted caller outright
// rather than downgrading. Left unconditional, the single button this page
// exists for would have thrown for almost everyone who taps it, losing the
// answer as well as the release. So a session-less decline records the rung
// through `setPlannedAttendance` and frees nothing, which is what that caller
// was always going to get, and the copy says so instead of promising a
// release that will not happen.
//
// The role, if they hold one, stays theirs on the agenda and the officer sees
// them on the Not Available list — the pre-#663 behaviour, and the reason the
// dialog's session-less copy points at the officer rather than at the slot.
//
// ## Tap targets: `min-h-11` at the call site, not a new size variant
//
// `lg` is already the largest non-icon size in `buttonVariants` and it is
// `h-10` (40px) — under the 44px iOS HIG / 48dp Material floor on a surface
// whose entire job is one tap from a phone. `min-h-11` layers over `h-10`
// cleanly (tailwind-merge keeps both; `min-height` wins), so the floor is set
// where it is needed instead of moving a variant every other page shares.
// jsdom performs no layout, so nothing in-process can see the RESULT of that
// class — see the test file's note on which half each assertion buys.

import { Link } from "@tanstack/react-router";
import {
	ArrowRight,
	CheckCircle2,
	Circle,
	Loader2,
	Printer,
	XCircle,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { showWriteError } from "#/components/write-error-toast";
import { evaluatorFormBrief } from "#/lib/evaluator-form";
import { formatMeetingDate, formatMeetingTime } from "#/lib/format";
import { listRoles } from "#/lib/list-roles";
import {
	isMeetingLocked,
	isMeetingOver,
	meetingPhase,
} from "#/lib/meeting-lifecycle";
import { parseMeetingKey } from "#/lib/meeting-url";
import {
	type DutyTarget,
	dutiesForRole,
	ROLE_CONFIRM_PROMPT,
} from "#/lib/role-duties";
import {
	EMPTY_ROLE_GUIDE,
	findRoleGuideSource,
	meetingRoleSheetHref,
	type RoleGuideSource,
	roleGuide,
	roleSheetForKey,
} from "#/lib/role-guide";
import { setPlannedAttendance } from "#/server/attendance-plan";
import { markUnavailableReleasing } from "#/server/availability";
import type { PersonalMeetingView } from "#/server/personal-meeting";
import { guideOpenState, RoleGuideSections } from "./role-guide-sections";

/** The scannable stamp above a heading — the club shell header's own recipe,
 *  and `roles-guide.tsx`'s for a group label. */
const EYEBROW =
	"text-muted-foreground text-xs font-semibold uppercase tracking-[0.04em]";

/** Which answer is in flight. A boolean could only fade BOTH buttons, which is
 *  the finding: the member cannot tell that anything is happening, nor which
 *  one they tapped. `"release"` is the dialog's destructive commit, not the
 *  button that opens it — opening the dialog writes nothing. */
type Pending = "coming" | "release" | null;

export function PersonalMeetingBody({
	view,
	clubId,
	meetingId,
	onChanged,
	onNotYou,
	canRepick,
	roleGuides,
}: {
	view: PersonalMeetingView;
	clubId: string;
	meetingId: string;
	onChanged: () => Promise<void>;
	onNotYou: () => void;
	/** False for a signed-in member, whose identity is the session and cannot be
	 *  re-picked from here. */
	canRepick: boolean;
	/**
	 * The club's roles guide (#933) — `getPublicClubRoles`, read by the route's
	 * loader — from which each held role's Before/During text is matched. An
	 * empty list (a failed guide read degrades to one) shows every role's
	 * duties and nothing under them.
	 */
	roleGuides: readonly RoleGuideSource[];
}) {
	const [pending, setPending] = useState<Pending>(null);
	const busy = pending !== null;
	const [confirmRelease, setConfirmRelease] = useState(false);
	const when = formatMeetingDate(view.meeting.scheduledAt, view.club.timezone);
	// The one fact this page existed without: a coming/not-coming decision turns
	// on the START TIME, and `formatMeetingDate` emits weekday/month/day only.
	// It takes the eyebrow band because the club shell header already prints the
	// club name ~50px above in near-identical styling, so the eyebrow was
	// spending the most valuable strip of a phone viewport saying it twice.
	// `formatMeetingTime`, not `formatMeetingTimeRange`: the range needs a
	// `lengthMinutes` the seam does not select, and the finish time is not what
	// the decision turns on.
	const startsAt = formatMeetingTime(
		view.meeting.scheduledAt,
		view.club.timezone,
	);
	const holdsRole = view.roles.length > 0;
	const holdsUnconfirmed = view.roles.some((r) => r.status === "claimed");
	// `canRepick` is true for a name-picked viewer and false for a signed-in
	// member, so this is the session question asked in the vocabulary the page
	// already has — see the header's third rule for why it is the one piece of
	// state a decline may branch on.
	const canRelease = !canRepick;
	// ADR-0026's line on THIS page's two buttons, not just its decline. An
	// asserted viewer may fill a blank and may not change an answer, so once
	// `planStatus` holds one, both buttons are controls the server refuses —
	// and the decline half would run a confirm dialog saying "we'll let the team
	// know" on the way to that refusal. `meeting-personal-strip.tsx` made the
	// same split for the same writes; this page is the surface that split
	// matters most on, because it is where the nudge link lands.
	//
	// `reached_out` deliberately does NOT count: it is the officer's record of
	// having ASKED, the seam treats it as still-blank (`UNANSWERED_RUNGS`), and
	// it is the state a nudged member arrives in. Counting it would refuse the
	// round trip this page exists for.
	const answered =
		view.planStatus === "coming" || view.planStatus === "not_coming";
	const canAnswer = canRelease || !answered;

	// `isMeetingOver`, NOT `isMeetingLocked`. Locked is `status === "completed"`
	// only, and clubs routinely never press Complete — so last month's meeting
	// sits at "scheduled" forever while its nudge link stays in the chat
	// scrollback. One tap of "Can't make it" on that link would run
	// `markUnavailableReleasing` against a meeting that already HAPPENED, which
	// nulls `assigned_member_id` and `speech_id` on every slot the member held
	// and erases the record of who actually did what. `isMeetingOver` is the
	// repo's "one definition, every surface" rule for a closed planning window.
	// The COPY distinguishes the three reasons the window is shut.
	const locked = isMeetingLocked(view.meeting.status);
	const cancelled = view.meeting.status === "cancelled";
	// `|| cancelled` is NOT redundant: `isMeetingOver` is completed-or-day-passed,
	// and a cancelled meeting is neither while its date is still in the future.
	// Without it a cancelled-but-upcoming meeting kept offering answer buttons,
	// which the render test below caught.
	// ONE clock for this render, shared by the answer window below and the
	// guide's expanded half (#933), so the two cannot straddle club-local
	// midnight and disagree about which day it is.
	const now = new Date();
	const writesClosed =
		cancelled ||
		isMeetingOver({
			status: view.meeting.status,
			scheduledAt: view.meeting.scheduledAt,
			timezone: view.club.timezone,
			now,
		});
	// Which guide half starts open (#933 decision 4), off the repo's own
	// `meetingPhase` — the meeting page's phase rule, not a new clock: "Before"
	// ahead of the day, "During" on it, neither once it is over or cancelled.
	const guideOpen = guideOpenState(
		meetingPhase({
			status: view.meeting.status,
			scheduledAt: view.meeting.scheduledAt,
			timezone: view.club.timezone,
			now,
		}),
		cancelled,
	);

	// `view.meeting.id`, never the `meetingId` URL segment — the segment is a
	// club-local date key and both writers validate a uuid.
	const meetingUuid = view.meeting.id;

	const sendAnswer = useCallback(
		async (coming: boolean) => {
			setPending(coming ? "coming" : "release");
			try {
				if (coming) {
					// `confirmHeldRoles` is unconditional — rule 2 again. The server
					// resolves which slots are still `claimed` at write time (#908), so
					// a role assigned after this page loaded is confirmed too, and a
					// member with none gets exactly the plain answer.
					const { confirmedRoles } = await setPlannedAttendance({
						data: {
							memberId: view.member.id,
							meetingId: meetingUuid,
							status: "coming",
							confirmHeldRoles: true,
						},
					});
					// From the RESPONSE, never from `view.roles`: it names what the
					// server actually flipped, which is the only thing this toast may
					// claim.
					toast.success(
						confirmedRoles.length > 0
							? `Great — you're confirmed as ${listRoles(confirmedRoles)}. See you there.`
							: "Great — see you there.",
					);
				} else if (canRelease) {
					// Unconditional WITHIN this arm — see rule 1 in the header. The arm
					// itself is chosen by the viewer's session, not by the view.
					const { released } = await markUnavailableReleasing({
						data: {
							memberId: view.member.id,
							meetingId: meetingUuid,
							clubId: view.club.id,
						},
					});
					toast.success(
						released > 0
							? `Thanks — we've let the team know and freed up your ${released === 1 ? "role" : "roles"}.`
							: "Thanks — we've let the team know.",
					);
				} else {
					// Session-less: record the answer and free nothing. `releaseHeldRoles`
					// is left at its `false` default rather than sent as false, so this
					// is byte-for-byte the payload a pre-#663 client sends.
					await setPlannedAttendance({
						data: {
							memberId: view.member.id,
							meetingId: meetingUuid,
							status: "not_coming",
						},
					});
					// `holdsRole` for COPY only, which rules 1 and 2 explicitly allow.
					// It can be stale in the "role assigned since load" direction, and
					// the consequence of being wrong here is a sentence that omits the
					// role — not a write that does the wrong thing.
					toast.success(
						holdsRole
							? "Thanks — we've let the team know. An officer will find cover for your role."
							: "Thanks — we've let the team know.",
					);
				}
				// Closed BEFORE the refetch is awaited: the write has landed and the
				// toast has fired, so leaving the dialog up and the buttons disabled
				// for a second full round trip reads as still-working on a phone.
				setConfirmRelease(false);
				setPending(null);
				await onChanged();
			} catch (err) {
				showWriteError(err, "Couldn't save that answer.");
				// Deliberately NOT closing the dialog here: a failed release must stay
				// open to retry rather than dismissing itself behind a toast.
				setPending(null);
			}
		},
		[
			canRelease,
			holdsRole,
			meetingUuid,
			onChanged,
			view.club.id,
			view.member.id,
		],
	);

	// ALWAYS confirms — see rule 2 in the header. `holdsRole` picks the copy, and
	// nothing else, because it is read from a cached query.
	const answerNo = useCallback(() => setConfirmRelease(true), []);

	const target: DutyTarget = { clubId, meetingId };

	return (
		<>
			<header className="space-y-1">
				<p className={EYEBROW}>{startsAt}</p>
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					{holdsRole
						? `You're our ${listRoles(view.roles.map((r) => r.roleName))} for ${when}`
						: `Coming to the ${when} meeting?`}
				</h1>
				<p className="text-muted-foreground text-sm">Hi {view.member.name}.</p>
				{canRepick ? (
					// A link can be forwarded, so the person reading it is not always
					// the person it names. Without this the identity is changed by a URL
					// with no way to correct it from the page — which is why it gets the
					// same `text-primary` every other interactive text here has, and a
					// real target instead of a ~20px muted run of underlined words whose
					// only other affordance was a hover state a phone cannot produce.
					<div>
						<button
							type="button"
							onClick={onNotYou}
							className="-mx-2 inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-primary underline underline-offset-2"
						>
							Not you?
						</button>
					</div>
				) : null}
			</header>

			{/* Passed `writesClosed` so a stored answer never reads "Tap below" with
			    nothing below it — the normal end state of every link that outlived
			    its meeting in a chat thread. */}
			<AnswerState
				status={view.planStatus}
				writesClosed={writesClosed}
				canChange={canAnswer}
			/>

			{writesClosed ? (
				<p className="rounded-md border border-[var(--line)] p-3 text-muted-foreground text-sm">
					{cancelled
						? "This meeting was cancelled."
						: locked
							? "This meeting is finished, so answers are closed."
							: "This meeting has passed, so answers are closed."}
				</p>
			) : !canAnswer && view.planStatus === "coming" && holdsUnconfirmed ? (
				// Answered `coming` with no session, and holding a role (#908). The
				// answer cannot change from here, but re-sending the SAME answer is
				// not a change (ADR-0026's fill-blank rule lets it through as a
				// no-op) and it is what confirms the role. Without this, a member
				// whose `coming` was recorded before their role was confirmed — every
				// self-claim writes one, and so did every "I'll be there" before #908
				// — lands from the confirm nudge on a page with nothing to tap.
				// Offered only while at least one role is still `claimed`, so a member
				// whose roles are all confirmed is not shown a button that does
				// nothing. The view only decides whether the button is OFFERED; stale
				// in the "assigned since load" direction, it hides one, never misfires.
				<div className="space-y-2">
					<Button
						size="lg"
						className="min-h-11 w-full sm:w-auto"
						disabled={busy}
						aria-busy={pending === "coming"}
						onClick={() => void sendAnswer(true)}
					>
						I'll be there
						{pending === "coming" ? <SavingIndicator /> : null}
					</Button>
					<p className="text-muted-foreground text-sm">
						Sign in to change your answer.
					</p>
				</div>
			) : !canAnswer ? (
				// Answered already, with no session to change it. The ANSWER itself is
				// above (`AnswerState`); this says what would let them change it, and
				// it is text rather than a link for the reason the strip gives — a
				// refusal that is actually attempted still carries a real one-tap
				// link through `showWriteError`.
				<p className="rounded-md border border-[var(--line)] p-3 text-muted-foreground text-sm">
					Sign in to change your answer.
				</p>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<Button
						size="lg"
						className="min-h-11"
						disabled={busy}
						aria-busy={pending === "coming"}
						onClick={() => void sendAnswer(true)}
					>
						{holdsRole ? "I'll be there" : "Yes, I'm coming"}
						{pending === "coming" ? <SavingIndicator /> : null}
					</Button>
					<Button
						size="lg"
						variant="outline"
						className="min-h-11"
						disabled={busy}
						onClick={answerNo}
					>
						{holdsRole ? "Can't make it" : "No, I can't"}
					</Button>
				</div>
			)}

			{holdsRole ? (
				<section className="space-y-3">
					{/* The page's only heading used to be the h1, so every role group was
					    invisible to a heading-navigation pass. Group label recipe from
					    `roles-guide.tsx`. */}
					<h2 className={EYEBROW}>Before the meeting</h2>
					{view.roles.map((role) => {
						const duties = dutiesForRole({
							roleName: role.roleName,
							roleKey: role.roleKey,
						});
						// The guide text for this role (#933), AFTER the duties: the
						// duties are what the member can act on, the guide is reading.
						const guideSource = findRoleGuideSource(roleGuides, role);
						// An Evaluator with a speaker set (#1163): print rows in place
						// of the confirm prompt. Null for every other role and for an
						// unpaired or speaker-less evaluator, which keep the prompt.
						const evaluatorBrief = evaluatorFormBrief(role.evaluates ?? null);
						const sheet = roleSheetForKey(role.roleKey);
						return (
							<div
								key={role.slotId}
								className="rounded-lg border border-[var(--line)] p-3"
							>
								{/* A heading, and a size up from the `text-sm` duty labels it
								    heads — it was a `<p>` at the same size as its own list. */}
								<h3 className="font-semibold text-base text-foreground">
									{role.roleName}
								</h3>
								<ul className="mt-2 space-y-1">
									{duties.length > 0 ? (
										duties.map((duty) => {
											const done = duty.done({
												theme: view.meeting.theme,
												wordOfTheDay: view.meeting.wordOfTheDay,
												tableTopicsNotes: view.meeting.tableTopicsNotes,
												// Per-SLOT, never per-member: a member can hold two
												// speaker slots and one title must not tick both.
												speechTitle: role.speechTitle,
												// MEETING-scoped, unlike the line above, and the seam's
												// own docblock says why: a timing is recorded against a
												// SPEAKER's slot, never against the Timer's, so a
												// per-slot answer would be false for the Timer forever
												// — the permanently-unticked box `role-duties.ts`
												// forbids. Passing it is not optional bookkeeping: the
												// tick is the receipt, and without this the duty lands
												// with a `done` that can never be true (#730).
												hasTiming: view.meeting.hasTiming,
											});
											return (
												<li key={duty.id}>
													{/* `duty.href` as given — the duty registry owns
													    where a duty is done, and #666 is moving those
													    targets. Never hardcode one here. */}
													<Link to={duty.href(target)} className={DUTY_ROW}>
														{done ? (
															<CheckCircle2
																aria-hidden
																className="size-4 shrink-0 text-success"
															/>
														) : (
															<Circle
																aria-hidden
																className="size-4 shrink-0 text-muted-foreground"
															/>
														)}
														{/* The icons are aria-hidden, so without this the
														    done/not-done state — the whole point of a
														    checklist — is inaudible to a screen reader. */}
														<span className="sr-only">
															{done ? "Done: " : "To do: "}
														</span>
														<span
															className={
																done ? "text-muted-foreground line-through" : ""
															}
														>
															{duty.label}
														</span>
													</Link>
												</li>
											);
										})
									) : evaluatorBrief ? (
										// External links with no checkbox: "printed" is not something
										// the app can know, so nothing here can be ticked or go stale.
										evaluatorBrief.resources.map((resource) => (
											<li key={resource.key}>
												<a
													href={resource.url}
													target="_blank"
													rel="noopener noreferrer"
													className={DUTY_ROW}
												>
													<Printer
														aria-hidden
														className="size-4 shrink-0 text-muted-foreground"
													/>
													<span>
														{evaluatorBrief.isGenericFallback
															? `Print an evaluation form (ask ${evaluatorBrief.speaker} which project they're doing)`
															: `Print ${evaluatorBrief.speaker}'s evaluation form${resource.part ? ` (${resource.part})` : ""}`}
													</span>
												</a>
											</li>
										))
									) : (
										// A role that owns nothing recordable gets the prompt, not an
										// always-unticked box — see ROLE_CONFIRM_PROMPT's docblock.
										<li>
											<Link
												to={ROLE_CONFIRM_PROMPT.href(target)}
												className={DUTY_ROW}
											>
												<Circle
													aria-hidden
													className="size-4 shrink-0 text-muted-foreground"
												/>
												<span>{ROLE_CONFIRM_PROMPT.label}</span>
											</Link>
										</li>
									)}
								</ul>
								<RoleGuideSections
									// On the root, not a wrapper: a role with nothing to show
									// renders nothing, not an empty ruled box.
									className="mt-2 border-t border-[var(--line)] pt-2"
									guide={
										guideSource ? roleGuide(guideSource) : EMPTY_ROLE_GUIDE
									}
									// The meeting-aware copy: club, date and speakers filled
									// in. Keyed by the resolved uuid, which that route takes.
									sheet={
										sheet
											? {
													href: meetingRoleSheetHref(meetingUuid, sheet),
													title: sheet.title,
												}
											: null
									}
									open={guideOpen}
									showDescriptionFallback
								/>
							</div>
						);
					})}
				</section>
			) : null}

			{/* No `max-h` / `overflow-*` on DialogContent — the primitive owns the
			    height, and a call-site override silently removes its scroller. */}
			<Dialog open={confirmRelease} onOpenChange={setConfirmRelease}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{canRelease && holdsRole
								? "Give up your role?"
								: "Tell us you can't make it?"}
						</DialogTitle>
						<DialogDescription>
							{canRelease
								? holdsRole
									? `You're ${listRoles(view.roles.map((r) => r.roleName))} for ${when}. Telling us you can't make it frees the role up for someone else, and we can't put it back automatically.`
									: `We'll let the team know you can't make the ${when} meeting. If any role has been assigned to you since this page loaded, it will be freed up too.`
								: holdsRole
									? `You're ${listRoles(view.roles.map((r) => r.roleName))} for ${when}. We'll let the team know you can't make it and an officer will find cover — your role stays yours until they do.`
									: `We'll let the team know you can't make the ${when} meeting.`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							className="min-h-11"
							disabled={busy}
							onClick={() => setConfirmRelease(false)}
						>
							{canRelease && holdsRole ? "Keep my role" : "Cancel"}
						</Button>
						<Button
							variant="destructive"
							className="min-h-11"
							disabled={busy}
							aria-busy={pending === "release"}
							onClick={() => void sendAnswer(false)}
						>
							{canRelease && holdsRole
								? "Release & mark me away"
								: "Yes, I can't make it"}
							{pending === "release" ? <SavingIndicator /> : null}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * One duty row. `min-h-11` + the padding is the whole point: these were bare
 * `text-sm` links at roughly a 20px target, and they are the navigation into
 * the editors where the duty actually gets done. The negative margin lets the
 * target reach the card's padding edge without the label moving.
 */
const DUTY_ROW =
	"-mx-2 flex min-h-11 items-center gap-2 rounded-md px-2 py-2 text-sm text-primary hover:underline";

/**
 * The in-button pending state (`assign-slot-sheet.tsx`'s text-plus-spinner
 * shape, not the label-replacing one) — `disabled` alone only fades both
 * buttons, telling the member neither that anything is happening nor which
 * answer they tapped. The label is KEPT so the button holds its accessible
 * name while it is busy; the sr-only text is what carries "working" to a
 * screen reader, since the spinner is decorative.
 */
function SavingIndicator() {
	return (
		<>
			<Loader2 aria-hidden className="size-4 animate-spin" />
			<span className="sr-only">Saving…</span>
		</>
	);
}

/**
 * The page container and its one navigation affordance.
 *
 * The link is FORWARD, and it used to be a `BackLink`. That component
 * hard-codes an `ArrowLeft` and is documented as the "Back to …" pattern for
 * the in-chrome standalone pages; arrival here is a chat link, so there is no
 * history behind the arrow and the most prominent thing above the h1 pointed
 * away from the decision the page exists to collect. A plain forward link
 * under the content says the same thing without either problem.
 */
export function PersonalMeetingShell({
	clubId,
	meetingId,
	children,
}: {
	clubId: string;
	meetingId: string;
	children: ReactNode;
}) {
	return (
		<div className="mx-auto w-full max-w-reading space-y-4 p-4 pb-10">
			{children}
			<div className="border-t border-[var(--line)] pt-3">
				<FullMeetingLink clubId={clubId} meetingId={meetingId} />
			</div>
		</div>
	);
}

export function FullMeetingLink({
	clubId,
	meetingId,
}: {
	clubId: string;
	meetingId: string;
}) {
	return (
		<Link
			to="/club/$clubId/meeting/$meetingId"
			params={{ clubId, meetingId }}
			className="-mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary"
		>
			See the full meeting page
			<ArrowRight aria-hidden className="size-4" />
		</Link>
	);
}

/**
 * The `$meetingId` URL segment rendered as something a member can read, or
 * `null` when it is not a date key.
 *
 * The four non-happy states know the segment and nothing else — the club name
 * and the meeting date live behind the query that has not answered (or has
 * failed) — so this is the only meeting context those states can honestly
 * offer, and without it a failed load never tells the member which meeting
 * they landed on.
 *
 * Parsed as a LOCAL calendar date (`new Date(y, m - 1, d)`), never
 * `new Date("2026-09-05")`: the string form is UTC midnight, so a viewer west
 * of Greenwich would be shown the day BEFORE the one in their own URL. The
 * round-trip check rejects the overflow `Date` silently accepts — "2026-13-40"
 * matches the shape and would otherwise print a real-looking wrong date.
 *
 * Accepts the date-HHmm collision form (`meetingUrlKey`'s second shape) and
 * drops the time, because the time we would print here is the URL's, not the
 * meeting's, and the two agree only by construction.
 */
export function formatMeetingKeyLabel(key: string): string | null {
	// `parseMeetingKey` is the classifier, and re-deriving it here was a second
	// implementation that already DISAGREED with it: `(?:-\d{4})?` accepts any
	// four digits, so `2026-09-05-2599` parsed here and is rejected there — and
	// `meeting-url.ts` names that exact case in its own comment, because 25:99
	// gets rolled into the next day rather than refused. It also rejects
	// impossible calendar dates (`2026-09-31` rolls to October) and knows about
	// the uuid form. One implementation, so the label cannot say yes to a key the
	// router says no to.
	const parsed = parseMeetingKey(key.trim());
	if (parsed.kind !== "date" && parsed.kind !== "instant") return null;
	// No `timeZone`: `local` is BUILT in the runtime's zone, so formatting it
	// there is what round-trips the calendar date the URL names.
	const local = new Date(
		Number(parsed.date.slice(0, 4)),
		Number(parsed.date.slice(5, 7)) - 1,
		Number(parsed.date.slice(8, 10)),
	);
	return formatMeetingDate(local);
}

/**
 * A page state that is not the page. `title` is REQUIRED and is a heading —
 * all four of these states used to be a bare grey `<p>`, so the surface had no
 * heading at all unless the happy path rendered.
 *
 * THREE of the four route through here: no-identity, error and not-found.
 * Loading does not, deliberately — `PersonalMeetingLoading` follows the centred
 * `Loader2` convention the issue itself cited (`ballot.tsx:66`), and a heading
 * announced for a state that exists for a few hundred milliseconds is noise to a
 * screen reader rather than structure. It still carries the other half of the
 * finding, which is the half that mattered: it NAMES the meeting, so a member on
 * a slow connection is not looking at a page whose entire content is the word
 * "Loading…".
 */
export function PersonalMeetingNotice({
	title,
	meetingKey,
	children,
}: {
	title: string;
	/** The raw `$meetingId` segment; rendered only when it reads as a date. */
	meetingKey: string;
	children: ReactNode;
}) {
	const label = formatMeetingKeyLabel(meetingKey);
	return (
		<section className="space-y-1">
			{label ? <p className={EYEBROW}>{label}</p> : null}
			<h1 className="font-display text-2xl font-semibold tracking-tight">
				{title}
			</h1>
			<p className="text-muted-foreground text-sm">{children}</p>
		</section>
	);
}

/**
 * The repo's loading convention (`ballot.tsx`: a centred `Loader2`), plus the
 * meeting it is loading — the finding was that a member on a slow connection
 * saw a page whose entire content was the word "Loading…".
 */
export function PersonalMeetingLoading({ meetingKey }: { meetingKey: string }) {
	const label = formatMeetingKeyLabel(meetingKey);
	return (
		<div className="flex flex-col items-center gap-3 py-10 text-center">
			<Loader2
				aria-hidden
				className="size-6 animate-spin text-muted-foreground"
			/>
			<p className="text-muted-foreground text-sm">
				{label ? `Loading your ${label} meeting…` : "Loading your meeting…"}
			</p>
		</div>
	);
}

/** The stored rung, in the member's own words. `reached_out` never reaches the
 *  client — the seam collapses it — so there is no arm for it here. */
export function AnswerState({
	status,
	writesClosed,
	canChange = true,
}: {
	status: PersonalMeetingView["planStatus"];
	/** Past tense and no call to action once nothing can be changed. */
	writesClosed: boolean;
	/** False for an asserted viewer who has already answered (#762): the window
	 *  is open, but changing an answer needs a session, so "Tap below" would
	 *  point at buttons that are no longer there. Defaults true — the
	 *  `writesClosed` half already carried the only other reason to drop it. */
	canChange?: boolean;
}) {
	// ONE flag for both reasons the call to action must go. They differ in COPY
	// (past tense vs present) and the caller owns that distinction; what they
	// share is that there is nothing below to tap.
	const offerChange = !writesClosed && canChange;
	if (status === "coming") {
		return (
			<p className="flex items-center gap-2 text-sm">
				<CheckCircle2 aria-hidden className="size-4 shrink-0" />
				{writesClosed
					? "You said you were coming."
					: offerChange
						? "You've said you're coming. Changed your mind? Tap below."
						: "You've said you're coming."}
			</p>
		);
	}
	if (status === "not_coming") {
		return (
			<p className="flex items-center gap-2 text-sm">
				<XCircle aria-hidden className="size-4 shrink-0" />
				{writesClosed
					? "You said you couldn't make it."
					: offerChange
						? "You've said you can't make it. Changed your mind? Tap below."
						: "You've said you can't make it."}
			</p>
		);
	}
	return null;
}
