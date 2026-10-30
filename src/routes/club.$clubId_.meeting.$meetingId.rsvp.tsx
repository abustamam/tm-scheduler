import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "#/components/brand-mark";
import { CancelledMeetingNotice } from "#/components/club/cancelled-meeting-notice";
import { CoverSheet } from "#/components/club/cover-sheet";
import { PickNameForm } from "#/components/club/pick-name-form";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import { showWriteError } from "#/components/write-error-toast";
import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { isMeetingOver } from "#/lib/meeting-lifecycle";
import { type StoredMember, useCurrentMember } from "#/lib/member-identity";
import { promoDate, promoMeetingPath, promoTime } from "#/lib/promo-template";
import { NOINDEX, shareMeta } from "#/lib/share-meta";
import { setPlannedAttendance } from "#/server/attendance-plan";
import { getPublicMeetingByKey } from "#/server/meetings";
import {
	getPublicPersonalMeetingView,
	type PersonalMeetingView,
} from "#/server/personal-meeting";

// Escapes the `/club/$clubId` shell (trailing `_`), like the ballot and the
// feedback page: this is the page the lineup blast's "Coming Thursday? Tap here"
// link opens, from a group chat, usually signed out (#1442). No pick-your-name
// gate in front of it: the page asks who you are itself, once, and remembers.
//
// Two arms, by the ONE thing that decides what a tap may do, a session:
//  - signed in as a member of this club: both answers are open, "Can't make it"
//    frees every role held and hands the freed roles to the cover sheet (D5);
//  - anything else: a FIRST answer is recorded (ADR-0026's fill-blank rule, which
//    the server enforces), a changed one is refused with a sign-in prompt, and
//    "Can't make it" while holding a role writes NOTHING and points at the
//    meeting page, because freeing a role is destructive and needs a session.
export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/rsvp")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const detail = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		if (detail.meeting.clubId !== club.id) throw notFound();
		return {
			clubId: club.id,
			clubName: club.name,
			timezone: detail.timezone,
			meeting: {
				id: detail.meeting.id,
				status: detail.meeting.status,
				scheduledAt: detail.meeting.scheduledAt,
				theme: detail.meeting.theme,
			},
		};
	},
	component: RsvpPage,
	notFoundComponent: RsvpNotFound,
	head: ({ loaderData }) => {
		const club = loaderData?.clubName ?? "Club";
		return {
			meta: shareMeta({
				title: `Are you coming? — ${club}`,
				description: `Tell ${club} whether you're coming to the meeting.`,
				extra: [NOINDEX],
			}),
		};
	},
});

function RsvpNotFound() {
	const { clubId } = Route.useParams();
	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<MeetingNotFound clubId={clubId} />
		</div>
	);
}

/** How long the page waits for the session before it behaves as signed out. */
const SESSION_TIMEOUT_MS = 3000;

/**
 * The signed-in member of this club, resolved on the CLIENT, the vote page's
 * way (`getBallotSessionVoter`): read-only, only asked once `useSession` reports
 * a user, and a failed lookup or a timeout means "no session member".
 */
function useSessionMember(meetingId: string): {
	pending: boolean;
	member: StoredMember | null;
} {
	const { data: session, isPending } = authClient.useSession();
	const userId = session?.user?.id ?? null;
	const resolved = useQuery({
		queryKey: ["ballot-session-voter", meetingId, userId],
		enabled: userId !== null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async () => {
			const { getBallotSessionVoter } = await import(
				"#/server/ballot-session-voter"
			);
			return getBallotSessionVoter({ data: { meetingId } });
		},
	});
	const [timedOut, setTimedOut] = useState(false);
	const waiting = isPending || (userId !== null && resolved.isPending);
	useEffect(() => {
		if (!waiting) return;
		const t = setTimeout(() => setTimedOut(true), SESSION_TIMEOUT_MS);
		return () => clearTimeout(t);
	}, [waiting]);
	if (waiting && !timedOut) return { pending: true, member: null };
	const m = userId !== null ? resolved.data : null;
	return {
		pending: false,
		member: m ? { id: m.id, name: m.name } : null,
	};
}

function RsvpPage() {
	const { clubId, clubName, timezone, meeting } = Route.useLoaderData();
	const { clubId: clubKey, meetingId: meetingKey } = Route.useParams();
	const session = useSessionMember(meeting.id);
	const { member: picked, setMember, clearMember } = useCurrentMember(clubKey);
	const member = session.member ?? picked;
	const signedIn = session.member !== null;
	const queryClient = useQueryClient();

	const when = `${promoDate(meeting.scheduledAt, timezone)}, ${promoTime(meeting.scheduledAt, timezone)}`;
	const cancelled = meeting.status === "cancelled";
	const over = isMeetingOver({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
	});

	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubName}
				</span>
				<ThemeToggle compact />
			</header>
			<main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-10">
				<div className="space-y-1">
					<h1 className="font-display text-2xl font-semibold tracking-tight">
						Are you coming?
					</h1>
					<p className="text-sm text-muted-foreground">{when}</p>
					{meeting.theme ? (
						<p className="text-sm text-muted-foreground">
							Theme: {meeting.theme}
						</p>
					) : null}
				</div>
				{cancelled ? (
					<CancelledMeetingNotice
						clubId={clubKey}
						meetingId={meeting.id}
						detail="There's nothing to answer for a cancelled meeting."
					/>
				) : over ? (
					<p className="text-sm text-muted-foreground">
						This meeting has already happened.{" "}
						<Link
							to="/club/$clubId/meeting/$meetingId"
							params={{ clubId: clubKey, meetingId: meetingKey }}
							className="font-semibold text-primary underline underline-offset-2"
						>
							See the meeting
						</Link>
					</p>
				) : session.pending ? (
					<output className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" aria-hidden />
						Loading…
					</output>
				) : member ? (
					<RsvpAnswer
						key={member.id}
						clubUuid={clubId}
						clubKey={clubKey}
						meetingKey={meetingKey}
						member={member}
						signedIn={signedIn}
						onNotYou={signedIn ? null : clearMember}
						queryClient={queryClient}
					/>
				) : (
					<div className="space-y-3">
						<h2 className="text-base font-semibold">Who are you?</h2>
						<PickNameForm clubUuid={clubId} onPicked={setMember} />
					</div>
				)}
			</main>
			<PublicFooter />
		</div>
	);
}

const STATUS_WORDS = { coming: "Coming", not_coming: "Can't make it" } as const;

function RsvpAnswer({
	clubUuid,
	clubKey,
	meetingKey,
	member,
	signedIn,
	onNotYou,
	queryClient,
}: {
	clubUuid: string;
	clubKey: string;
	meetingKey: string;
	member: StoredMember;
	signedIn: boolean;
	onNotYou: (() => void) | null;
	queryClient: QueryClient;
}) {
	const queryKey = ["rsvp-view", clubUuid, meetingKey, member.id];
	const view = useQuery({
		queryKey,
		queryFn: () =>
			getPublicPersonalMeetingView({
				data: {
					clubId: clubUuid,
					meetingKey,
					memberId: member.id,
				},
			}),
	});
	const refresh = useCallback(async () => {
		await queryClient.invalidateQueries({
			queryKey: ["rsvp-view", clubUuid, meetingKey, member.id],
		});
	}, [queryClient, clubUuid, meetingKey, member.id]);

	if (view.isPending) {
		return (
			<output className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" aria-hidden />
				Loading…
			</output>
		);
	}
	if (view.isError || !view.data) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					{view.isError
						? "We couldn't load this. Nothing has been saved."
						: "We couldn't find you on this club's roster."}
				</p>
				{onNotYou ? (
					<Button
						variant="outline"
						className="min-h-11 w-full"
						onClick={view.isError ? () => void view.refetch() : onNotYou}
					>
						{view.isError ? "Try again" : "Pick your name"}
					</Button>
				) : null}
			</div>
		);
	}
	return (
		<RsvpControls
			view={view.data}
			clubKey={clubKey}
			meetingKey={meetingKey}
			signedIn={signedIn}
			onNotYou={onNotYou}
			onChanged={refresh}
		/>
	);
}

function RsvpControls({
	view,
	clubKey,
	meetingKey,
	signedIn,
	onNotYou,
	onChanged,
}: {
	view: PersonalMeetingView;
	clubKey: string;
	meetingKey: string;
	signedIn: boolean;
	onNotYou: (() => void) | null;
	onChanged: () => Promise<void>;
}) {
	const [pending, setPending] = useState<"coming" | "not_coming" | null>(null);
	// Signed out and holding a role: "Can't make it" was tapped, nothing written.
	const [needsSignIn, setNeedsSignIn] = useState(false);
	const [freed, setFreed] = useState<
		React.ComponentProps<typeof CoverSheet>["slots"]
	>([]);
	const answered = view.planStatus;
	const heldRoles = view.roles.map((r) => r.roleName);
	const meetingPath = promoMeetingPath(clubKey, meetingKey);

	const answer = async (coming: boolean) => {
		if (!coming && !signedIn && view.roles.length > 0) {
			// ADR-0026: freeing a role needs a session, and a not-coming member who
			// still holds one is a contradiction, so write nothing at all.
			setNeedsSignIn(true);
			return;
		}
		setNeedsSignIn(false);
		setPending(coming ? "coming" : "not_coming");
		try {
			if (coming) {
				await setPlannedAttendance({
					data: {
						memberId: view.member.id,
						meetingId: view.meeting.id,
						status: "coming",
						confirmHeldRoles: true,
					},
				});
				toast.success("Great, see you there.");
			} else {
				const { released } = await setPlannedAttendance({
					data: {
						memberId: view.member.id,
						meetingId: view.meeting.id,
						status: "not_coming",
						// Only a session may free roles; the server enforces it too.
						...(signedIn ? { releaseHeldRoles: true } : {}),
					},
				});
				toast.success("Got it, thanks for letting us know.");
				if (released > 0) {
					setFreed(
						view.roles.map((r) => ({
							slotId: r.slotId,
							meetingId: view.meeting.id,
							roleLabel: r.roleName,
							scheduledAt: view.meeting.scheduledAt,
							clubSlug: clubKey,
							urlKey: meetingKey,
							timeZone: view.club.timezone,
						})),
					);
				}
			}
			await onChanged();
		} catch (err) {
			showWriteError(err, "Couldn't save that answer.");
		} finally {
			setPending(null);
		}
	};

	// Answered and not signed in: the answer stands until a session changes it.
	const locked = answered !== null && !signedIn;

	return (
		<div className="space-y-4">
			<p className="text-sm">Hi {view.member.name}.</p>
			{locked ? (
				<div className="space-y-3">
					<p className="text-base font-semibold">
						You said {STATUS_WORDS[answered]}.
					</p>
					<Link
						to="/signin"
						search={{ redirect: `${meetingPath}/rsvp` }}
						className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-2"
					>
						Sign in to change it
					</Link>
				</div>
			) : (
				<div className="space-y-3">
					{answered ? (
						<p className="text-sm text-muted-foreground">
							You said {STATUS_WORDS[answered]}. Tap to change it.
						</p>
					) : null}
					<Button
						className="min-h-11 w-full"
						disabled={pending !== null}
						onClick={() => void answer(true)}
					>
						I'm coming
					</Button>
					<Button
						variant="outline"
						className="min-h-11 w-full"
						disabled={pending !== null}
						onClick={() => void answer(false)}
					>
						Can't make it
					</Button>
					{needsSignIn ? (
						<p className="text-sm">
							<Link
								to="/club/$clubId/meeting/$meetingId"
								params={{ clubId: clubKey, meetingId: meetingKey }}
								className="font-semibold text-primary underline underline-offset-2"
							>
								Sign in to hand off {heldRoles.join(" and ")}
							</Link>
						</p>
					) : null}
				</div>
			)}
			{onNotYou ? (
				<Button
					variant="ghost"
					className="text-xs text-muted-foreground"
					onClick={onNotYou}
				>
					Not {view.member.name}?
				</Button>
			) : null}
			<CoverSheet
				slots={freed}
				mode="released"
				onClose={() => setFreed([])}
				onChanged={onChanged}
			/>
		</div>
	);
}
