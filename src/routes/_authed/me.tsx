import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarDays, Loader2, Mic } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CoverSheet, type CoverSlot } from "#/components/club/cover-sheet";
import { MySpeechRequests } from "#/components/club/my-speech-requests";
import { PageContainer } from "#/components/page-container";
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	coverSlotFromCommitment,
	opensCoverSheet,
} from "#/lib/cover-sheet-logic";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { navLabel } from "#/lib/nav-destinations";
import { navPageTitle } from "#/lib/page-title";
import { DUTY_TOAST_MS, roleFreedDutyText } from "#/lib/role-duty-copy";
import { listMyCommitments } from "#/server/meetings";
import { releaseSlot } from "#/server/slots";
import {
	getMySpeechRequests,
	type MySpeechRequest,
} from "#/server/speech-requests";

export const Route = createFileRoute("/_authed/me")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		const [commitments, speechRequests] = await Promise.all([
			listMyCommitments(),
			// The active club's open and scheduled requests (#1052); none without a club.
			clubId
				? getMySpeechRequests({ data: { clubId } })
				: Promise.resolve([] as MySpeechRequest[]),
		]);
		return { commitments, speechRequests };
	},
	component: MyCommitments,
	head: ({ match }) => ({
		meta: [{ title: navPageTitle("/me", match.context) }],
	}),
});

function MyCommitments() {
	const { commitments, speechRequests } = Route.useLoaderData();
	const { currentMemberId, activeClubId } = Route.useRouteContext();
	const router = useRouter();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	// A late own release waits here for the cover sheet (#1439).
	const [coverSlots, setCoverSlots] = useState<CoverSlot[]>([]);

	// Speaking roles assigned without a speech title/project yet — usually because
	// an officer slotted you in from the sign-up sheet (#officer-assign).
	const needsSpeechDetails = commitments.filter(
		(c) => c.isSpeakerRole && !c.speechTitle,
	);

	async function doRelease(c: (typeof commitments)[number]) {
		const slotId = c.slotId;
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		// /me lists only your own commitments, so every row is an own role.
		if (opensCoverSheet({ isOwnRole: true, scheduledAt: c.scheduledAt })) {
			setCoverSlots([
				// `parseMeetingKey` accepts the meeting's uuid.
				coverSlotFromCommitment(c, {
					clubSlug: c.clubSlug,
					urlKey: c.meetingId,
				}),
			]);
			return;
		}
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId: currentMemberId } });
			// /me lists only your own commitments, so the holder is the viewer.
			toast.success(roleFreedDutyText(1), { duration: DUTY_TOAST_MS });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<PageContainer className="space-y-4">
			<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
				{navLabel("/me")}
			</h1>

			{/* Temporary (#912): remove after 2026-12-31. */}
			<p className="text-sm text-muted-foreground">
				API tokens and connected apps have moved to{" "}
				<Link to="/account" className="font-semibold text-primary underline">
					{navLabel("/account")}
				</Link>
				.
			</p>

			{needsSpeechDetails.length > 0 ? (
				<div className="rounded-xl border border-warning/40 bg-warning-soft p-4">
					<div className="flex items-center gap-2 font-semibold text-warning-foreground">
						<Mic className="size-4" aria-hidden />
						Speeches needing details
					</div>
					<p className="mt-1 text-sm text-muted-foreground">
						You're down to speak but haven't added a title or project yet. Add
						them so your evaluator can prepare.
					</p>
					<ul className="mt-3 space-y-1.5">
						{needsSpeechDetails.map((c) => (
							<li key={c.slotId}>
								<Link
									to="/meetings/$id"
									params={{ id: c.meetingId }}
									className="flex items-center justify-between gap-2 rounded-lg bg-card/60 px-3 py-2 text-sm no-underline hover:bg-card"
								>
									<span className="min-w-0 truncate">
										{c.roleName} ·{" "}
										{formatMeetingDate(c.scheduledAt, c.timezone)}
									</span>
									<span className="shrink-0 font-semibold text-primary">
										Add details →
									</span>
								</Link>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{activeClubId ? (
				<MySpeechRequests clubId={activeClubId} requests={speechRequests} />
			) : null}

			{commitments.length === 0 ? (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					You haven't claimed any roles yet.{" "}
					<Link
						to="/schedule"
						search={{ view: "members", count: 8 }}
						className="font-semibold text-primary underline"
					>
						Sign up on the sign-up sheet
					</Link>{" "}
					to get started.
				</p>
			) : (
				<ul className="space-y-3">
					{commitments.map((c) => (
						<li
							key={c.slotId}
							className="rounded-xl border bg-card p-4 shadow-sm"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<p className="font-semibold">{c.roleName}</p>
										{c.isSpeakerRole ? (
											<Mic className="size-4 text-primary" aria-hidden />
										) : null}
									</div>
									{c.isSpeakerRole && c.speechTitle ? (
										<p className="text-sm text-muted-foreground">
											“{c.speechTitle}”
										</p>
									) : null}
									{/* Speakers and evaluators only. A functionary (Timer,
									    Ah-Counter, Grammarian…) fills in no evaluation form, and
									    unconditionally this line advertised one on most rows of
									    a typical agenda. `fallback` IS passed here: an evaluator
									    paired with a TBA speech still needs a usable form —
									    spec §3 step 3, the reason 8053 ships. */}
									{c.isSpeakerRole ||
									c.evaluatesSlotId !== null ||
									c.roleCategory === "evaluator" ? (
										<EvaluationResourceLinks
											projectName={c.evaluatedProjectName ?? c.ownProjectName}
											// Fall back to the generic form ONLY when there is no
											// project name at all — a TBA speech. A name that is
											// present but matches nothing (a Base-Camp-derived
											// project the catalog lacks, e.g. Cross-Cultural
											// Understanding, for which TI publishes 8202E) must
											// render NO link, per spec §2. Passing `fallback`
											// unconditionally handed that speaker an
											// authoritative-looking WRONG form and made this
											// surface disagree with the picker about one project.
											fallback={!(c.evaluatedProjectName ?? c.ownProjectName)}
										/>
									) : null}
									<Link
										to="/meetings/$id"
										params={{ id: c.meetingId }}
										className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
									>
										<CalendarDays className="size-4" aria-hidden />
										{/* Club first: this list spans every club the user belongs
										    to (#437), while the shell header names only the active
										    one. Without it a two-club member sees two rows that
										    differ by date alone — each with its own Release. */}
										<span className="font-semibold text-foreground">
											{c.clubName}
										</span>{" "}
										· {formatMeetingDate(c.scheduledAt, c.timezone)} ·{" "}
										{formatMeetingTimeRange(
											c.scheduledAt,
											c.lengthMinutes,
											c.timezone,
										)}
										{c.theme ? (
											<span className="truncate"> · {c.theme}</span>
										) : null}
									</Link>
								</div>
								<div className="flex shrink-0 flex-col items-end gap-2">
									<Badge
										variant={c.status === "confirmed" ? "default" : "secondary"}
									>
										{c.status}
									</Badge>
									<Button
										size="sm"
										variant="outline"
										onClick={() => doRelease(c)}
										disabled={busySlotId === c.slotId}
									>
										{busySlotId === c.slotId ? (
											<Loader2 className="size-4 animate-spin" />
										) : (
											"Release"
										)}
									</Button>
								</div>
							</div>
						</li>
					))}
				</ul>
			)}
			<CoverSheet
				slots={coverSlots}
				onClose={() => setCoverSlots([])}
				onChanged={() => router.invalidate()}
			/>
		</PageContainer>
	);
}
