// src/routes/club.$clubId_.roles.tsx
//
// The public, standalone printable "role sheet" (#341): a generic, club-level
// one-pager listing the club's meeting roles + responsibilities. Static — no
// meeting, no assignees, no timing — so a club prints it once and reuses it.
// Pathless-escaped (`$clubId_`) so it renders OUTSIDE the club chrome, exactly
// like the sibling print/present routes, and carries the same `?chrome=none`
// clean/shareable mode.
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ClubRoleSheet,
	type RoleSheetEntry,
} from "#/components/agenda/club-role-sheet";
import {
	INK,
	MUTED,
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "#/components/agenda/print-theme";
import { PublicFooter } from "#/components/public-footer";
import { ShareLinkButton } from "#/components/share-link-button";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicClubRoles } from "#/server/role-definitions";

export const Route = createFileRoute("/club/$clubId_/roles")({
	validateSearch: (search: Record<string, unknown>): { chrome?: "none" } => ({
		// `chrome=none` = the clean shareable view: no toolbar, just the sheet.
		chrome: search.chrome === "none" ? "none" : undefined,
	}),
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// Parallel + non-fatal, matching the other public print surfaces.
		const [roles, logoMeta] = await Promise.all([
			getPublicClubRoles({ data: club.id }),
			getClubLogoMeta({ data: { clubId: club.id } }).catch(() => null),
		]);
		return {
			club,
			roles,
			logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt),
		};
	},
	component: RoleSheet,
	// The <title> becomes the browser's default "Save as PDF" filename.
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? `${loaderData.club.name} — Meeting Roles`
					: "Meeting Roles — GavelUp",
			},
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
});

/**
 * Screen-only wayfinding pill (#542, F-009): this print-styled page has no
 * header/nav, and guests arriving via shared links dead-ended on it. Mirrors
 * the `PrintToolbar` chrome, pinned top-LEFT; hidden when printing by the
 * shared `.no-print` rule in `PRINT_PAGE_CSS` (the print page-count suite
 * reproduces it in the roles fixture). Truncates so a long club name cannot
 * collide with the toolbar on a phone. Shown in `chrome=none` mode too — the
 * shared link IS that mode, and its recipients are exactly who dead-ends.
 */
const BACK_LINK_STYLE: React.CSSProperties = {
	position: "fixed",
	top: 12,
	left: 12,
	zIndex: 10,
	display: "block",
	maxWidth: "min(48vw, 320px)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	background: "#fff",
	borderRadius: 10,
	padding: "9px 14px",
	boxShadow: "0 6px 20px rgba(23,58,64,.18)",
	color: INK,
	fontSize: 13,
	fontWeight: 700,
	textDecoration: "none",
};

function RoleSheet() {
	const { chrome } = Route.useSearch();
	const { clubId: clubIdParam } = Route.useParams();
	const { club, roles, logoUrl } = Route.useLoaderData();
	const bare = chrome === "none";

	const entries: RoleSheetEntry[] = roles.map((r) => ({
		id: r.id,
		name: r.name,
		category: r.category,
		description: r.description,
	}));

	return (
		<div>
			<Link
				to="/club/$clubId"
				params={{ clubId: clubIdParam }}
				search={{ view: "roles", count: 8 }}
				className="no-print roles-back"
				style={BACK_LINK_STYLE}
			>
				← {club.name}
			</Link>
			<PrintToolbar>
				{bare ? null : (
					<ShareLinkButton
						path={`/club/${clubIdParam}/roles?chrome=none`}
						label="Copy shareable link"
					/>
				)}
				<PrintButton />
			</PrintToolbar>
			{/* The shared sheet, plus the one rule that cannot be shared: this
			    page centres its single sheet on screen. Flex defaults to a row,
			    and the agenda's .pgwrap stacks two sheets, so hoisting this into
			    PRINT_PAGE_CSS would lay those out side by side. */}
			<style>{`${PRINT_PAGE_CSS}
				@media screen {
					.pgwrap { display: flex; justify-content: center; }
					/* Inline styles can't express :hover — the pill is the page's
					   primary wayfinding control and needs pointer feedback. */
					.roles-back:hover { text-decoration: underline; }
					/* Below ~600px the pill (maxWidth 48vw, top-left) and the fixed
					   PrintToolbar (top-right) share a row and a long club name slides
					   under the toolbar card — drop the pill onto its own row there.
					   !important: top is set inline by BACK_LINK_STYLE. */
					@media (max-width: 600px) {
						.roles-back { top: 64px !important; }
					}
				}
			`}</style>
			<ClubRoleSheet
				clubName={club.name}
				clubNumber={club.clubNumber}
				roles={entries}
				logoUrl={logoUrl}
			/>
			{/* This route escapes the `/club/$clubId` shell, so it carries its own
			    disclaimer (#381). `no-print` because the printed sheet already ends
			    in ClubRoleSheet's DarkFooter, which states the same text — this is
			    the on-screen equivalent, and duplicating it on paper would waste the
			    one-pager. Colors come from the print palette rather than the themed
			    tokens: the page forces a light sage backdrop on screen in BOTH themes
			    (see the <style> above), where the dark-mode `--sea-ink-soft` would be
			    unreadable. */}
			<PublicFooter
				className="no-print"
				style={{ color: MUTED, borderColor: `${INK}24` }}
			/>
		</div>
	);
}
