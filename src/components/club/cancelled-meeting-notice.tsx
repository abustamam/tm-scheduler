// What a cancelled meeting looks like on the surfaces a link can land on
// (#1057; the maintainer's decision on #1084: "people should be able to see a
// cancelled meeting in a read-only fashion, and it should clearly say it is
// cancelled").
//
// Three shapes, because the surfaces are three kinds:
//
//  - `CancelledMeetingNotice`: the member, guest and anonymous pages a link
//    lands on (the ballot, the feedback page, the personal duty editors). It
//    REPLACES the page's interactive content, so nothing there can be tapped,
//    and links to the meeting itself, where the banner is.
//  - `CancelledArtifactMarker`: the officer artifacts' screen toolbar (print,
//    Word of the Day poster, flyer). Screen only, like the toolbar it sits in.
//  - `CancelledWatermark`: the same artifacts on PAPER, and the projected deck.
//    `position: fixed`, so it can never change a sheet's height (every print
//    geometry gate measures that) and Chrome repeats it on each printed page.
//
// The sentence is `MEETING_CANCELLED_MESSAGE`, the one every refused write on a
// cancelled meeting says, so a visitor reads the same words everywhere.

import { Link } from "@tanstack/react-router";
import { CalendarX } from "lucide-react";
import type React from "react";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";

/**
 * The read-only notice for a member, guest or anonymous page. `meetingId` must
 * be the meeting's UUID: a bare-date key reaches a cancelled meeting only when
 * nothing live shares its day, and the uuid always does.
 */
export function CancelledMeetingNotice({
	clubId,
	meetingId,
	detail = "Everyone keeps their role. Nothing here can be changed unless an officer restores the meeting.",
}: {
	/** The club's URL segment (slug or uuid). */
	clubId: string;
	/** The meeting's UUID. */
	meetingId: string;
	/** What this page would have offered, in one sentence. */
	detail?: string;
}) {
	// `<output>`, the element for a live status, as the ballot's own loading line
	// uses; `block`, since it is inline by default.
	return (
		<output
			data-testid="cancelled-meeting-notice"
			className="mx-auto block w-full max-w-md space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-5 text-sm"
		>
			<p className="flex items-center gap-2 font-semibold">
				<CalendarX className="size-4 shrink-0 text-destructive" aria-hidden />
				{MEETING_CANCELLED_MESSAGE}
			</p>
			<p className="text-muted-foreground">{detail}</p>
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId, meetingId }}
				className="font-medium text-primary underline-offset-4 hover:underline"
			>
				See the meeting
			</Link>
		</output>
	);
}

/** Dark red on pale red: 8.6:1, inside the toolbar's 4.5:1 floor (#998). */
const MARKER_STYLE: React.CSSProperties = {
	padding: "6px 12px",
	background: "#fdecec",
	color: "#7f1d1d",
	border: "1px solid #f2b8b5",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	whiteSpace: "nowrap",
};

/** The officer artifacts' toolbar marker: says so before anything is printed. */
export function CancelledArtifactMarker() {
	return (
		<output data-testid="cancelled-artifact-marker" style={MARKER_STYLE}>
			Cancelled — this meeting is not happening
		</output>
	);
}

const WATERMARK_STYLE: React.CSSProperties = {
	position: "fixed",
	inset: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	pointerEvents: "none",
	zIndex: 50,
};

const WATERMARK_TEXT_STYLE: React.CSSProperties = {
	transform: "rotate(-18deg)",
	border: "8px solid rgba(185, 28, 28, 0.55)",
	borderRadius: 16,
	padding: "8px 32px",
	color: "rgba(185, 28, 28, 0.55)",
	fontSize: 120,
	fontWeight: 800,
	letterSpacing: "0.08em",
	lineHeight: 1,
	// Prints in colour where the browser would otherwise drop it to save ink.
	WebkitPrintColorAdjust: "exact",
	printColorAdjust: "exact",
};

/**
 * "CANCELLED" across the page, on screen and on paper. Fixed, never in flow, so
 * it cannot move or resize anything a layout measures. `aria-hidden`: the
 * toolbar marker (or the deck's own chrome) carries the words for a screen
 * reader; this is the copy a sheet of paper keeps.
 */
export function CancelledWatermark() {
	return (
		<div aria-hidden data-testid="cancelled-watermark" style={WATERMARK_STYLE}>
			<span style={WATERMARK_TEXT_STYLE}>CANCELLED</span>
		</div>
	);
}
