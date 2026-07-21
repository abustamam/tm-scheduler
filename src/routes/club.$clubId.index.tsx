import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarDays, Loader2, MailCheck, Mic, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SeasonGrid } from "#/components/club/season-grid";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { type StoredMember, useEffectiveMember } from "#/lib/member-identity";
import type { Orientation } from "#/lib/season-grid-view";
import { listMemberCommitments } from "#/server/meetings";
import {
	getPublicSeasonGrid,
	type SeasonGridCount,
} from "#/server/season-grid";
import { releaseSlot } from "#/server/slots";

type Search = { view: Orientation; count: SeasonGridCount };

export const Route = createFileRoute("/club/$clubId/")({
	// Default to the Roles × Meetings sign-up sheet — the interactive orientation.
	validateSearch: (search: Record<string, unknown>): Search => ({
		view: search.view === "members" ? "members" : "roles",
		count:
			search.count === 4 || search.count === "4"
				? 4
				: search.count === "all"
					? "all"
					: 8,
	}),
	loaderDeps: ({ search }) => ({ count: search.count }),
	loader: ({ context, deps }) =>
		getPublicSeasonGrid({
			data: { clubId: context.clubUuid, count: deps.count },
		}),
	component: ClubHome,
});

function ClubHome() {
	const { clubId } = Route.useParams();
	const { clubUuid, effectiveMemberId, authCtx } = Route.useRouteContext();
	const grid = Route.useLoaderData();
	const { view, count } = Route.useSearch();
	// Shell-wrapped signed-in member → session identity; anonymous → localStorage
	// pick (#317). `source` hides the anon-only "not you?" + claim affordances.
	const session =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
	const { member, clearMember, source } = useEffectiveMember(clubId, session);
	const router = useRouter();
	const navigate = Route.useNavigate();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);

	const commitments = useQuery({
		queryKey: ["commitments", member?.id],
		queryFn: () => {
			if (!member) return Promise.resolve([]);
			return listMemberCommitments({ data: member.id });
		},
		enabled: !!member,
	});

	async function refetchAll() {
		await router.invalidate();
		await commitments.refetch();
	}

	async function doRelease(slotId: string) {
		if (!member) return;
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId: member.id } });
			toast.success("Role released.");
			await refetchAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<div className="mx-auto w-full max-w-public space-y-6 p-4 pb-8 md:p-6">
			{/* Header */}
			<div className="flex items-center justify-between pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					Hi {member?.name ?? "there"} 👋
				</h1>
				{member && source === "anon" ? (
					<button
						type="button"
						onClick={clearMember}
						className="text-sm text-muted-foreground underline underline-offset-2"
					>
						not you?
					</button>
				) : null}
			</div>

			<Link
				to="/resources/$slug"
				params={{ slug: "what-to-expect" }}
				className="inline-flex text-sm font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
			>
				New to Toastmasters? See what to expect at a meeting →
			</Link>

			{/* "This is me" — graduate a public picker into a real account (#266). */}
			{member && source === "anon" ? (
				<ClaimAccountCard member={member} />
			) : null}

			{/* Sign-up sheet — the primary surface. Claim an OPEN role or release
			    your own right in the grid; everyone else is greyed out. */}
			<section className="space-y-3">
				<div>
					<h2 className="text-base font-semibold">Sign-up sheet</h2>
					<p className="text-sm text-muted-foreground">
						Tap an <span className="font-medium text-success">open</span> role
						to claim it, or your own to release it.
					</p>
				</div>
				<SeasonGrid
					data={grid}
					orientation={view}
					count={count}
					currentMemberId={member?.id ?? null}
					clubId={clubUuid}
					clubSlug={clubId}
					onOrientationChange={(v) =>
						navigate({ search: (prev) => ({ ...prev, view: v }) })
					}
					onCountChange={(c) =>
						navigate({ search: (prev) => ({ ...prev, count: c }) })
					}
					onChanged={refetchAll}
				/>
			</section>

			{/* Your upcoming roles — a compact summary of your commitments. */}
			<section className="space-y-3">
				<h2 className="text-base font-semibold">Your upcoming roles</h2>
				{!member || commitments.isPending ? (
					<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
						{commitments.isFetching ? (
							<span className="flex items-center gap-2">
								<Loader2 className="size-4 animate-spin" aria-hidden />
								Loading your roles…
							</span>
						) : (
							"Loading your roles…"
						)}
					</div>
				) : commitments.data && commitments.data.length > 0 ? (
					<ul className="grid gap-3 md:grid-cols-2">
						{commitments.data.map((c) => (
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
												&ldquo;{c.speechTitle}&rdquo;
											</p>
										) : null}
										<Link
											to="/club/$clubId/meeting/$meetingId"
											params={{ clubId, meetingId: c.meetingId }}
											className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
										>
											<CalendarDays className="size-4" aria-hidden />
											{formatMeetingDate(c.scheduledAt, c.timezone)} &middot;{" "}
											{formatMeetingTimeRange(
												c.scheduledAt,
												c.lengthMinutes,
												c.timezone,
											)}
											{c.theme ? (
												<span className="truncate"> &middot; {c.theme}</span>
											) : null}
										</Link>
									</div>
									<div className="flex shrink-0 flex-col items-end gap-2">
										<Badge
											variant={
												c.status === "confirmed" ? "default" : "secondary"
											}
										>
											{c.status}
										</Badge>
										<Button
											size="sm"
											variant="outline"
											onClick={() => doRelease(c.slotId)}
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
				) : (
					<p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
						No roles yet — tap an open role in the sheet above to claim one.
					</p>
				)}
			</section>
		</div>
	);
}

/**
 * Persistent "Save this to your account" prompt on the public sign-up surface
 * (#266, Part B). Sends a standard magic link (the rate-limited sign-in path)
 * with a callback that binds the picked Person to the new account after
 * verification (`/claim?person=<memberId>`). Hidden for already-signed-in
 * visitors. Linking stays safe server-side (`claimPersonForUser`): the picked
 * name is only attached when the verified email matches, so this can't hijack a
 * name that belongs to someone else.
 */
function ClaimAccountCard({ member }: { member: StoredMember }) {
	const { data: session, isPending } = authClient.useSession();
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	// Only offer this to visitors who aren't already signed in.
	if (isPending || session) return null;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!email.trim() || status === "sending") return;
		setStatus("sending");
		setError(null);
		const { error: sendError } = await authClient.signIn.magicLink({
			email: email.trim(),
			callbackURL: `/claim?person=${member.id}`,
		});
		if (sendError) {
			setStatus("error");
			setError(sendError.message ?? "Something went wrong. Please try again.");
			return;
		}
		setStatus("sent");
	}

	if (status === "sent") {
		return (
			<div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/5 p-4">
				<MailCheck
					className="mt-0.5 size-5 shrink-0 text-success"
					aria-hidden
				/>
				<div className="text-sm">
					<p className="font-semibold text-foreground">Check your email</p>
					<p className="text-muted-foreground">
						We sent a sign-in link to{" "}
						<span className="font-medium text-foreground">{email}</span>. Open
						it to save{" "}
						<span className="font-medium text-foreground">{member.name}</span>{" "}
						to your account.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-xl border bg-card p-4 shadow-sm">
			<div className="flex items-start gap-3">
				<Sparkles className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
				<div className="min-w-0 flex-1 space-y-3">
					<div>
						<p className="text-sm font-semibold text-foreground">
							Save this to your account
						</p>
						<p className="text-sm text-muted-foreground">
							Create a free account so your roles and speech history follow you.
							We'll email you a magic link — no password needed.
						</p>
					</div>
					<form onSubmit={onSubmit} className="space-y-2">
						<Label htmlFor="claim-email" className="sr-only">
							Your email
						</Label>
						<div className="flex flex-col gap-2 sm:flex-row">
							<Input
								id="claim-email"
								type="email"
								inputMode="email"
								autoComplete="email"
								required
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="flex-1"
							/>
							<Button type="submit" disabled={status === "sending"}>
								{status === "sending" ? (
									<Loader2 className="size-4 animate-spin" aria-hidden />
								) : (
									"Send me a link"
								)}
							</Button>
						</div>
						{error ? (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						) : null}
					</form>
				</div>
			</div>
		</div>
	);
}
