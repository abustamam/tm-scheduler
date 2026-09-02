// src/components/club/personal-meeting-body.tsx
//
// The body of the personal meeting page (#665) — everything below the route's
// identity/loading/not-found branching.
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

import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { useCallback, useState } from "react";
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
import { formatMeetingDate } from "#/lib/format";
import { listRoles } from "#/lib/list-roles";
import { isMeetingLocked, isMeetingOver } from "#/lib/meeting-lifecycle";
import {
	type DutyTarget,
	dutiesForRole,
	ROLE_CONFIRM_PROMPT,
} from "#/lib/role-duties";
import { setPlannedAttendance } from "#/server/attendance-plan";
import { markUnavailableReleasing } from "#/server/availability";
import type { PersonalMeetingView } from "#/server/personal-meeting";

export function PersonalMeetingBody({
	view,
	clubId,
	meetingId,
	onChanged,
	onNotYou,
	canRepick,
}: {
	view: PersonalMeetingView;
	clubId: string;
	meetingId: string;
	onChanged: () => Promise<void>;
	onNotYou: () => void;
	/** False for a signed-in member, whose identity is the session and cannot be
	 *  re-picked from here. */
	canRepick: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [confirmRelease, setConfirmRelease] = useState(false);
	const when = formatMeetingDate(view.meeting.scheduledAt, view.club.timezone);
	const holdsRole = view.roles.length > 0;

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
	const writesClosed =
		cancelled ||
		isMeetingOver({
			status: view.meeting.status,
			scheduledAt: view.meeting.scheduledAt,
			timezone: view.club.timezone,
		});

	// `view.meeting.id`, never the `meetingId` URL segment — the segment is a
	// club-local date key and both writers validate a uuid.
	const meetingUuid = view.meeting.id;

	const sendAnswer = useCallback(
		async (coming: boolean) => {
			setBusy(true);
			try {
				if (coming) {
					await setPlannedAttendance({
						data: {
							memberId: view.member.id,
							meetingId: meetingUuid,
							status: "coming",
						},
					});
					toast.success("Great — see you there.");
				} else {
					// Unconditional — see rule 1 in the header.
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
				}
				// Closed BEFORE the refetch is awaited: the write has landed and the
				// toast has fired, so leaving the dialog up and the buttons disabled
				// for a second full round trip reads as still-working on a phone.
				setConfirmRelease(false);
				setBusy(false);
				await onChanged();
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : "Couldn't save that answer.",
				);
				// Deliberately NOT closing the dialog here: a failed release must stay
				// open to retry rather than dismissing itself behind a toast.
				setBusy(false);
			}
		},
		[meetingUuid, onChanged, view.club.id, view.member.id],
	);

	// ALWAYS confirms — see rule 2 in the header. `holdsRole` picks the copy, and
	// nothing else, because it is read from a cached query.
	const answerNo = useCallback(() => setConfirmRelease(true), []);

	const target: DutyTarget = { clubId, meetingId };

	return (
		<>
			<header className="space-y-1">
				<p className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.04em]">
					{view.club.name}
				</p>
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					{holdsRole
						? `You're our ${listRoles(view.roles.map((r) => r.roleName))} for ${when}`
						: `Coming to the ${when} meeting?`}
				</h1>
				<p className="text-muted-foreground text-sm">
					Hi {view.member.name}.
					{canRepick ? (
						<>
							{" "}
							{/* A link can be forwarded, so the person reading it is not
							    always the person it names. Without this the identity is
							    changed by a URL with no way to correct it from the page. */}
							<button
								type="button"
								onClick={onNotYou}
								className="underline underline-offset-2 hover:text-foreground"
							>
								Not you?
							</button>
						</>
					) : null}
				</p>
			</header>

			{/* Passed `writesClosed` so a stored answer never reads "Tap below" with
			    nothing below it — the normal end state of every link that outlived
			    its meeting in a chat thread. */}
			<AnswerState status={view.planStatus} writesClosed={writesClosed} />

			{writesClosed ? (
				<p className="rounded-md border border-[var(--line)] p-3 text-muted-foreground text-sm">
					{cancelled
						? "This meeting was cancelled."
						: locked
							? "This meeting is finished, so answers are closed."
							: "This meeting has passed, so answers are closed."}
				</p>
			) : (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<Button
						size="lg"
						disabled={busy}
						onClick={() => void sendAnswer(true)}
					>
						{holdsRole ? "I'll be there" : "Yes, I'm coming"}
					</Button>
					<Button
						size="lg"
						variant="outline"
						disabled={busy}
						onClick={answerNo}
					>
						{holdsRole ? "Can't make it" : "No, I can't"}
					</Button>
				</div>
			)}

			{holdsRole ? (
				<section className="space-y-4">
					{view.roles.map((role) => {
						const duties = dutiesForRole({
							roleName: role.roleName,
							roleKey: role.roleKey,
						});
						return (
							<div
								key={role.slotId}
								className="rounded-lg border border-[var(--line)] p-3"
							>
								<p className="font-medium text-sm">{role.roleName}</p>
								<ul className="mt-2 space-y-2">
									{duties.length > 0 ? (
										duties.map((duty) => {
											const done = duty.done({
												theme: view.meeting.theme,
												wordOfTheDay: view.meeting.wordOfTheDay,
												// Per-SLOT, never per-member: a member can hold two
												// speaker slots and one title must not tick both.
												speechTitle: role.speechTitle,
											});
											return (
												<li key={duty.id}>
													<Link
														to={duty.href(target)}
														className="flex items-start gap-2 text-sm text-primary hover:underline"
													>
														{done ? (
															<CheckCircle2
																aria-hidden
																className="mt-0.5 size-4 shrink-0 text-success"
															/>
														) : (
															<Circle
																aria-hidden
																className="mt-0.5 size-4 shrink-0 text-muted-foreground"
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
									) : (
										// A role that owns nothing recordable gets the prompt, not an
										// always-unticked box — see ROLE_CONFIRM_PROMPT's docblock.
										<li>
											<Link
												to={ROLE_CONFIRM_PROMPT.href(target)}
												className="flex items-start gap-2 text-sm text-primary hover:underline"
											>
												<Circle
													aria-hidden
													className="mt-0.5 size-4 shrink-0 text-muted-foreground"
												/>
												<span>{ROLE_CONFIRM_PROMPT.label}</span>
											</Link>
										</li>
									)}
								</ul>
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
							{holdsRole ? "Give up your role?" : "Tell us you can't make it?"}
						</DialogTitle>
						<DialogDescription>
							{holdsRole
								? `You're ${listRoles(view.roles.map((r) => r.roleName))} for ${when}. Telling us you can't make it frees the role up for someone else, and we can't put it back automatically.`
								: `We'll let the team know you can't make the ${when} meeting. If any role has been assigned to you since this page loaded, it will be freed up too.`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setConfirmRelease(false)}
						>
							{holdsRole ? "Keep my role" : "Cancel"}
						</Button>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() => void sendAnswer(false)}
						>
							{holdsRole ? "Release & mark me away" : "Yes, I can't make it"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** The stored rung, in the member's own words. `reached_out` never reaches the
 *  client — the seam collapses it — so there is no arm for it here. */
export function AnswerState({
	status,
	writesClosed,
}: {
	status: PersonalMeetingView["planStatus"];
	/** Past tense and no call to action once nothing can be changed. */
	writesClosed: boolean;
}) {
	if (status === "coming") {
		return (
			<p className="flex items-center gap-2 text-sm">
				<CheckCircle2 aria-hidden className="size-4 shrink-0" />
				{writesClosed
					? "You said you were coming."
					: "You've said you're coming. Changed your mind? Tap below."}
			</p>
		);
	}
	if (status === "not_coming") {
		return (
			<p className="flex items-center gap-2 text-sm">
				<XCircle aria-hidden className="size-4 shrink-0" />
				{writesClosed
					? "You said you couldn't make it."
					: "You've said you can't make it. Changed your mind? Tap below."}
			</p>
		);
	}
	return null;
}
