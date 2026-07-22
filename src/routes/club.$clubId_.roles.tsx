// src/routes/club.$clubId_.roles.tsx
//
// The public, standalone printable "role sheet" (#341): a generic, club-level
// one-pager listing the club's meeting roles + responsibilities. Static — no
// meeting, no assignees, no timing — so a club prints it once and reuses it.
// Pathless-escaped (`$clubId_`) so it renders OUTSIDE the club chrome, exactly
// like the sibling print/present routes, and carries the same `?chrome=none`
// clean/shareable mode.
import { createFileRoute } from "@tanstack/react-router";
import {
	ClubRoleSheet,
	type RoleSheetEntry,
} from "#/components/agenda/club-role-sheet";
import { ShareLinkButton } from "#/components/share-link-button";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getPublicClubRoles } from "#/server/role-definitions";

export const Route = createFileRoute("/club/$clubId_/roles")({
	validateSearch: (search: Record<string, unknown>): { chrome?: "none" } => ({
		// `chrome=none` = the clean shareable view: no toolbar, just the sheet.
		chrome: search.chrome === "none" ? "none" : undefined,
	}),
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const roles = await getPublicClubRoles({ data: club.id });
		return { club, roles };
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

function RoleSheet() {
	const { chrome } = Route.useSearch();
	const { clubId: clubIdParam } = Route.useParams();
	const { club, roles } = Route.useLoaderData();
	const bare = chrome === "none";

	const entries: RoleSheetEntry[] = roles.map((r) => ({
		id: r.id,
		name: r.name,
		category: r.category,
		description: r.description,
	}));

	return (
		<div>
			<div className="no-print" style={toolbarStyle}>
				{bare ? null : (
					<ShareLinkButton
						path={`/club/${clubIdParam}/roles?chrome=none`}
						label="Copy shareable link"
					/>
				)}
				<button
					type="button"
					onClick={() => window.print()}
					style={printBtnStyle}
				>
					Print
				</button>
			</div>
			<style>{`
				@media screen { body { background: #d8e6dd; } }
				.pgwrap { padding: 28px 0; display: flex; justify-content: center; }
				@media print {
					.no-print { display: none !important; }
					body { background: #fff; }
					.pgwrap { padding: 0 !important; }
					.agenda-page { box-shadow: none !important; break-after: page; break-inside: avoid; }
					.agenda-page:last-child { break-after: auto; }
					@page { size: letter portrait; margin: 0; }
				}
			`}</style>
			<ClubRoleSheet
				clubName={club.name}
				clubNumber={club.clubNumber}
				roles={entries}
			/>
		</div>
	);
}

const toolbarStyle: React.CSSProperties = {
	position: "fixed",
	top: 12,
	right: 12,
	zIndex: 10,
	display: "flex",
	gap: 8,
	alignItems: "center",
	background: "#fff",
	borderRadius: 10,
	padding: 6,
	boxShadow: "0 6px 20px rgba(23,58,64,.18)",
};

const printBtnStyle: React.CSSProperties = {
	padding: "6px 14px",
	background: "#328f97",
	color: "#fff",
	border: 0,
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	cursor: "pointer",
};
