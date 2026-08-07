// src/routes/club.$clubId.roles-guide.tsx
//
// The READABLE, in-chrome view of a club's meeting roles (#318) — where the
// "Meeting roles" link on the public club page now lands.
//
// Deliberately a sibling of, not a replacement for, `/club/$clubId_/roles`.
// That route is the PRINT artifact (#341): it escapes the club chrome via the
// `$clubId_` pathless escape, forces a light sage backdrop in both themes,
// pins a Print / Copy-shareable-link toolbar, lays out with `FitPage` to fit
// one sheet of paper, and carries no link back to the club. All correct for
// something you hand out on paper, all wrong for a guest who is browsing. This
// route keeps the club header, the theme, and the way back.
//
// One data source for both: `getPublicClubRoles` (enabled-filtered) grouped by
// the shared `groupRolesByCategory`, so the page a guest reads and the sheet
// the club prints cannot drift in order or labelling.
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Printer } from "lucide-react";
import { groupRolesByCategory } from "#/lib/role-categories";
import { getPublicClubRoles } from "#/server/role-definitions";

export const Route = createFileRoute("/club/$clubId/roles-guide")({
	loader: ({ context }) => getPublicClubRoles({ data: context.clubUuid }),
	component: RolesGuide,
	head: ({ match }) => ({
		meta: [{ title: `Meeting roles — ${match.context.clubName}` }],
	}),
});

function RolesGuide() {
	const { clubId } = Route.useParams();
	const { clubName } = Route.useRouteContext();
	const roles = Route.useLoaderData();
	const byCategory = groupRolesByCategory(roles);

	return (
		<div className="mx-auto w-full max-w-public space-y-6 p-4 pb-8 md:p-6">
			<div className="pt-2">
				<Link
					to="/club/$clubId"
					params={{ clubId }}
					search={{ view: "roles", count: 8 }}
					className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground no-underline hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" aria-hidden />
					Back to {clubName}
				</Link>
				<h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">
					Meeting roles
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Every meeting is run by its members. These are the roles {clubName}{" "}
					fills, and what each one does.
				</p>
			</div>

			{byCategory.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					This club hasn't set up its meeting roles yet.
				</p>
			) : (
				byCategory.map((group) => (
					<section key={group.category} className="space-y-2">
						<h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
							{group.label}
						</h2>
						<ul className="divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-card">
							{group.roles.map((r) => (
								<li key={r.id} className="p-4">
									<h3 className="font-medium text-foreground text-sm">
										{r.name}
									</h3>
									{r.description ? (
										<p className="mt-1 text-sm text-muted-foreground">
											{r.description}
										</p>
									) : null}
								</li>
							))}
						</ul>
					</section>
				))
			)}

			{/* The printable one-pager, for a club that wants to hand these out.
			    Full page load (not a <Link>): the target escapes this shell. */}
			<a
				href={`/club/${clubId}/roles`}
				className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--lagoon-deep)] no-underline hover:underline"
			>
				<Printer className="size-3.5" aria-hidden />
				Printable version
			</a>
		</div>
	);
}
