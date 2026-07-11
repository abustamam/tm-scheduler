import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { listConsoleClubs, provisionClub } from "#/server/onboarding";

export const Route = createFileRoute("/_authed/superadmin/")({
	loader: () => listConsoleClubs(),
	component: SuperadminConsole,
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
});

function SuperadminConsole() {
	const clubs = Route.useLoaderData();
	const router = useRouter();

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Superadmin console
				</h1>
				<p className="text-sm text-muted-foreground">
					Provision a new club (club + standard role template + first admin) and
					review every club on the platform. First admins are linked to a
					sign-in account automatically on their next magic-link sign-in.
				</p>
			</div>

			<CreateClubForm onCreated={() => router.invalidate()} />

			<div className="space-y-3">
				<h2 className="text-sm font-bold">All clubs ({clubs.length})</h2>
				{clubs.length === 0 ? (
					<p className="text-sm text-muted-foreground">No clubs yet.</p>
				) : (
					<div className="overflow-x-auto rounded-xl border border-[var(--line)]">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-[var(--line)] bg-[var(--surface-strong)] text-left text-[12px] font-semibold text-[var(--sea-ink-soft)]">
									<th className="px-4 py-2.5">Club</th>
									<th className="px-4 py-2.5">Number</th>
									<th className="px-4 py-2.5">Members</th>
									<th className="px-4 py-2.5">First admin</th>
									<th className="px-4 py-2.5">Created</th>
								</tr>
							</thead>
							<tbody>
								{clubs.map((club) => (
									<tr
										key={club.clubId}
										className="border-b border-[var(--line)] last:border-0"
									>
										<td className="px-4 py-2.5 font-medium">
											<Link
												to="/superadmin/$clubId"
												params={{ clubId: club.clubId }}
												className="text-[var(--palm)] underline-offset-2 hover:underline"
											>
												{club.name}
											</Link>
										</td>
										<td className="px-4 py-2.5 tabular-nums">
											{club.clubNumber ?? "—"}
										</td>
										<td className="px-4 py-2.5 tabular-nums">
											{club.memberCount}
										</td>
										<td className="px-4 py-2.5">
											{club.firstAdmin ? (
												<span>
													{club.firstAdmin.name}
													{club.firstAdmin.email ? (
														<span className="text-[var(--sea-ink-soft)]">
															{" "}
															· {club.firstAdmin.email}
														</span>
													) : null}{" "}
													<LinkBadge linked={club.firstAdmin.linked} />
												</span>
											) : (
												<span className="text-[var(--sea-ink-soft)]">None</span>
											)}
										</td>
										<td className="px-4 py-2.5 whitespace-nowrap text-[var(--sea-ink-soft)]">
											{dateFmt.format(new Date(club.createdAt))}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</PageContainer>
	);
}

function LinkBadge({ linked }: { linked: boolean }) {
	return (
		<span
			className={
				linked
					? "inline-block rounded-full bg-[var(--foam)] px-2 py-0.5 text-[11px] font-semibold text-[var(--palm)]"
					: "inline-block rounded-full bg-[var(--sand)] px-2 py-0.5 text-[11px] font-semibold text-[var(--sea-ink-soft)]"
			}
		>
			{linked ? "Linked" : "Unclaimed"}
		</span>
	);
}

function CreateClubForm({ onCreated }: { onCreated: () => void }) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		setSubmitting(true);
		try {
			const res = await provisionClub({
				data: {
					clubName: String(form.get("clubName") ?? "").trim(),
					clubNumber: String(form.get("clubNumber") ?? "").trim(),
					adminName: String(form.get("adminName") ?? "").trim(),
					adminEmail: String(form.get("adminEmail") ?? "").trim(),
				},
			});
			toast.success(`Created club (slug: ${res.slug}).`);
			el.reset();
			onCreated();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't create club.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form
			onSubmit={onSubmit}
			className="space-y-3 rounded-xl border border-dashed border-[var(--line)] bg-[var(--foam)] p-4"
		>
			<h2 className="text-sm font-bold">Create a club</h2>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="clubName">Club name</Label>
					<Input
						id="clubName"
						name="clubName"
						required
						placeholder="e.g. Downtown Speakers"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="clubNumber">Club number</Label>
					<Input
						id="clubNumber"
						name="clubNumber"
						required
						placeholder="e.g. 1234567"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="adminName">First admin name</Label>
					<Input
						id="adminName"
						name="adminName"
						required
						placeholder="e.g. Jamie Rivera"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="adminEmail">First admin email</Label>
					<Input
						id="adminEmail"
						name="adminEmail"
						type="email"
						required
						placeholder="jamie@example.com"
					/>
				</div>
			</div>
			<div className="flex items-center">
				<Button
					type="submit"
					size="sm"
					disabled={submitting}
					className="ml-auto"
				>
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<>
							<Plus className="size-4" /> Create club
						</>
					)}
				</Button>
			</div>
		</form>
	);
}
