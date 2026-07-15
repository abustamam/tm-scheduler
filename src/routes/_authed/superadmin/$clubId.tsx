import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	Eye,
	Loader2,
	Pencil,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { startImpersonation } from "#/server/impersonation";
import {
	archiveConsoleClub,
	getConsoleClubDetail,
	unarchiveConsoleClub,
	updateConsoleAdminEmail,
} from "#/server/onboarding";

export const Route = createFileRoute("/_authed/superadmin/$clubId")({
	loader: ({ params }) => getConsoleClubDetail({ data: params.clubId }),
	component: ClubDetail,
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
});

function ClubDetail() {
	const club = Route.useLoaderData();
	const { clubId } = Route.useParams();
	const router = useRouter();

	return (
		<PageContainer className="space-y-6">
			<div className="space-y-1">
				<Link
					to="/superadmin"
					className="inline-flex items-center gap-1 text-sm text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
				>
					<ArrowLeft className="size-4" /> All clubs
				</Link>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{club.name}
					{club.archivedAt ? (
						<span className="ml-3 inline-block rounded-full bg-[var(--sand)] px-2.5 py-1 align-middle text-xs font-semibold text-[var(--sea-ink-soft)] uppercase tracking-[0.04em]">
							Archived
						</span>
					) : null}
				</h1>
				<p className="text-sm text-muted-foreground">
					Club {club.clubNumber ?? "—"} · slug {club.slug} · {club.memberCount}{" "}
					member{club.memberCount === 1 ? "" : "s"} · created{" "}
					{dateFmt.format(new Date(club.createdAt))}
				</p>
			</div>

			<section className="max-w-xl space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
				<h2 className="text-sm font-bold">First admin</h2>
				{club.firstAdmin ? (
					<AdminPanel
						clubId={clubId}
						name={club.firstAdmin.name}
						email={club.firstAdmin.email}
						linked={club.firstAdmin.linked}
						onSaved={() => router.invalidate()}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						This club has no admin.
					</p>
				)}
			</section>

			{club.archivedAt ? null : (
				<>
					<ViewAsPanel clubId={clubId} clubName={club.name} />
					<ActAsAdminPanel clubId={clubId} clubName={club.name} />
				</>
			)}

			<ArchivePanel
				clubId={clubId}
				clubName={club.name}
				archivedAt={club.archivedAt ? new Date(club.archivedAt) : null}
				onChanged={() => router.invalidate()}
			/>
		</PageContainer>
	);
}

function ViewAsPanel({
	clubId,
	clubName,
}: {
	clubId: string;
	clubName: string;
}) {
	const router = useRouter();
	const [submitting, setSubmitting] = useState(false);

	async function onViewAs() {
		setSubmitting(true);
		try {
			await startImpersonation({ data: { clubId } });
			// Re-run getAuthContext so the workspace picks up the session (it forces
			// the impersonated club active) and renders the read-only banner.
			await router.invalidate();
			await router.navigate({ to: "/" });
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't start the session.",
			);
			setSubmitting(false);
		}
	}

	return (
		<section className="max-w-xl space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
			<h2 className="text-sm font-bold">View as this club</h2>
			<p className="text-sm text-muted-foreground">
				Open <span className="font-medium">{clubName}</span>'s workspace exactly
				as an admin sees it, to diagnose an issue. The session is{" "}
				<span className="font-medium">read-only</span> (you can't change the
				club's data), auto-expires in 60 minutes, and is recorded in the club's
				activity log.
			</p>
			<Button type="button" size="sm" disabled={submitting} onClick={onViewAs}>
				{submitting ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<>
						<Eye className="size-4" /> View as this club
					</>
				)}
			</Button>
		</section>
	);
}

/**
 * "Act as admin" — start a read-WRITE impersonation session (#246). Unlike
 * "View as this club", this can change the club's data, so it requires a reason
 * (recorded in the club's activity feed), auto-expires in 15 minutes, and every
 * change is attributed to the acting superadmin. Danger styling throughout.
 */
function ActAsAdminPanel({
	clubId,
	clubName,
}: {
	clubId: string;
	clubName: string;
}) {
	const router = useRouter();
	const [submitting, setSubmitting] = useState(false);
	const [reason, setReason] = useState("");
	const trimmedReason = reason.trim();

	async function onActAs() {
		if (!trimmedReason) return;
		setSubmitting(true);
		try {
			await startImpersonation({
				data: { clubId, mode: "read_write", reason: trimmedReason },
			});
			await router.invalidate();
			await router.navigate({ to: "/" });
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't start the session.",
			);
			setSubmitting(false);
		}
	}

	return (
		<section className="max-w-xl space-y-3 rounded-xl border border-[var(--danger,#dc2626)]/40 bg-[var(--danger,#dc2626)]/5 p-4">
			<h2 className="text-sm font-bold text-[var(--danger-strong,#b91c1c)]">
				Act as this club's admin
			</h2>
			<p className="text-sm text-muted-foreground">
				Open <span className="font-medium">{clubName}</span>'s workspace with
				full admin powers to fix an issue.{" "}
				<span className="font-medium text-[var(--danger-strong,#b91c1c)]">
					Changes are live
				</span>{" "}
				and made in the club's data. The session auto-expires in{" "}
				<span className="font-medium">15 minutes</span>, and every change is
				recorded against your name in the club's activity log.
			</p>
			<div className="space-y-1.5">
				<Label htmlFor="act-as-reason">Reason for access (required)</Label>
				<Input
					id="act-as-reason"
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					placeholder="e.g. Fixing a corrupted agenda at the club's request"
					maxLength={500}
				/>
			</div>
			<Button
				type="button"
				size="sm"
				variant="destructive"
				disabled={submitting || !trimmedReason}
				onClick={onActAs}
			>
				{submitting ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<>
						<Pencil className="size-4" /> Act as this club's admin
					</>
				)}
			</Button>
		</section>
	);
}

function ArchivePanel({
	clubId,
	clubName,
	archivedAt,
	onChanged,
}: {
	clubId: string;
	clubName: string;
	archivedAt: Date | null;
	onChanged: () => void;
}) {
	const [submitting, setSubmitting] = useState(false);
	const isArchived = archivedAt != null;

	async function onArchive() {
		if (
			!window.confirm(
				`Archive "${clubName}"? Members and the public club pages lose access immediately. No data is deleted and you can unarchive at any time.`,
			)
		) {
			return;
		}
		setSubmitting(true);
		try {
			await archiveConsoleClub({ data: clubId });
			toast.success("Club archived.");
			onChanged();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't archive the club.",
			);
		} finally {
			setSubmitting(false);
		}
	}

	async function onUnarchive() {
		if (!window.confirm(`Unarchive "${clubName}"? Access is fully restored.`)) {
			return;
		}
		setSubmitting(true);
		try {
			await unarchiveConsoleClub({ data: clubId });
			toast.success("Club unarchived.");
			onChanged();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't unarchive the club.",
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<section className="max-w-xl space-y-3 rounded-xl border border-dashed border-[var(--line)] p-4">
			<h2 className="text-sm font-bold">
				{isArchived ? "Archived club" : "Archive club"}
			</h2>
			{isArchived ? (
				<p className="text-sm text-muted-foreground">
					This club was archived {dateFmt.format(archivedAt)}. Members and its
					public pages are blocked; all data is retained. Unarchive to restore
					full access.
				</p>
			) : (
				<p className="text-sm text-muted-foreground">
					Archiving hides the club from its members and public pages (a
					reversible soft-archive — no data is deleted and the slug stays
					reserved). Only a superadmin can undo it.
				</p>
			)}
			{isArchived ? (
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={submitting}
					onClick={onUnarchive}
				>
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<>
							<ArchiveRestore className="size-4" /> Unarchive club
						</>
					)}
				</Button>
			) : (
				<Button
					type="button"
					size="sm"
					variant="destructive"
					disabled={submitting}
					onClick={onArchive}
				>
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<>
							<Archive className="size-4" /> Archive club
						</>
					)}
				</Button>
			)}
		</section>
	);
}

function AdminPanel({
	clubId,
	name,
	email,
	linked,
	onSaved,
}: {
	clubId: string;
	name: string;
	email: string | null;
	linked: boolean;
	onSaved: () => void;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setSubmitting(true);
		try {
			await updateConsoleAdminEmail({
				data: {
					clubId,
					email: String(form.get("email") ?? "").trim(),
				},
			});
			toast.success("Admin email updated.");
			onSaved();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't update email.",
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="space-y-3">
			<div className="text-sm">
				<span className="font-medium">{name}</span>{" "}
				<span
					className={
						linked
							? "inline-block rounded-full bg-[var(--foam)] px-2 py-0.5 text-xs font-semibold text-[var(--palm)]"
							: "inline-block rounded-full bg-[var(--sand)] px-2 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
					}
				>
					{linked ? "Linked" : "Unclaimed"}
				</span>
			</div>

			{linked ? (
				<p className="text-sm text-muted-foreground">
					Current email: {email ?? "—"}. This admin has already claimed their
					account, so their email can't be changed here (that's issue #187).
				</p>
			) : (
				<form onSubmit={onSubmit} className="space-y-2">
					<p className="text-sm text-muted-foreground">
						Correct the email before this admin signs in — on their next
						magic-link sign-in it claims this person automatically.
					</p>
					<div className="space-y-1.5">
						<Label htmlFor="email">Admin email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							required
							defaultValue={email ?? ""}
						/>
					</div>
					<Button type="submit" size="sm" disabled={submitting}>
						{submitting ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Save email"
						)}
					</Button>
				</form>
			)}
		</div>
	);
}
