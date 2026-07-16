import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2, Printer, UserPlus } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatShortDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import { getClubByIdentifier } from "#/server/clubs";
import {
	convertGuestToMember,
	type GuestStage,
	getGuestPipeline,
	type ManualGuestStage,
	type PipelineGuestRow,
	setGuestStage,
} from "#/server/guest-pipeline";

export const Route = createFileRoute("/_authed/admin/vp-membership")({
	beforeLoad: ({ context }) => {
		if (!effectiveAdminClub(context)) {
			throw redirect({ to: "/roster" });
		}
	},
	loader: async ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) {
			return { guests: [], clubId: "", clubName: "", clubSlug: null };
		}
		const [guests, resolved] = await Promise.all([
			getGuestPipeline({ data: club.clubId }),
			getClubByIdentifier({ data: club.clubId }),
		]);
		return {
			guests,
			clubId: club.clubId,
			clubName: club.name,
			clubSlug: resolved?.slug ?? null,
		};
	},
	component: VpMembership,
});

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

function VpMembership() {
	const { guests, clubId, clubName, clubSlug } = Route.useLoaderData();
	const { currentMemberId } = Route.useRouteContext();
	const router = useRouter();
	const [busyId, setBusyId] = useState<string | null>(null);

	// The absolute guest-book URL is derived in the browser so the QR/printed
	// link match the origin the admin is on (dev, preview, or prod). The QR is
	// STABLE — the guest-book route resolves the current meeting itself.
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const guestBookUrl = clubSlug ? `${origin}/club/${clubSlug}/guest-book` : "";

	async function move(guestId: string, stage: ManualGuestStage) {
		setBusyId(guestId);
		try {
			await setGuestStage({ data: { clubId, guestId, stage } });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyId(null);
		}
	}

	async function convert(guest: PipelineGuestRow) {
		if (
			!window.confirm(
				`Convert ${guest.name} into a club member? This creates their roster membership and re-points any roles they hold.`,
			)
		) {
			return;
		}
		setBusyId(guest.id);
		try {
			await convertGuestToMember({
				data: { clubId, guestId: guest.id, actorMemberId: currentMemberId },
			});
			toast.success(`${guest.name} is now a member. 🎉`);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
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

			{/* Pipeline, bucketed by stage. */}
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
									busy={busyId === g.id}
									onMove={move}
									onConvert={convert}
								/>
							))
						)}
					</Section>
				);
			})}

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

function EmptyRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]">
			{children}
		</p>
	);
}

function GuestRow({
	guest,
	busy,
	onMove,
	onConvert,
}: {
	guest: PipelineGuestRow;
	busy: boolean;
	onMove: (guestId: string, stage: ManualGuestStage) => void;
	onConvert: (guest: PipelineGuestRow) => void;
}) {
	const joined = guest.stage === "joined";
	const visits =
		guest.visitCount === 0
			? "No recorded visits"
			: `${guest.visitCount} visit${guest.visitCount === 1 ? "" : "s"}`;
	const firstVisit = guest.firstVisitAt
		? `first ${formatShortDate(guest.firstVisitAt)}`
		: null;
	const contact = [guest.phone, guest.email].filter(Boolean).join(" · ");

	return (
		<div className="flex flex-col gap-3 border-b border-[var(--line)] px-5 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex min-w-0 items-center gap-3">
				<MemberAvatar
					tone={toneFromSeed(guest.id)}
					initials={initialsOf(guest.name)}
					size={38}
				/>
				<div className="min-w-0 leading-[1.3]">
					<div className="truncate text-sm font-bold">{guest.name}</div>
					{contact ? (
						<div className="truncate text-xs text-[var(--sea-ink-soft)]">
							{contact}
						</div>
					) : null}
					<div className="text-xs text-[var(--sea-ink-soft)]">
						{visits}
						{firstVisit ? ` · ${firstVisit}` : ""}
					</div>
				</div>
			</div>

			{joined ? (
				<span className="shrink-0 self-start rounded-full bg-[var(--success)] px-2.5 py-1 text-xs font-bold text-[var(--success-foreground)] sm:self-center">
					Member
				</span>
			) : (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5">
					{MANUAL_STAGES.filter((s) => s.id !== guest.stage).map((s) => (
						<Button
							key={s.id}
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => onMove(guest.id, s.id)}
						>
							{s.label}
						</Button>
					))}
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => onConvert(guest)}
					>
						{busy ? (
							<Loader2 className="size-4 animate-spin" aria-hidden />
						) : (
							<>
								<UserPlus className="size-4" aria-hidden />
								Convert
							</>
						)}
					</Button>
				</div>
			)}
		</div>
	);
}
