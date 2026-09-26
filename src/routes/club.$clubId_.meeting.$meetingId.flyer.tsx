// src/routes/club.$clubId_.meeting.$meetingId.flyer.tsx
//
// The meeting's marketing flyer (#931): a Letter poster for printing or saving
// as PDF, and a square 1080x1080 image for posting in a group chat or on
// social media (`?layout=square`).
//
// PUBLIC, like `/word` — a flyer shows only what the public meeting page
// already shows, and its QR opens that page. Archived and unknown clubs 404:
// `resolveClubOrRedirect` refuses an archived club, and `loadPublicFlyer`
// resolves the key through `resolvePublicMeetingKey` (archive-gated) beneath
// the server fn. The `$clubId_` escape
// renders it standalone, outside the club shell.
//
// The loader's payload is narrowed to `FLYER_MEETING_FIELDS` before it is
// dehydrated into the page (#754's lesson: what is SHIPPED, not only what is
// painted). The #731/#754 guard runs this loader and sweeps this file.

import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FlyerSquareExport } from "#/components/agenda/flyer-square-export";
import { MeetingFlyerLetter } from "#/components/agenda/meeting-flyer";
import {
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "#/components/agenda/print-theme";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	buildFlyerContent,
	projectFlyerMeeting,
	promoValues,
} from "#/lib/promo-template";
import { getPublicFlyer } from "#/server/promo";

type FlyerLayout = "letter" | "square";

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/flyer")(
	{
		validateSearch: (
			search: Record<string, unknown>,
		): { layout: FlyerLayout } => ({
			layout: search.layout === "square" ? "square" : "letter",
		}),
		loader: async ({ params, location }) => {
			const club = await resolveClubOrRedirect(params.clubId, location);
			// Null for an unknown key or an archived club; a thrown "Meeting not
			// found." is translated the same way every meeting sub-route does.
			const data = await getPublicFlyer({
				data: { clubId: club.id, key: params.meetingId },
			}).catch((err) => {
				if (isMeetingNotFoundError(err)) throw notFound();
				throw err;
			});
			if (!data) throw notFound();
			return {
				club: {
					name: data.club.name,
					slug: data.club.slug,
					timezone: data.club.timezone,
				},
				template: data.template,
				meeting: projectFlyerMeeting(data.meeting),
				logoUrl: data.logoUrl,
			};
		},
		component: FlyerPage,
		notFoundComponent: FlyerNotFound,
		head: ({ loaderData }) => ({
			meta: [
				{
					title: loaderData
						? `${loaderData.club.slug}-flyer-${loaderData.meeting.urlKey}`
						: "Flyer — GavelUp",
				},
				{ name: "robots", content: "noindex, nofollow" },
			],
		}),
	},
);

const tabStyle = (active: boolean): React.CSSProperties => ({
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	textDecoration: "none",
	color: active ? "#fff" : "#173a40",
	background: active ? "#173a40" : "transparent",
});

function FlyerPage() {
	const { clubId, meetingId } = Route.useParams();
	const { layout } = Route.useSearch();
	const { club, template, meeting, logoUrl } = Route.useLoaderData();
	// The QR and the links need an absolute URL, and the server does not know
	// the origin the visitor used — learned after mount, like `/print`.
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const content = buildFlyerContent(
		template,
		promoValues(club, meeting, origin),
	);

	return (
		<div>
			<PrintToolbar>
				<Link
					to="/club/$clubId/meeting/$meetingId/flyer"
					params={{ clubId, meetingId }}
					search={{ layout: "letter" }}
					style={tabStyle(layout === "letter")}
				>
					Poster
				</Link>
				<Link
					to="/club/$clubId/meeting/$meetingId/flyer"
					params={{ clubId, meetingId }}
					search={{ layout: "square" }}
					style={tabStyle(layout === "square")}
				>
					Square image
				</Link>
				{layout === "letter" ? <PrintButton /> : null}
			</PrintToolbar>
			<style>{PRINT_PAGE_CSS}</style>
			{layout === "letter" ? (
				<div
					className="pgwrap"
					style={{ display: "flex", justifyContent: "center" }}
				>
					<MeetingFlyerLetter
						content={content}
						clubName={club.name}
						logoUrl={logoUrl}
					/>
				</div>
			) : (
				<div
					className="pgwrap"
					style={{ display: "flex", justifyContent: "center" }}
				>
					<div style={{ background: "#fff", padding: 16, borderRadius: 8 }}>
						<FlyerSquareExport
							content={content}
							clubName={club.name}
							logoUrl={logoUrl}
							filename={`${club.slug}-flyer-${meeting.urlKey}.png`}
							previewWidth={540}
						/>
					</div>
				</div>
			)}
			{/* Screen only: the poster carries the disclaimer in its own dark
			    footer, and printing this too would add a second sheet. */}
			<div className="no-print">
				<PublicFooter />
			</div>
		</div>
	);
}

/** A key naming no meeting: the same page every meeting sub-route shows. */
function FlyerNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
