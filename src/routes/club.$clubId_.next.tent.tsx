// src/routes/club.$clubId_.next.tent.tsx
//
// A printable table tent of the `/club/<slug>/next` permalink (#1210): one
// Letter sheet that folds in half, the club name and a QR on BOTH faces, so it
// reads from either side of the table. The link always opens the club's next
// meeting (#1140), so a club prints this once and reuses it every week.
//
// PUBLIC like `/sign` and `/roles`: it shows the club's name and a link to a
// page that is itself public. `resolveClubOrRedirect` answers 404 for an unknown
// or archived club. The loader ships only name and slug, not the whole club row.
//
// The QR targets `/club/<slug>/next?room=1`, so the in-room strip (#913)
// survives the redirect. The origin is learned after mount (the server does not
// know which host the visitor used), as on the flyer route.
import { createFileRoute } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import {
	INK,
	MUTED,
	PAGE_H,
	PAGE_OUTER,
	PAGE_W,
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
	SHEET_H_VAR,
	SHEET_W_VAR,
} from "#/components/agenda/print-theme";
import { PublicFooter } from "#/components/public-footer";
import { resolveClubOrRedirect } from "#/lib/club-route";

/** The QR's side in CSS px: about 3.1in, easy to scan across a table. */
const TENT_QR_PX = 300;
/** Names longer than this drop a size so a typical long name stays short. */
const TENT_LONG_NAME_CHARS = 28;

/** The permalink the QR encodes. */
function tentQrTarget(origin: string, slug: string): string {
	return `${origin}/club/${slug}/next?room=1`;
}

export const Route = createFileRoute("/club/$clubId_/next/tent")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		return { club: { name: club.name, slug: club.slug } };
	},
	component: NextMeetingTentPage,
	// The <title> becomes the browser's default "Save as PDF" filename.
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? `${loaderData.club.name} — Next meeting table tent`
					: "Table tent — GavelUp",
			},
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
});

type SheetStyle = React.CSSProperties & Record<`--${string}`, string>;

/** One face of the tent: the club name, a QR, and what the QR does. */
function TentFace({
	name,
	target,
	flipped,
}: {
	name: string;
	target: string;
	flipped: boolean;
}) {
	return (
		<div
			data-testid="tent-face"
			data-flipped={flipped ? "true" : "false"}
			style={{
				height: PAGE_H / 2,
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				textAlign: "center",
				padding: "0 56px",
				gap: 18,
				// The back face is turned half a turn: folded, it faces the far
				// side of the table the right way up.
				transform: flipped ? "rotate(180deg)" : undefined,
			}}
		>
			<div
				data-testid="tent-club-name"
				style={{
					maxWidth: "100%",
					fontSize: name.length > TENT_LONG_NAME_CHARS ? 34 : 44,
					fontWeight: 700,
					lineHeight: 1.1,
					overflowWrap: "anywhere",
					display: "-webkit-box",
					WebkitBoxOrient: "vertical",
					WebkitLineClamp: 2,
					overflow: "hidden",
				}}
			>
				{name}
			</div>
			<div
				style={{
					width: TENT_QR_PX,
					height: TENT_QR_PX,
					background: "#fff",
				}}
			>
				{target ? (
					<QRCodeSVG
						data-testid="tent-qr"
						value={target}
						size={TENT_QR_PX}
						marginSize={0}
					/>
				) : null}
			</div>
			<div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15 }}>
				Scan for the next meeting
			</div>
		</div>
	);
}

function NextMeetingTentPage() {
	const { club } = Route.useLoaderData();
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const target = origin ? tentQrTarget(origin, club.slug) : "";
	const sheet: SheetStyle = {
		...PAGE_OUTER,
		width: PAGE_W,
		height: PAGE_H,
		[SHEET_W_VAR]: `${PAGE_W}px`,
		[SHEET_H_VAR]: `${PAGE_H}px`,
		display: "flex",
		flexDirection: "column",
	};

	return (
		<div>
			<PrintToolbar>
				<PrintButton />
			</PrintToolbar>
			<style>{PRINT_PAGE_CSS}</style>
			<div
				className="pgwrap"
				style={{ display: "flex", justifyContent: "center" }}
			>
				<div
					className="agenda-page"
					data-testid="next-meeting-tent"
					style={sheet}
				>
					<TentFace name={club.name} target={target} flipped />
					{/* The fold: dashed, and the one mark on the sheet that is not
					    content. */}
					<div
						aria-hidden
						data-testid="tent-fold"
						style={{
							position: "absolute",
							left: 0,
							right: 0,
							top: PAGE_H / 2 - 1,
							borderTop: `2px dashed ${MUTED}`,
							opacity: 0.6,
						}}
					/>
					<TentFace name={club.name} target={target} flipped={false} />
					<div
						style={{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: 0,
							height: 6,
							background: INK,
						}}
					/>
				</div>
			</div>
			<div className="no-print">
				<PublicFooter />
			</div>
		</div>
	);
}
