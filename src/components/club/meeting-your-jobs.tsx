// The "Your jobs" card on the meeting page (#1376).
//
// The personal meeting page (`/me`, #665) was reachable only through an
// officer's nudge. This card puts the same duties on the page members already
// open. It reads the SAME query as `/me` (same key, same server fn), so the two
// share a cache, and it adds no server surface: only fields
// `getPublicPersonalMeetingView` already returns to any holder of a member id.
// No attendance, no `reached_out`, no contact details.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle } from "lucide-react";
import { type DutyTarget, dutiesForRole } from "#/lib/role-duties";
import { getPublicPersonalMeetingView } from "#/server/personal-meeting";
import { buildDutyContext } from "./duty-context";

const DUTY_ROW =
	"-mx-2 flex min-h-11 items-center gap-2 rounded-md px-2 py-2 text-sm text-primary hover:underline";

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
	});

	// No identity, pending, error, rejected member: no card. The card is
	// secondary to the agenda and must never break it.
	const view = query.data;
	if (!memberId || !view) return null;
	if (view.meeting.status === "cancelled") return null;
	if (view.roles.length === 0) return null;

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
						<h3 className="font-medium text-sm text-foreground">
							{role.roleName}
						</h3>
						{duties.length > 0 ? (
							<ul className="mt-1 space-y-1">
								{duties.map((duty) => {
									const done = duty.done(ctx);
									const content = (
										<>
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
											<span className="sr-only">
												{done ? "Done: " : "To do: "}
											</span>
										</>
									);
									const labelClass = done
										? "text-muted-foreground line-through"
										: "";
									if (duty.id === "speech_details") {
										if (source === "anon") {
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
