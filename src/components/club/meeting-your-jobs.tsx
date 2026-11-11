// The "Your jobs" card on the meeting page (#1376).
//
// The personal meeting page (`/me`, #665) was reachable only through an
// officer's nudge. This card puts the same duties on the page members already
// open. It reads the SAME query as `/me` (same key, same server fn), so the two
// share a cache, and it adds no server surface: only fields
// `getPublicPersonalMeetingView` already returns to any holder of a member id.
// No attendance, no `reached_out`, no contact details.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { showWriteError } from "#/components/write-error-toast";
import { isMeetingOver } from "#/lib/meeting-lifecycle";
import { type DutyTarget, dutiesForRole } from "#/lib/role-duties";
import { getPublicPersonalMeetingView } from "#/server/personal-meeting";
import { confirmSlot } from "#/server/slots";
import { RoleCalendarButton } from "./add-to-calendar-button";
import { buildDutyContext } from "./duty-context";
import { DUTY_ROW, DutyMark, dutyLabelClass } from "./duty-row";

export function MeetingYourJobs({
	clubId,
	clubUuid,
	meetingKey,
	memberId,
	source,
}: {
	/** The club's URL segment, for the duty `href`s. */
	clubId: string;
	clubUuid: string;
	/** The raw `$meetingId` URL segment. */
	meetingKey: string;
	/** The page's resolved identity (session member, else the stored pick). */
	memberId: string | null;
	source: "session" | "anon";
}) {
	const query = useQuery({
		// Same key shape as `/me`, so the two share a cache entry.
		queryKey: ["personal-meeting", clubUuid, meetingKey, memberId],
		queryFn: () =>
			getPublicPersonalMeetingView({
				data: { clubId: clubUuid, meetingKey, memberId: memberId as string },
			}),
		enabled: Boolean(memberId),
		// `/me` and its editors invalidate `["personal-meeting", clubUuid,
		// <their raw $meetingId param>]`, which is not always this key's third
		// segment (a date key here, the uuid there). Rather than depend on the
		// two matching, an edit made over there is picked up when this card
		// mounts again: it always revalidates, and shows the cached view meanwhile.
		refetchOnMount: "always",
	});

	const queryClient = useQueryClient();
	const router = useRouter();
	// Confirm buttons share one in-flight flag (#1612): one request per double
	// tap. A ref guards the tap itself; the state only drives `disabled`.
	const inFlight = useRef(false);
	const [confirming, setConfirming] = useState<string | null>(null);

	async function confirmRole(slotId: string, roleName: string) {
		if (inFlight.current || !memberId) return;
		inFlight.current = true;
		setConfirming(slotId);
		try {
			await confirmSlot({ data: { slotId, memberId } });
			toast.success(`Confirmed as ${roleName}.`);
		} catch (err) {
			showWriteError(err, "Couldn't confirm that role.");
		} finally {
			// Success or stale slot (released, reassigned, confirmed by an
			// officer): refetch either way so the button reflects the truth.
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["personal-meeting"] }),
				router.invalidate(),
			]).catch(() => undefined);
			inFlight.current = false;
			setConfirming(null);
		}
	}

	// No identity, pending, error, rejected member: no card. The card is
	// secondary to the agenda and must never break it.
	const view = query.data;
	if (!memberId || !view) return null;
	if (view.meeting.status === "cancelled") return null;
	if (view.roles.length === 0) return null;

	// Same "answers are open" rule as `/me`: never offer Confirm on a closed
	// meeting or over the member's own decline.
	const canConfirm =
		view.planStatus === "coming" &&
		!isMeetingOver({
			status: view.meeting.status,
			scheduledAt: view.meeting.scheduledAt,
			timezone: view.club.timezone,
		});
	const target: DutyTarget = { clubId, meetingId: meetingKey };
	const meetingPath = `/club/${clubId}/meeting/${meetingKey}`;

	return (
		<section
			aria-labelledby="your-jobs-heading"
			className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm"
		>
			<h2
				id="your-jobs-heading"
				className="font-semibold text-base text-foreground"
			>
				Your jobs
			</h2>
			{view.roles.map((role) => {
				const duties = dutiesForRole({
					roleName: role.roleName,
					roleKey: role.roleKey,
				});
				const ctx = buildDutyContext(view, role);
				return (
					<div key={role.slotId}>
						<h3 className="font-semibold text-base text-foreground">
							{role.roleName}
						</h3>
						<p className="text-muted-foreground text-sm">
							{role.status === "confirmed" ? "Confirmed" : "Not confirmed yet"}
						</p>
						{role.status === "claimed" && canConfirm ? (
							<Button
								className="mt-2 min-h-11"
								disabled={confirming !== null}
								aria-busy={confirming === role.slotId}
								onClick={() => void confirmRole(role.slotId, role.roleName)}
							>
								Confirm {role.roleName}
							</Button>
						) : null}
						<div className="mt-2">
							<RoleCalendarButton
								view={view}
								role={role}
								clubId={clubId}
								meetingKey={meetingKey}
							/>
						</div>
						{duties.length > 0 ? (
							<ul className="mt-1 space-y-1">
								{duties.map((duty) => {
									const done = duty.done(ctx);
									const content = <DutyMark done={done} />;
									const labelClass = dutyLabelClass(done);
									if (duty.id === "speech_details") {
										// A done title needs no sign-in: it reads like the session row.
										if (source === "anon" && !done) {
											return (
												<li key={duty.id}>
													<Link
														to="/signin"
														search={{ redirect: meetingPath }}
														className={DUTY_ROW}
													>
														{content}
														<span className={labelClass}>
															Sign in to add your speech details
														</span>
													</Link>
												</li>
											);
										}
										return (
											<li key={duty.id}>
												<a href={`#slot-${role.slotId}`} className={DUTY_ROW}>
													{content}
													<span className={labelClass}>{duty.label}</span>
												</a>
											</li>
										);
									}
									return (
										<li key={duty.id}>
											<Link to={duty.href(target)} className={DUTY_ROW}>
												{content}
												<span className={labelClass}>{duty.label}</span>
											</Link>
										</li>
									);
								})}
							</ul>
						) : null}
					</div>
				);
			})}
			<Link
				to="/club/$clubId/meeting/$meetingId/me"
				params={{ clubId, meetingId: meetingKey }}
				// No `?as=`: `/me` falls back to the same stored pick.
				search={{ as: undefined }}
				className="inline-flex min-h-11 items-center text-primary text-sm hover:underline"
			>
				Open your meeting page
			</Link>
		</section>
	);
}
