import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	getConsoleClubDetail,
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
		</PageContainer>
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
