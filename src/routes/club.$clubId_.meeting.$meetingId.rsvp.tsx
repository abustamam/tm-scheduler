import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import {
	CalendarPlus,
	ExternalLink,
	Loader2,
	MapPin,
	Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "#/components/brand-mark";
import { CancelledMeetingNotice } from "#/components/club/cancelled-meeting-notice";
import { CoverSheet } from "#/components/club/cover-sheet";
import { PickNameForm } from "#/components/club/pick-name-form";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { showWriteError } from "#/components/write-error-toast";
import { authClient } from "#/lib/auth-client";
import {
	attendanceCalendarEvent,
	googleCalendarUrl,
	icsFilename,
	toDate,
	toIcs,
} from "#/lib/calendar";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { utcToZonedWallTime } from "#/lib/datetime";
import { rsvpPageUrl } from "#/lib/lineup-blast";
import { mapLink } from "#/lib/map-link";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { isMeetingOver } from "#/lib/meeting-lifecycle";
import { type StoredMember, useCurrentMember } from "#/lib/member-identity";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { promoDate, promoMeetingPath, promoTime } from "#/lib/promo-template";
import { NOINDEX, shareMeta } from "#/lib/share-meta";
import { setPlannedAttendance } from "#/server/attendance-plan";
import type { submitGuestRsvp } from "#/server/guest-rsvp";
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
				lengthMinutes: detail.meeting.lengthMinutes,
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
 * way (`useSessionVoter`): read-only, only asked once `useSession` reports a
 * user, and a failed lookup or a timeout means "no session member".
 *
 * The FIRST answer is final for this page view. `useSession` can drop and come
 * back on a mounted page, and a late or retried success must not swap the
 * identity under someone who has since picked their name.
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

	const [decided, setDecided] = useState<{ member: StoredMember | null }>();
	const live: { member: StoredMember | null } | undefined = isPending
		? undefined
		: userId === null
			? { member: null }
			: resolved.isPending
				? undefined
				: {
						member: resolved.data
							? { id: resolved.data.id, name: resolved.data.name }
							: null,
					};
	// Set during render: React re-renders at once with the latched value and
	// never commits the intermediate output.
	if (decided === undefined && live !== undefined) setDecided(live);

	const undecided = decided === undefined;
	useEffect(() => {
		if (!undecided) return;
		const timer = setTimeout(
			() => setDecided((d) => d ?? { member: null }),
			SESSION_TIMEOUT_MS,
		);
		return () => clearTimeout(timer);
	}, [undecided]);

	return decided === undefined
		? { pending: true, member: null }
		: { pending: false, member: decided.member };
}

function RsvpPage() {
	const { clubId, clubName, timezone, meeting } = Route.useLoaderData();
	const { clubId: clubKey, meetingId: meetingKey } = Route.useParams();
	const session = useSessionMember(meeting.id);
	const { member: picked, setMember, clearMember } = useCurrentMember(clubKey);
	const member = session.member ?? picked;
	const signedIn = session.member !== null;
	const queryClient = useQueryClient();
	// "I'm a guest" (#1444): a visitor who is not on the roster. Needs no session.
	const [guestMode, setGuestMode] = useState(false);

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
				) : guestMode ? (
					<GuestRsvp
						clubUuid={clubId}
						clubName={clubName}
						clubKey={clubKey}
						meetingKey={meetingKey}
						meeting={meeting}
						timezone={timezone}
						onBack={() => setGuestMode(false)}
					/>
				) : (
					<div className="space-y-3">
						<h2 className="text-base font-semibold">Who are you?</h2>
						<Button
							variant="outline"
							className="min-h-11 w-full"
							onClick={() => setGuestMode(true)}
						>
							I'm a guest
						</Button>
						<p className="text-xs text-muted-foreground">
							Or find your name, if you're a member:
						</p>
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
	const queryKey = useMemo(
		() => ["rsvp-view", clubUuid, meetingKey, member.id],
		[clubUuid, meetingKey, member.id],
	);
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
		await queryClient.invalidateQueries({ queryKey });
	}, [queryClient, queryKey]);

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
						search={{ redirect: rsvpPageUrl(meetingPath) }}
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
					className="min-h-11 text-xs text-muted-foreground"
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

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh retry key per form view: a resend of the SAME submit reuses it, so a
 *  double tap or a flaky network cannot create two RSVPs. */
function newClientKey(): string {
	const key = crypto.randomUUID();
	return UUID_RE.test(key) ? key : "00000000-0000-4000-8000-000000000000";
}

type GuestConfirmation = NonNullable<
	Awaited<ReturnType<typeof submitGuestRsvp>>["confirmation"]
>;

/** "Thursday" / "Thursday, Nov 12", in the club's timezone. */
function dayLabels(scheduledAt: Date | string, timeZone: string) {
	const at = toDate(scheduledAt);
	const weekday = new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		timeZone,
	}).format(at);
	const monthDay = new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone,
	}).format(at);
	return { weekday, dateLabel: `${weekday}, ${monthDay}` };
}

function GuestRsvp({
	clubUuid,
	clubName,
	clubKey,
	meetingKey,
	meeting,
	timezone,
	onBack,
}: {
	clubUuid: string;
	clubName: string;
	clubKey: string;
	meetingKey: string;
	meeting: { id: string; scheduledAt: Date | string; lengthMinutes?: number };
	timezone: string;
	onBack: () => void;
}) {
	const [confirmation, setConfirmation] = useState<{
		firstName: string;
		data: GuestConfirmation;
	} | null>(null);
	if (confirmation) {
		return (
			<GuestConfirmationView
				firstName={confirmation.firstName}
				data={confirmation.data}
				clubName={clubName}
				clubKey={clubKey}
				meetingKey={meetingKey}
				meeting={meeting}
				timezone={timezone}
			/>
		);
	}
	return (
		<GuestRsvpForm
			clubUuid={clubUuid}
			meetingId={meeting.id}
			onBack={onBack}
			onConfirmed={(firstName, data) => setConfirmation({ firstName, data })}
		/>
	);
}

function GuestRsvpForm({
	clubUuid,
	meetingId,
	onBack,
	onConfirmed,
}: {
	clubUuid: string;
	meetingId: string;
	onBack: () => void;
	onConfirmed: (firstName: string, data: GuestConfirmation) => void;
}) {
	const [firstName, setFirstName] = useState("");
	const [contact, setContact] = useState("");
	// The honeypot: a real person never sees or fills it.
	const [website, setWebsite] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Measured HERE, on the client, from when the form opened: the server only
	// compares a number, never two clocks.
	const openedAt = useRef(Date.now());
	const clientKey = useRef(newClientKey());

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy) return;
		const name = firstName.trim();
		if (!name) {
			setError("Please enter your first name.");
			return;
		}
		const trimmed = contact.trim();
		const isEmail = trimmed.includes("@");
		setBusy(true);
		setError(null);
		try {
			// Loaded on submit, like the ballot's session lookup above: the server
			// fn pulls `#/db` in at import, and nothing renders it until a tap.
			const { submitGuestRsvp } = await import("#/server/guest-rsvp");
			const result = await submitGuestRsvp({
				data: {
					clubId: clubUuid,
					meetingId,
					clientKey: clientKey.current,
					firstName: name,
					email: isEmail ? trimmed : "",
					phone: !isEmail ? trimmed : "",
					website,
					fillMs: Date.now() - openedAt.current,
				},
			});
			if (!result.confirmation) {
				// A bot's answer is success-shaped with nothing written; so is a very
				// quick real one. Never claim a RSVP that was not recorded.
				openedAt.current = Date.now();
				setError("That went through too fast to save. Please try again.");
				return;
			}
			onConfirmed(name, result.confirmation);
		} catch (err) {
			setError(
				err instanceof Error && err.message
					? err.message
					: "Couldn't save your RSVP. Please try again.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
			<div className="space-y-1.5">
				<Label htmlFor="guest-first-name">First name</Label>
				<Input
					id="guest-first-name"
					name="firstName"
					autoComplete="given-name"
					required
					maxLength={80}
					value={firstName}
					onChange={(e) => setFirstName(e.target.value)}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="guest-contact">Email or phone (optional)</Label>
				<Input
					id="guest-contact"
					name="contact"
					autoComplete="email"
					maxLength={200}
					value={contact}
					onChange={(e) => setContact(e.target.value)}
				/>
				<p className="text-xs text-muted-foreground">
					So the club can reach you if plans change.
				</p>
			</div>
			{/* Honeypot. Off-screen rather than display:none, which some bots skip. */}
			<div
				aria-hidden
				className="absolute -left-[9999px] h-0 w-0 overflow-hidden"
			>
				<label htmlFor="guest-website">Website</label>
				<input
					id="guest-website"
					name="website"
					tabIndex={-1}
					autoComplete="off"
					value={website}
					onChange={(e) => setWebsite(e.target.value)}
				/>
			</div>
			{error ? (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			) : null}
			<Button type="submit" className="min-h-11 w-full" disabled={busy}>
				{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
				I'm coming
			</Button>
			<Button
				type="button"
				variant="ghost"
				className="min-h-11 text-xs text-muted-foreground"
				onClick={onBack}
			>
				Back
			</Button>
		</form>
	);
}

const WHAT_HAPPENS = [
	"Short prepared speeches, a round of impromptu Table Topics, and kind, specific feedback.",
	"You're welcome to just watch. Joining in is always your choice.",
	"Come a few minutes early and a member will say hello.",
] as const;

function GuestConfirmationView({
	firstName,
	data,
	clubName,
	clubKey,
	meetingKey,
	meeting,
	timezone,
}: {
	firstName: string;
	data: GuestConfirmation;
	clubName: string;
	clubKey: string;
	meetingKey: string;
	meeting: { id: string; scheduledAt: Date | string; lengthMinutes?: number };
	timezone: string;
}) {
	const { weekday, dateLabel } = dayLabels(data.scheduledAt, timezone);
	const map = mapLink(data.location);
	const lengthMinutes = meeting.lengthMinutes ?? 90;
	// Re-checked at render, the meeting page's rule: only an http(s) URL is an href.
	const joinUrl = normalizePresentationUrl(data.joinUrl);
	// Built at click time: `window` does not exist during SSR.
	const build = () =>
		attendanceCalendarEvent({
			clubName,
			dateLabel,
			scheduledAt: data.scheduledAt,
			lengthMinutes,
			meetingUrl: `${window.location.origin}${promoMeetingPath(clubKey, meetingKey)}`,
			uid: `${meeting.id}-${data.rsvpId}@gavelup`,
		});
	const downloadIcs = () => {
		const localDate = utcToZonedWallTime(
			toDate(data.scheduledAt),
			timezone,
		).slice(0, 10);
		const blob = new Blob([toIcs(build())], {
			type: "text/calendar;charset=utf-8",
		});
		const href = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = href;
		a.download = icsFilename(clubName, localDate, "meeting");
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(href), 0);
	};

	return (
		<div className="space-y-5">
			<div className="space-y-1">
				<h2 className="font-display text-xl font-semibold tracking-tight">
					See you {weekday}, {firstName}!
				</h2>
				<p className="text-sm text-muted-foreground">
					{data.toastmasterFirstName
						? `${data.toastmasterFirstName} is Toastmaster tonight. The club knows you're coming.`
						: "The club knows you're coming."}
				</p>
			</div>
			{data.location ? (
				<p className="flex items-start gap-1.5 text-sm">
					<MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span className="min-w-0 break-words">
						{data.location}
						{map ? (
							<>
								{" "}
								<a
									href={map}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-2"
								>
									Open in maps
									<ExternalLink className="size-3" aria-hidden />
								</a>
							</>
						) : null}
					</span>
				</p>
			) : null}
			{joinUrl ? (
				<a
					href={joinUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary underline-offset-4 hover:underline"
				>
					<Video className="size-4" aria-hidden />
					Join the video call
				</a>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" className="min-h-11 w-full">
						<CalendarPlus aria-hidden className="size-4" />
						Add to calendar
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem className="min-h-11" onSelect={downloadIcs}>
						Apple / Outlook (.ics)
					</DropdownMenuItem>
					<DropdownMenuItem
						className="min-h-11"
						onSelect={() =>
							window.open(
								googleCalendarUrl(build()),
								"_blank",
								"noopener,noreferrer",
							)
						}
					>
						Google Calendar
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<div className="space-y-1.5">
				<h3 className="text-sm font-semibold">What happens at a meeting</h3>
				<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
					{WHAT_HAPPENS.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			</div>
		</div>
	);
}
