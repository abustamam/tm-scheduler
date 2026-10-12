// src/routes/club.$clubId_.sign.tsx
//
// The public, standalone printable MEETING sign (#1167): one letter-LANDSCAPE
// sheet a club tapes up on the way to the room. Club-level and meeting-agnostic,
// like the sibling `/roles` page, and pathless-escaped (`$clubId_`) so it
// renders OUTSIDE the club chrome. It shows nothing beyond the club's name, so
// it is public like `/roles`.
//
// Landscape, so it serves `printPageCss("landscape")` and centres its 1056px
// sheet with an inline style on the wrapper, the way the Word poster route does
// (not the portrait `SCREEN_FIT_CSS` path; see `printPageCss`'s docblock).
import { createFileRoute, Link } from "@tanstack/react-router";
import { MeetingSign } from "#/components/agenda/meeting-sign";
import {
	INK,
	MUTED,
	PrintButton,
	PrintToolbar,
	printPageCss,
} from "#/components/agenda/print-theme";
import {
	AGENDA_TAB_ACTIVE_STYLE,
	AGENDA_TAB_STYLE,
} from "#/components/agenda/print-toolbar-styles";
import { PublicFooter } from "#/components/public-footer";
import { resolveClubOrRedirect } from "#/lib/club-route";

type SignSearch = { arrow?: "left" | "right"; chrome?: "none" };

const TABS = [
	{ label: "No arrow", arrow: undefined },
	{ label: "Arrow left", arrow: "left" },
	{ label: "Arrow right", arrow: "right" },
] as const;

export const Route = createFileRoute("/club/$clubId_/sign")({
	validateSearch: (search: Record<string, unknown>): SignSearch => ({
		// Anything else (`up`, `""`, an array) is the no-arrow sign.
		arrow:
			search.arrow === "left" || search.arrow === "right"
				? search.arrow
				: undefined,
		// `chrome=none` = the clean shareable view: no toolbar, just the sheet.
		chrome: search.chrome === "none" ? "none" : undefined,
	}),
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		return { club };
	},
	component: MeetingSignPage,
	// The <title> becomes the browser's default "Save as PDF" filename.
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? `${loaderData.club.name} — Meeting sign`
					: "Meeting sign — GavelUp",
			},
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
});

function MeetingSignPage() {
	const { arrow, chrome } = Route.useSearch();
	const { clubId: clubIdParam } = Route.useParams();
	const { club } = Route.useLoaderData();
	const bare = chrome === "none";
	const current = arrow ?? undefined;

	return (
		<div>
			{bare ? null : (
				<PrintToolbar>
					{TABS.map((tab) => (
						<Link
							key={tab.label}
							to="/club/$clubId/sign"
							params={{ clubId: clubIdParam }}
							search={tab.arrow ? { arrow: tab.arrow } : {}}
							style={{
								...AGENDA_TAB_STYLE,
								...(tab.arrow === current ? AGENDA_TAB_ACTIVE_STYLE : null),
							}}
						>
							{tab.label}
						</Link>
					))}
					<PrintButton />
				</PrintToolbar>
			)}
			<style>{printPageCss("landscape")}</style>
			{/* The landscape sheet is 1056px wide, wider than most phone and some
			    laptop viewports, so on SCREEN this leaves it flush left and the page
			    scrolls sideways. Printing is unaffected: `@page` is 1056px too. */}
			<div
				className="pgwrap"
				style={{ display: "flex", justifyContent: "center" }}
			>
				<MeetingSign clubName={club.name} arrow={arrow ?? null} />
			</div>
			{/* This route escapes the club shell, so it carries its own disclaimer
			    (#381). `no-print`: the sign is a sheet for a wall. */}
			<PublicFooter
				className="no-print"
				style={{ color: MUTED, borderColor: `${INK}24` }}
			/>
		</div>
	);
}
