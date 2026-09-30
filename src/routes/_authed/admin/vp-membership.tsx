import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
	ChevronDown,
	Link2,
	Loader2,
	MoreHorizontal,
	Pencil,
	Printer,
	Trash2,
	Undo2,
	Unlink,
	UserPlus,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GuestEditDialog } from "#/components/club/guest-edit-dialog";
import { MemberAvatar } from "#/components/club/member-avatar";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
import { showWriteError } from "#/components/write-error-toast";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	formatMeetingDate,
	formatMeetingTime,
	formatShortDate,
} from "#/lib/format";
import {
	convertNoticeDescription,
	isStrandedConvertedGuest,
} from "#/lib/guest-convert";
import { isInvitableStage } from "#/lib/guest-invite";
import { type BroughtCount, guestKindCaption } from "#/lib/guest-profile";
import { mailtoHref } from "#/lib/mailto";
import { cn } from "#/lib/utils";
import { getClubByIdentifier } from "#/server/clubs";
import {
	convertGuestToMember,
	deleteGuest,
	type GuestStage,
	getGuestInviteContext,
	getGuestPipeline,
	getLinkCandidates,
	type LinkCandidate,
	linkGuestToMember,
	type ManualGuestStage,
	type NextMeetingSummary,
	type PipelineGuestRow,
	recordGuestInvite,
	setGuestStage,
	undoGuestConversion,
	unlinkGuestFromMember,
} from "#/server/guest-pipeline";
import { type GuestProfileRow, getGuestProfiles } from "#/server/guests";

export const Route = createFileRoute("/_authed/admin/vp-membership")({
	beforeLoad: ({ context }) => {
		if (!effectiveAdminClub(context)) {
			throw redirect({ to: "/dashboard" });
		}
	},
	loader: async ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) {
			return {
				guests: [],
				clubId: "",
				clubName: "",
				clubSlug: null,
				inviteContext: NO_INVITE_CONTEXT,
				profiles: NO_PROFILES,
				readOnly: false,
			};
		}
		const [guests, resolved, inviteContext, profiles] = await Promise.all([
			getGuestPipeline({ data: club.clubId }),
			getClubByIdentifier({ data: club.clubId }),
			getGuestInviteContext({ data: club.clubId }),
			// Captions and counts are decoration on this page: a failed read
			// degrades to none of them rather than taking the pipeline down.
			getGuestProfiles({ data: club.clubId }).catch(() => NO_PROFILES),
		]);
		return {
			guests,
			profiles,
			clubId: club.clubId,
			clubName: club.name,
			clubSlug: resolved?.slug ?? null,
			inviteContext,
			// A READ-ONLY impersonation passes the admin-view read that loads this
			// page but not the admin write `recordGuestInvite` runs, so its invite
			// links would open a draft and then fail to record (#899).
			readOnly:
				context.impersonating?.mode === "read_only" &&
				context.impersonating.clubId === club.clubId,
		};
	},
	component: VpMembership,
});

const NO_INVITE_CONTEXT: NextMeetingSummary = {
	timezone: "UTC",
	nextMeeting: null,
};

const NO_PROFILES: { rows: GuestProfileRow[]; brought: BroughtCount[] } = {
	rows: [],
	brought: [],
};

const STAGES: { id: GuestStage; label: string; blurb: string; tone: string }[] =
	[
		{
			id: "prospect",
			label: "Prospects",
			blurb: "New visitors — reach out",
			tone: "text-[var(--lagoon-deep)]",
		},
		{
			id: "following_up",
			label: "Following up",
			blurb: "In conversation",
			tone: "text-[var(--sea-ink)]",
		},
		{
			id: "joined",
			label: "Joined",
			blurb: "Became members 🎉",
			tone: "text-[var(--success-strong)]",
		},
		{
			id: "lost",
			label: "Lost",
			blurb: "Not moving forward",
			tone: "text-[var(--sea-ink-soft)]",
		},
	];

const MANUAL_STAGES: { id: ManualGuestStage; label: string }[] = [
	{ id: "prospect", label: "Prospect" },
	{ id: "following_up", label: "Following up" },
	{ id: "lost", label: "Lost" },
];

/** The one error toast every write on this page shows. */
function toastError(err: unknown) {
	toast.error(err instanceof Error ? err.message : "Something went wrong.");
}

function VpMembership() {
	const {
		guests,
		profiles,
		clubId,
		clubName,
		clubSlug,
		inviteContext,
		readOnly,
	} = Route.useLoaderData();
	// Kind / home club / introducer per guest (#1050), keyed for the rows.
	const profileById = new Map(profiles.rows.map((p) => [p.guestId, p]));
	const router = useRouter();
	const [busyId, setBusyId] = useState<string | null>(null);

	// The absolute guest-book URL is derived in the browser so the QR/printed
	// link match the origin the admin is on (dev, preview, or prod). The QR is
	// STABLE — the guest-book route resolves the current meeting itself.
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const guestBookUrl = clubSlug ? `${origin}/club/${clubSlug}/guest-book` : "";
	// The next meeting's PUBLIC agenda, for the invite draft (#899). Built from
	// the slim summary only — never `join_url`, never a personal `?as=` link.
	const next = inviteContext.nextMeeting;
	const inviteShareUrl = next
		? `${origin}/club/${encodeURIComponent(clubSlug ?? clubId)}/meeting/${encodeURIComponent(next.urlKey)}`
		: "";

	/**
	 * Record that this officer opened an invite draft (#899). Fire-and-forget
	 * from the link's `onClick`: the draft has already opened in their own app,
	 * so a failed record must not block it — it only surfaces a toast.
	 */
	function recordInvite(guestId: string, meetingId: string) {
		recordGuestInvite({ data: { clubId, guestId, meetingId } })
			.then(() => router.invalidate())
			.catch((err: unknown) =>
				showWriteError(err, "Couldn't record that invite."),
			);
	}

	async function move(guestId: string, stage: ManualGuestStage) {
		setBusyId(guestId);
		try {
			await setGuestStage({ data: { clubId, guestId, stage } });
			await router.invalidate();
		} catch (err) {
			toastError(err);
		} finally {
			setBusyId(null);
		}
	}

	/**
	 * Convert, from "Joined… → New member", which is its confirmation. Resolves
	 * whether it worked, so the dialog stays open on a refusal (#617 refuses a
	 * guest already on the roster) and the admin can pick the link instead.
	 */
	async function convert(guest: PipelineGuestRow): Promise<boolean> {
		setBusyId(guest.id);
		try {
			const res = await convertGuestToMember({
				data: { clubId, guestId: guest.id },
			});
			// Convert reuses the person's existing membership in this club when
			// there is one, and #501 made it WAKE that row when it had lapsed —
			// otherwise the new member was hidden from the roster, the sign-up
			// sheet, the season grid and every picker, behind this very toast
			// saying it had worked. That wake-up also writes an elevated
			// `club_role` back down, and ends any open officer term the row was
			// still carrying (#805) — both would otherwise hand back club-admin
			// authority. The notice rides the existing success surface rather than
			// a dialog: it is information, not a decision.
			//
			// Composed by `convertNoticeDescription` rather than assembled here,
			// because which sentences apply is a rule with a wrong answer in it —
			// two permission changes can ride one button press and either can be
			// absent. A pure function is the half a unit test can hold.
			//
			// Silent unless the server reported a reactivation, which it does only
			// when the reused row was NOT already active, or a shared roster
			// address (#759), which it reports on a FRESH membership too. Reuse of
			// a live membership is ordinary dedup, and a notice fired on the
			// common path is one admins learn to ignore.
			const description = convertNoticeDescription(res);
			toast.success(
				`${guest.name} is now a member. 🎉`,
				description ? { description } : undefined,
			);
			await router.invalidate();
			return true;
		} catch (err) {
			toastError(err);
			return false;
		} finally {
			setBusyId(null);
		}
	}

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					VP Membership
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Your guest pipeline — capture visitors at the door, follow up, and
					convert prospects into members.
				</p>
			</div>

			{/* Guest-book QR — stable, printable table-tent front door. */}
			<div className="grid gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)] sm:grid-cols-[auto_1fr] sm:items-center">
				<div className="qr-tent flex flex-col items-center gap-3 rounded-xl bg-white p-4 text-center">
					{guestBookUrl ? (
						<QRCodeSVG value={guestBookUrl} size={168} marginSize={0} />
					) : (
						<div className="flex size-[168px] items-center justify-center">
							<Loader2 className="size-6 animate-spin text-[var(--sea-ink-soft)]" />
						</div>
					)}
					<div className="max-w-[200px] text-[13px] font-semibold text-[#173a40]">
						Scan to sign the {clubName} guest book
					</div>
				</div>
				<div className="min-w-0 space-y-3">
					<div>
						<h2 className="text-sm font-bold tracking-[-0.01em]">
							Guest book link
						</h2>
						<p className="text-xs text-[var(--sea-ink-soft)]">
							Print it as a table tent, or share the link. Guests self-register
							and are recorded at the current meeting — no app or login needed.
						</p>
					</div>
					<div className="break-all rounded-lg border border-[var(--line)] bg-[var(--foam)] px-3 py-2 font-mono text-xs text-[var(--sea-ink)]">
						{guestBookUrl || "…"}
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => window.print()}
						disabled={!guestBookUrl}
					>
						<Printer className="size-4" aria-hidden />
						Print sign
					</Button>
				</div>
			</div>

			{/* Pipeline, bucketed by stage. The id is a fragment target: `/tour`'s
			    screenshot capture (#901) links straight to it, and
			    `scroll-mt-24` lands it below the sticky top bar, not under it. */}
			<div id="guest-pipeline" className="scroll-mt-24 space-y-6">
				{STAGES.map((stage) => {
					const inStage = guests.filter((g) => g.stage === stage.id);
					return (
						<Section
							key={stage.id}
							title={stage.label}
							titleTone={stage.tone}
							count={inStage.length}
							subtitle={stage.blurb}
						>
							{inStage.length === 0 ? (
								<EmptyRow>No guests here yet.</EmptyRow>
							) : (
								inStage.map((g) => (
									<GuestRow
										key={g.id}
										guest={g}
										profile={profileById.get(g.id) ?? null}
										clubId={clubId}
										busy={busyId === g.id}
										onMove={move}
										onConvert={convert}
										timezone={inviteContext.timezone}
										invite={{
											clubName,
											readOnly,
											nextMeeting: next,
											shareUrl: inviteShareUrl,
											onRecord: recordInvite,
										}}
									/>
								))
							)}
						</Section>
					);
				})}
			</div>

			<BroughtBySection brought={profiles.brought} />

			{/* Print: show only the QR tent, hide the app chrome + pipeline. */}
			<style>{`
				@media print {
					body * { visibility: hidden !important; }
					.qr-tent, .qr-tent * { visibility: visible !important; }
					.qr-tent {
						position: fixed; inset: 0; margin: auto;
						width: 60vw; height: max-content;
						border: 1px solid #d5e0dc; border-radius: 16px;
					}
					@page { margin: 24px; }
				}
			`}</style>
		</PageContainer>
	);
}

function Section({
	title,
	titleTone,
	subtitle,
	count,
	children,
}: {
	title: string;
	titleTone: string;
	subtitle: string;
	count: number;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="mb-2.5 flex items-baseline justify-between gap-3">
				<div>
					<h2 className={cn("text-sm font-bold tracking-[-0.01em]", titleTone)}>
						{title}{" "}
						<span className="text-[var(--sea-ink-soft)] tabular-nums">
							· {count}
						</span>
					</h2>
					<p className="text-xs text-[var(--sea-ink-soft)]">{subtitle}</p>
				</div>
			</div>
			<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)]">
				{children}
			</div>
		</div>
	);
}

/**
 * "Visitors introduced" (#1050, Easy-Speak's report of the same name): each
 * member who brought a guest, and how many. The counts come from the same rows
 * each guest's "Brought by" line reads (`countBroughtByMember`), so they add up
 * to exactly the guests shown with an introducer.
 */
function BroughtBySection({ brought }: { brought: BroughtCount[] }) {
	const total = brought.reduce((n, b) => n + b.count, 0);
	return (
		<Section
			title="Visitors introduced"
			titleTone="text-[var(--sea-ink)]"
			count={total}
			subtitle="Who brought your guests — set it from a guest's Edit"
		>
			{brought.length === 0 ? (
				<EmptyRow>No introductions recorded yet.</EmptyRow>
			) : (
				<ul data-slot="brought-by-counts">
					{brought.map((b) => (
						<li
							key={b.memberId}
							className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-2.5 text-sm last:border-b-0"
						>
							<span className="min-w-0 truncate font-semibold">{b.name}</span>
							<span className="shrink-0 tabular-nums text-[var(--sea-ink-soft)]">
								{b.count} guest{b.count === 1 ? "" : "s"}
							</span>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

function EmptyRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]">
			{children}
		</p>
	);
}

interface InviteProps {
	clubName: string;
	/** Read-only impersonation: the write would be refused, so offer nothing. */
	readOnly: boolean;
	nextMeeting: NextMeetingSummary["nextMeeting"];
	shareUrl: string;
	onRecord: (guestId: string, meetingId: string) => void;
}

/**
 * "Invited to Thu, Oct 9 · by Sam · invited to 3 meetings" (#899). A row means
 * an officer OPENED a draft; the app cannot see whether it was sent, and says
 * "Invited" on that understanding. A meeting that has since started reads
 * "Last invited to …". An upcoming invite is the state an officer acts on, so
 * the lead renders as a badge; a past one stays muted text.
 */
function inviteHistory(
	guest: Pick<PipelineGuestRow, "lastInvite" | "inviteCount">,
	timezone: string,
	now: Date,
): { upcoming: boolean; lead: string; detail: string } | null {
	const last = guest.lastInvite;
	if (!last) return null;
	const at = new Date(last.meetingAt);
	const date = formatMeetingDate(at, timezone);
	const upcoming = at.getTime() >= now.getTime();
	const lead = upcoming ? `Invited to ${date}` : `Last invited to ${date}`;
	const by = last.invitedByName ? ` · by ${last.invitedByName}` : "";
	const count =
		guest.inviteCount > 1 ? ` · invited to ${guest.inviteCount} meetings` : "";
	return { upcoming, lead, detail: `${by}${count}` };
}

/**
 * The invite control on a Prospects / Following up row (#899): "Invite to
 * {date}" followed by `NudgeButtons`' own WhatsApp / Email drafts. Tapping one
 * opens the officer's own app (the human sends) and records the invite through
 * `onContacted`. Disabled, with the reason visible and as a `title`, when
 * there is no next meeting or no contact — the no-meeting reason wins.
 */
function GuestInvite({
	guest,
	phone,
	email,
	invite,
	timezone,
}: {
	guest: PipelineGuestRow;
	phone: string | null;
	email: string | null;
	invite: InviteProps;
	timezone: string;
}) {
	const next = invite.nextMeeting;
	const meetingDate = next ? formatMeetingDate(next.scheduledAt, timezone) : "";
	const reason = invite.readOnly
		? "Read-only view: invites can't be recorded"
		: !next
			? "Schedule the next meeting first"
			: !phone && !email
				? "Add an email or phone to invite"
				: null;
	// Already invited to this very meeting: the control becomes a re-send
	// rather than repeating the date as if new. Read from every invited meeting,
	// not `lastInvite`, which is only the latest-opened draft. A disabled control
	// keeps the date so its reason ("Add an email or phone…") reads against it.
	const alreadyInvited =
		!!next && !reason && guest.invitedMeetingIds.includes(next.id);
	const label = !next
		? "Invite"
		: alreadyInvited
			? "Resend invite"
			: `Invite to ${meetingDate}`;
	if (reason || !next) {
		return (
			<fieldset
				aria-label={label}
				aria-disabled="true"
				data-slot="guest-invite"
				title={reason ?? undefined}
				className="m-0 flex min-w-0 items-center gap-1.5 border-0 p-0"
			>
				<span className="text-xs font-semibold text-[var(--sea-ink-soft)] opacity-60">
					{label}
				</span>
				<span
					data-slot="guest-invite-reason"
					className="text-[11px] text-[var(--sea-ink-soft)]"
				>
					{reason}
				</span>
			</fieldset>
		);
	}
	const meetingId = next.id;
	return (
		<fieldset
			aria-label={label}
			data-slot="guest-invite"
			className="m-0 flex min-w-0 items-center gap-1.5 border-0 p-0"
		>
			<span className="text-xs font-semibold">{label}</span>
			<NudgeButtons
				mode="invite"
				name={guest.name}
				preferredName={guest.preferredName}
				phone={phone}
				email={email}
				meetingDate={meetingDate}
				meetingTime={formatMeetingTime(next.scheduledAt, timezone)}
				location={next.location}
				clubName={invite.clubName}
				shareUrl={invite.shareUrl}
				onContacted={() => invite.onRecord(guest.id, meetingId)}
			/>
		</fieldset>
	);
}

function GuestRow({
	guest,
	profile,
	clubId,
	busy,
	onMove,
	onConvert,
	timezone,
	invite,
}: {
	guest: PipelineGuestRow;
	/** Kind / home club / introducer (#1050); null if the read did not have it. */
	profile: GuestProfileRow | null;
	clubId: string;
	busy: boolean;
	onMove: (guestId: string, stage: ManualGuestStage) => void;
	onConvert: (guest: PipelineGuestRow) => Promise<boolean>;
	timezone: string;
	invite: InviteProps;
}) {
	// STRANDED, not joined: converted once, then the membership was removed from
	// the roster, which nulls `converted_membership_id` and leaves `stage` saying
	// `joined` forever (#618). Every control here used to be gated on the stage
	// alone, so the card rendered a green "Member" badge for a member who no
	// longer existed and offered nothing at all — the stage buttons were hidden,
	// Convert was hidden, and delete was hidden. Treating it as not-joined is what
	// gives the row its controls back; the badge below says which case it is
	// rather than silently pretending the stage column reads something it doesn't.
	// `GuestRowActions` derives the same pair for the controls.
	const stranded = isStrandedConvertedGuest(guest);
	const visits =
		guest.visitCount === 0
			? "No recorded visits"
			: `${guest.visitCount} visit${guest.visitCount === 1 ? "" : "s"}`;
	const firstVisit = guest.firstVisitAt
		? `first ${formatShortDate(guest.firstVisitAt, timezone)}`
		: null;
	const invitable = isInvitableStage(guest.stage);
	const invited = inviteHistory(guest, timezone, new Date());
	// Phone and email used to be joined into one string, which can't carry a
	// link. They are elements now, so the "·" between them is an element too —
	// and it must agree with what `WhatsAppPhoneLink` actually RENDERS (it trims
	// and renders nothing for a blank value), not with the raw column, or a
	// whitespace-only phone leaves a separator dangling in front of the email.
	//
	// A boolean for the phone but the VALUE for the email, because the two are
	// rendered by different owners: `WhatsAppPhoneLink` trims the phone itself,
	// so this call site only has to decide whether to render it, while the
	// `mailto:` below is built here — and it must use the same trimmed string the
	// gate tested, or `" a@b.com "` ships as `mailto: a@b.com `.
	const hasPhone = (guest.phone ?? "").trim() !== "";
	const email = (guest.email ?? "").trim();
	const kindCaption = profile
		? guestKindCaption(profile.kind, profile.homeClub)
		: null;
	const broughtBy = profile?.introducedByName ?? null;

	return (
		<div className="flex flex-col gap-3 border-b border-[var(--line)] px-5 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
			{/* The identity side keeps a floor and the controls wrap instead. With
			    the controls `shrink-0`, a laptop-width pane squeezed the name,
			    contact and invite badge into a ~40px column, one word a line. */}
			<div className="flex min-w-0 items-center gap-3 sm:w-60 sm:shrink-0">
				<MemberAvatar
					tone={toneFromSeed(guest.id)}
					initials={initialsOf(guest.name)}
					size={38}
				/>
				<div className="min-w-0 leading-[1.3]">
					<div className="truncate text-sm font-bold">{guest.name}</div>
					{kindCaption ? (
						<div
							data-slot="guest-kind-caption"
							className="truncate text-xs font-semibold text-[var(--palm)]"
						>
							{kindCaption}
						</div>
					) : null}
					{invited ? (
						<div
							data-slot="guest-invite-history"
							className="text-xs text-[var(--sea-ink-soft)]"
						>
							{invited.upcoming ? (
								<span
									data-slot="guest-invited-badge"
									className="mr-0.5 inline-block rounded-full border border-[var(--line)] bg-[var(--foam)] px-2 py-0.5 text-xs font-semibold text-[var(--palm)]"
								>
									{invited.lead}
								</span>
							) : (
								invited.lead
							)}
							{invited.detail}
						</div>
					) : null}
					{hasPhone || email ? (
						// `gap-y-0.5`: this line could not wrap while it was one truncated
						// string, and now it can — two elements with no leading between
						// them read as one smudged block on a narrow card.
						<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--sea-ink-soft)]">
							{hasPhone ? (
								<WhatsAppPhoneLink phone={guest.phone} name={guest.name} />
							) : null}
							{email ? (
								// The separator is BOUND to the email, not a sibling of it. As
								// its own flex item in a wrappable container it could be pushed
								// to the end of line 1 with the address starting line 2 —
								// a dangling "·" reading as punctuation on the phone number.
								// Wrapping the pair in one flex child makes them wrap together.
								// `min-w-0` moves onto this child so the address can still
								// truncate inside it.
								<span className="flex min-w-0 items-center gap-x-2">
									{hasPhone ? <span aria-hidden>·</span> : null}
									{/* `mailtoHref`, not raw interpolation. A stored
									    "a@b.com?bcc=x&subject=y" would otherwise become live
									    mailto HEADERS — the reader's own client would silently
									    blind-copy a third party on a message they thought was
									    private. The two free-text writers of `guests.email` are
									    validated in the same change; rows written before that
									    persist, so both halves are needed. */}
									{/* `data-slot="wa-email"` + `text-primary`, matching the phone
									    link beside it. Third instance of the same pair: the
									    unlayered `a { color }` rule in styles.css beats any
									    layered utility, so this address rendered --lagoon-deep
									    (#328f97, 3.81:1) at 12px — under AA — while its peer
									    rendered --lagoon-ink (5.82:1). */}
									<a
										href={mailtoHref(email)}
										data-slot="wa-email"
										className="min-w-0 truncate text-primary hover:underline"
									>
										{email}
									</a>
								</span>
							) : null}
						</div>
					) : null}
					<div className="text-xs text-[var(--sea-ink-soft)]">
						{visits}
						{firstVisit ? ` · ${firstVisit}` : ""}
					</div>
					{broughtBy ? (
						<div
							data-slot="guest-brought-by"
							className="truncate text-xs text-[var(--sea-ink-soft)]"
						>
							Brought by {broughtBy}
						</div>
					) : null}
				</div>
			</div>

			{/* Three controls, not eight (asked for directly, 2026-09-28): the
			    invite, which is the job this page exists for, stays out; moving
			    lanes is ONE dropdown; everything rare sits behind ⋯. */}
			<div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:justify-end">
				{invitable ? (
					<GuestInvite
						guest={guest}
						phone={hasPhone ? guest.phone : null}
						email={email || null}
						invite={invite}
						timezone={timezone}
					/>
				) : null}
				{stranded ? (
					<span
						data-slot="stranded-badge"
						title="This guest was converted to a member, and that member has since been removed from the roster."
						className="rounded-full bg-[var(--surface-strong)] px-2.5 py-1 text-xs font-bold text-[var(--sea-ink-soft)]"
					>
						Member removed
					</span>
				) : null}
				<GuestRowActions
					guest={guest}
					clubId={clubId}
					busy={busy}
					onMove={onMove}
					onConvert={onConvert}
				/>
			</div>
		</div>
	);
}

/**
 * What deleting this guest will actually do, spelled out: held roles go back to
 * Open, and their visit history goes with them. A guest who really visited
 * should be moved to Lost instead — delete is for mistakes (#364).
 */
function deleteBlurb(guest: PipelineGuestRow): string {
	const held =
		guest.heldSlotCount > 0
			? `They hold ${guest.heldSlotCount} role${
					guest.heldSlotCount === 1 ? "" : "s"
				}, which will be reset to Open. `
			: "";
	const kept =
		guest.visitCount > 0
			? " If they really visited, move them to Lost instead so the record is kept."
			: "";
	return `${held}Their visits and minutes entries go with them. This can't be undone.${kept}`;
}

/**
 * A guest row's lane dropdown, its ⋯ menu, and the dialogs both open.
 *
 * The lane dropdown shows where the guest is and moves them: Prospect,
 * Following up and Lost directly, and "Joined…" through `GuestJoinedDialog`,
 * which is where Convert and "Already a member?" now live as the two answers to
 * one question. They used to be two buttons side by side whose difference —
 * whether a NEW roster member gets created — neither label said.
 *
 * The ⋯ menu holds what is rare: Edit, Delete (#364), and the two reversals,
 * Unlink (#635) and Undo conversion (#618). Each row owns its dialog state.
 */
function GuestRowActions({
	guest,
	clubId,
	busy: rowBusy,
	onMove,
	onConvert,
}: {
	guest: PipelineGuestRow;
	clubId: string;
	busy: boolean;
	onMove: (guestId: string, stage: ManualGuestStage) => void;
	onConvert: (guest: PipelineGuestRow) => Promise<boolean>;
}) {
	const router = useRouter();
	const [joinedOpen, setJoinedOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [ownBusy, setOwnBusy] = useState(false);
	const busy = rowBusy || ownBusy;
	// Derived here from `guest`, not passed beside it, so the two cannot
	// disagree. STRANDED = converted once, then the membership was removed
	// (#618): it gets the lane dropdown and Delete back.
	const stranded = isStrandedConvertedGuest(guest);
	const joined = guest.stage === "joined" && !stranded;

	// THREE states, not two, and both single-boolean versions of this were wrong.
	//
	// Gating on `convertedMembershipId` alone put an Unlink on every REAL convert,
	// where it fails every time — telling the admin the guest is "not linked to a
	// member" while the card beside it says Member. Gating on `linkReversible`
	// alone then offered a real convert the LINK action, which the seam refuses
	// for the opposite reason.
	//
	// A real convert gets neither: it already created a Person and a membership,
	// so there is nothing to link and nothing Unlink can safely undo (#618 owns
	// that, and only when the conversion carries the record its undo replays — a
	// conversion older than that would be refused, and an action that always
	// fails is worse than none).
	const linkedByLink = guest.linkReversible;
	const convertedForReal =
		Boolean(guest.convertedMembershipId) && !guest.linkReversible;
	const canUndoConversion = convertedForReal && guest.conversionUndoable;
	const manualStage = MANUAL_STAGES.find((s) => s.id === guest.stage);
	// A stranded guest's stage column still reads `joined`, which is no lane it
	// can be moved "from"; the trigger says what to do instead of naming a lane
	// it is not really in. The accessible name reads the same words.
	const laneLabel = manualStage?.label ?? "Move to…";

	/** Disable the row's controls while `work` runs, and toast if it throws. */
	async function withBusyToast(work: () => Promise<void>) {
		setOwnBusy(true);
		try {
			await work();
		} catch (err) {
			toastError(err);
		} finally {
			setOwnBusy(false);
		}
	}

	function onUnlink() {
		void withBusyToast(async () => {
			await unlinkGuestFromMember({ data: { clubId, guestId: guest.id } });
			toast.success(`${guest.name} is no longer linked.`);
			await router.invalidate();
		});
	}

	function onUndoConversion() {
		// A confirm, like Convert's own dialog — this one deletes a roster row,
		// and the menu sits on a card the admin may have opened for another reason.
		if (
			!window.confirm(
				`Undo ${guest.name}'s conversion? This removes the membership it ` +
					`created and returns them to Following up, with any roles they hold ` +
					`going back to the guest.`,
			)
		) {
			return;
		}
		void withBusyToast(async () => {
			await undoGuestConversion({ data: { clubId, guestId: guest.id } });
			toast.success(`${guest.name} is a guest again.`);
			await router.invalidate();
		});
	}

	function onDelete() {
		void withBusyToast(async () => {
			const res = await deleteGuest({ data: { clubId, guestId: guest.id } });
			toast.success(
				res.slotsReopened > 0
					? `${guest.name} deleted. ${res.slotsReopened} role${
							res.slotsReopened === 1 ? "" : "s"
						} reset to Open.`
					: `${guest.name} deleted.`,
			);
			setDeleteOpen(false);
			await router.invalidate();
		});
	}

	return (
		<>
			{joined ? (
				<span className="rounded-full bg-[var(--success)] px-2.5 py-1 text-xs font-bold text-[var(--success-foreground)]">
					Member
				</span>
			) : (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							aria-label={`Lane for ${guest.name}: ${laneLabel}`}
						>
							{busy ? (
								<Loader2 className="size-4 animate-spin" aria-hidden />
							) : null}
							{laneLabel}
							<ChevronDown className="size-4 opacity-60" aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel>Move to</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={manualStage?.id ?? ""}
							onValueChange={(value) => {
								const next = MANUAL_STAGES.find((s) => s.id === value);
								if (next && next.id !== guest.stage) onMove(guest.id, next.id);
							}}
						>
							{MANUAL_STAGES.map((s) => (
								<DropdownMenuRadioItem key={s.id} value={s.id}>
									{s.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => setJoinedOpen(true)}>
							<UserPlus aria-hidden />
							Joined…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						aria-label={`More actions for ${guest.name}`}
					>
						<MoreHorizontal className="size-4" aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{/* Edit is offered at every stage: the guest row is only ever the
					    record of the visitor. */}
					<DropdownMenuItem onSelect={() => setEditOpen(true)}>
						<Pencil aria-hidden />
						Edit
					</DropdownMenuItem>
					{linkedByLink ? (
						<DropdownMenuItem onSelect={onUnlink}>
							<Unlink aria-hidden />
							Unlink
						</DropdownMenuItem>
					) : null}
					{canUndoConversion ? (
						<DropdownMenuItem onSelect={onUndoConversion}>
							<Undo2 aria-hidden />
							Undo conversion
						</DropdownMenuItem>
					) : null}
					{/* Not once they have converted — the server rejects it too. */}
					{joined ? null : (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onSelect={() => setDeleteOpen(true)}
							>
								<Trash2 aria-hidden />
								Delete
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			{joined ? null : (
				<GuestJoinedDialog
					guest={guest}
					clubId={clubId}
					open={joinedOpen}
					onOpenChange={setJoinedOpen}
					onConvert={onConvert}
				/>
			)}

			{/* The SHARED dialog (#727) — the same component the meeting page's
			    attendance rail opens from a guest's name. `PipelineGuestRow` is a
			    superset of `GuestEditFields`, so this row goes straight in. Do NOT
			    inline a copy back here: the form's three-way `name` / `form.get` /
			    `defaultValue` wiring is guarded in ONE file (`goes-by-field.guard
			    .test.ts`), and a second copy is a second place for it to rot
			    silently — a mismatch wipes the stored value on every save. */}
			<GuestEditDialog
				guest={guest}
				clubId={clubId}
				open={editOpen}
				onOpenChange={setEditOpen}
			/>

			{/* The confirm names exactly what delete will do — including how many
			    role slots get reset to Open — so a guest holding roles is never a
			    silent surprise. */}
			<Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete {guest.name}?</DialogTitle>
						<DialogDescription>{deleteBlurb(guest)}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={onDelete}
						>
							{busy ? "Deleting…" : "Delete guest"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * "Joined…": the one question behind what used to be two buttons — is this a
 * NEW member, or someone already on the roster?
 *
 * New member is Convert: it creates their roster membership and re-points any
 * roles they hold. Already on the roster is the link (#635), for a human who
 * became a member without going through Convert — the public self-add (#616)
 * minted a `members` row with no awareness of the guest pipeline — so they show
 * in both the member picker and the guest chips, and their member row reads
 * "Never done this role" for roles they did. #617 refuses Convert for exactly
 * these rows, so the link is their only path.
 *
 * Choosing "New member" here IS the confirmation; Convert's old
 * `window.confirm` said the same thing one tap later.
 */
function GuestJoinedDialog({
	guest,
	clubId,
	open,
	onOpenChange,
	onConvert,
}: {
	guest: PipelineGuestRow;
	clubId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConvert: (guest: PipelineGuestRow) => Promise<boolean>;
}) {
	const router = useRouter();
	const stranded = isStrandedConvertedGuest(guest);
	const [step, setStep] = useState<"choose" | "link">("choose");
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
	const [picked, setPicked] = useState<LinkCandidate | null>(null);

	function setOpen(next: boolean) {
		onOpenChange(next);
		if (!next) {
			// Reopening starts at the question, not wherever it was left.
			setStep("choose");
			setPicked(null);
			setQuery("");
		}
	}

	// Loaded when the link step opens rather than with the board: this is one
	// query per guest card, and a club with fifty prospects should not pay fifty
	// roster scans to render a page where most cards are never opened.
	useEffect(() => {
		if (!open || step !== "link" || candidates) return;
		let cancelled = false;
		getLinkCandidates({ data: { clubId, guestId: guest.id } })
			.then((rows) => {
				if (!cancelled) setCandidates(rows);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setCandidates([]);
				toast.error(
					err instanceof Error ? err.message : "Couldn't load the roster.",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [open, step, candidates, clubId, guest.id]);

	const filtered = (candidates ?? [])
		.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
		// Suggested names first; the rest stay in the roster's own name order.
		.sort((a, b) => Number(b.suggested) - Number(a.suggested));

	async function onNewMember() {
		setBusy(true);
		try {
			if (await onConvert(guest)) setOpen(false);
		} finally {
			setBusy(false);
		}
	}

	async function onLink(member: LinkCandidate) {
		setBusy(true);
		try {
			await linkGuestToMember({
				data: { clubId, guestId: guest.id, memberId: member.id },
			});
			toast.success(`${guest.name} is linked to ${member.name}.`);
			setCandidates(null);
			setOpen(false);
			await router.invalidate();
		} catch (err) {
			toastError(err);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="sm:max-w-md">
				{step === "choose" ? (
					<>
						<DialogHeader>
							<DialogTitle>{guest.name} joined?</DialogTitle>
							<DialogDescription>
								{stranded
									? "Their earlier membership was removed from the roster. Which is it now?"
									: "Which is it?"}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-2">
							<button
								type="button"
								data-slot="joined-new-member"
								disabled={busy}
								onClick={() => void onNewMember()}
								className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
							>
								{busy ? (
									<Loader2
										className="mt-0.5 size-4 shrink-0 animate-spin"
										aria-hidden
									/>
								) : (
									<UserPlus className="mt-0.5 size-4 shrink-0" aria-hidden />
								)}
								<span>
									<span className="block font-medium">New member</span>
									<span className="block text-sm text-[var(--sea-ink-soft)]">
										Adds them to the roster. Any roles they hold move onto their
										new member record.
									</span>
								</span>
							</button>
							<button
								type="button"
								data-slot="joined-already-member"
								disabled={busy}
								onClick={() => setStep("link")}
								className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
							>
								<Link2 className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									<span className="block font-medium">
										Already on the roster
									</span>
									<span className="block text-sm text-[var(--sea-ink-soft)]">
										A member who signed in as a guest. Links this guest to their
										member record; nobody new is added.
									</span>
								</span>
							</button>
						</div>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Link {guest.name} to a member</DialogTitle>
							<DialogDescription>
								Their guest history — including roles they've done — moves onto
								that member. No new roster row is created.
							</DialogDescription>
						</DialogHeader>

						{picked ? (
							<div className="space-y-3 text-sm">
								<p>
									Link <span className="font-medium">{guest.name}</span> to{" "}
									<span className="font-medium">{picked.name}</span>?
								</p>
								{picked.sharesMeeting ? (
									// Warn, do not refuse. Holding two roles at one meeting is
									// legal and ordinary at a small club; it is just surprising
									// enough that it should not happen silently.
									<p
										data-slot="link-same-meeting-warning"
										className="rounded-lg bg-[var(--surface-strong)] p-3 text-[var(--sea-ink-soft)]"
									>
										Heads up: {picked.name} already has a role at a meeting
										where {guest.name} does. After linking, one person holds
										both.
									</p>
								) : null}
								<DialogFooter>
									<Button
										type="button"
										variant="outline"
										onClick={() => setPicked(null)}
										disabled={busy}
									>
										Back
									</Button>
									<Button
										type="button"
										onClick={() => void onLink(picked)}
										disabled={busy}
									>
										{busy ? "Linking…" : "Link them"}
									</Button>
								</DialogFooter>
							</div>
						) : (
							<div className="space-y-3">
								<Input
									placeholder="Search the roster…"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									autoComplete="off"
								/>
								{candidates === null ? (
									<p className="text-muted-foreground text-sm">Loading…</p>
								) : filtered.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No members match “{query}”.
									</p>
								) : (
									<ul className="flex max-h-[40svh] flex-col gap-2 overflow-y-auto">
										{filtered.map((c) => (
											<li key={c.id}>
												<button
													type="button"
													onClick={() => setPicked(c)}
													className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
												>
													<span className="truncate font-medium">{c.name}</span>
													{c.suggested ? (
														<span className="shrink-0 rounded-full bg-[var(--success)] px-2 py-0.5 text-[var(--success-foreground)] text-xs font-bold">
															Same name
														</span>
													) : null}
												</button>
											</li>
										))}
									</ul>
								)}
								<DialogFooter>
									<Button
										type="button"
										variant="outline"
										onClick={() => setStep("choose")}
									>
										Back
									</Button>
								</DialogFooter>
							</div>
						)}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
