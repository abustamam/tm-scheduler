// src/routes/club.$clubId_.meeting.$meetingId.print.tsx
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	type AgendaExplainer,
	type AgendaLayout,
	type AgendaRoleEntry,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import {
	INK,
	MUTED,
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "#/components/agenda/print-theme";
import { ShareLinkButton } from "#/components/share-link-button";
import { buildRosterEntries } from "#/lib/agenda";
import {
	applyFlex,
	buildRunOfShow,
	expandRunSheet,
	flexBannerMessage,
} from "#/lib/agenda-runsheet";
import { buildAgendaSharePath } from "#/lib/agenda-share-url";
import { buildTimeline } from "#/lib/agenda-timing";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { meetingPdfBasename } from "#/lib/pdf-filename";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";

// One-page layouts lead: we prefer single-page agendas, and both one-pagers now
// carry color-coded timing. The two-page Timing/Spacious layouts stay available.
const LAYOUTS: { id: AgendaLayout; label: string }[] = [
	{ id: "grid", label: "Grid" },
	{ id: "editorial", label: "Editorial" },
	{ id: "timing", label: "Timing" },
	{ id: "spacious", label: "Spacious" },
];
const LAYOUT_IDS = LAYOUTS.map((l) => l.id);

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/print")(
	{
		validateSearch: (
			search: Record<string, unknown>,
		): { layout: AgendaLayout; chrome?: "none" } => {
			const l = search.layout;
			return {
				layout: LAYOUT_IDS.includes(l as AgendaLayout)
					? (l as AgendaLayout)
					: "grid",
				// `chrome=none` is the clean shareable view (#334): no layout selector,
				// offline badge, or timing banner — just the agenda + a Print button.
				chrome: search.chrome === "none" ? "none" : undefined,
			};
		},
		loader: async ({ params, location }) => {
			const club = await resolveClubOrRedirect(params.clubId, location);
			// An unknown meeting key is a 404, not a 500: `getPublicMeetingByKey`
			// signals it by throwing, and without this the visitor gets the error
			// boundary instead of the router's not-found page. Same translation the
			// canonical meeting route does. The logo lookup is independent of the
			// meeting fetch — both need only `club.id` — so they run in parallel.
			const [data, logoMeta] = await Promise.all([
				getPublicMeetingByKey({
					data: { clubId: club.id, key: params.meetingId },
				}).catch((err) => {
					if (isMeetingNotFoundError(err)) throw notFound();
					throw err;
				}),
				// Degrade, never take the page down. The logo is decorative and
				// this fetch runs in the same Promise.all as the meeting itself,
				// so an unhandled rejection here would fail the whole printed
				// agenda — the one page an officer needs the morning of a
				// meeting — over a missing image.
				getClubLogoMeta({ data: { clubId: club.id } }).catch(() => null),
			]);
			if (data.meeting.clubId !== club.id) throw notFound();
			return { ...data, logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt) };
		},
		component: PrintAgenda,
		// The <title> becomes the browser's default "Save as PDF" filename, so we
		// name it after the club + meeting date (e.g. Downtown-Toastmasters-meeting-
		// 2026-07-22.pdf). loaderData is absent during the pending state → fallback.
		head: ({ loaderData }) => ({
			meta: [
				{
					title: loaderData
						? meetingPdfBasename(
								loaderData.clubName,
								loaderData.meeting.scheduledAt,
								loaderData.timezone,
							)
						: "Agenda — GavelUp",
				},
				{ name: "robots", content: "noindex, nofollow" },
			],
		}),
	},
);

/** "6:45 – 7:45 PM": drop the meridiem from the start when it matches the end's. */
function timeRange(startsAt: Date, endsAt: Date, timeZone: string): string {
	const fmt = (d: Date) =>
		new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
			timeZone,
		}).format(d);
	const start = fmt(startsAt);
	const end = fmt(endsAt);
	const meridiem = (s: string) => s.match(/\s?([AP]M)$/i)?.[1]?.toUpperCase();
	const startShort =
		meridiem(start) && meridiem(start) === meridiem(end)
			? start.replace(/\s?[AP]M$/i, "")
			: start;
	return `${startShort} – ${end}`;
}

function PrintAgenda() {
	const { layout, chrome } = Route.useSearch();
	const { clubId: clubIdParam, meetingId } = Route.useParams();
	// Clean shareable view: hide the editing chrome, keep only the Print button.
	const bare = chrome === "none";
	// The absolute ballot URL is derived in the browser (#510), same as the
	// present route's own QR and the guest-book QR on the VP Membership page:
	// this route renders on the server first, where `window` doesn't exist, and
	// a QR baked from a relative path is not a URL a phone's camera can resolve.
	// Blank until the effect fires, which is why `DarkFooter` treats an empty
	// `ballotUrl` as "no QR yet" rather than rendering one that can't scan.
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const ballotUrl = origin
		? `${origin}/club/${clubIdParam}/meeting/${meetingId}/vote`
		: "";
	const {
		meeting,
		slots,
		timezone,
		clubName,
		clubNumber,
		clubDistrict,
		clubMission,
		clubMeetingSchedule,
		meetingNumber,
		officers,
		geIntroducesFunctionaries,
		logoUrl,
	} = Route.useLoaderData();

	const runRows = expandRunSheet(
		slots,
		buildRunOfShow({ geIntroducesFunctionaries }),
	);
	const flex = applyFlex(runRows, meeting.lengthMinutes);
	// null when the agenda fits. The copy is conditional on a flex row actually
	// existing (#395) — see `flexBannerMessage`.
	const flexBanner = flexBannerMessage(flex);
	const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);

	// Meeting end = start + the flexed (projected) run-of-show length.
	const startsAt = new Date(meeting.scheduledAt);
	const endsAt = new Date(startsAt.getTime() + flex.projectedMinutes * 60_000);

	const dateLong = new Intl.DateTimeFormat(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	}).format(startsAt);
	const dateShort = new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	})
		.format(startsAt)
		.replace(",", " ·");

	// Meeting-roles roster: numbered, with assignee or open. Speakers are
	// interleaved with their paired evaluators so each pair shares a row in the
	// two-column print layout.
	const roles: AgendaRoleEntry[] = buildRosterEntries(slots);

	// Plain-language role explainers (first description seen per role name).
	const seen = new Set<string>();
	const explainers: AgendaExplainer[] = [];
	for (const s of slots) {
		if (s.description && !seen.has(s.roleName)) {
			seen.add(s.roleName);
			explainers.push({ role: s.roleName, description: s.description });
		}
	}

	const header = {
		clubName,
		logoUrl,
		clubNumber,
		district: clubDistrict,
		mission: clubMission,
		meetingSchedule: clubMeetingSchedule,
		dateLong,
		dateShort,
		timeRange: timeRange(startsAt, endsAt, timezone),
		theme: meeting.theme,
		wordOfTheDay: meeting.wordOfTheDay,
		location: meeting.location,
		announcements: meeting.reminders,
		meetingNumber,
	};

	return (
		<div>
			<PrintToolbar>
				{bare ? null : (
					<div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
						{LAYOUTS.map((l) => (
							<Link
								key={l.id}
								to="/club/$clubId/meeting/$meetingId/print"
								params={{ clubId: clubIdParam, meetingId }}
								search={{ layout: l.id }}
								style={{
									...tabStyle,
									...(l.id === layout ? tabActiveStyle : null),
								}}
							>
								{l.label}
							</Link>
						))}
					</div>
				)}
				{bare ? null : (
					<ShareLinkButton
						path={buildAgendaSharePath(clubIdParam, meetingId, layout)}
						label="Copy shareable link"
					/>
				)}
				<PrintButton />
				{/* The "Available offline" pill lives in the toolbar, not over the
				    agenda (#361). Mounted here it also gives the genuinely-offline
				    banner — which pins itself top-center — the toolbar's stacking
				    context, so it still paints above the sheet.

				    Last, not first: the toolbar is right-anchored and wraps, so the
				    trailing items are the ones pushed to a second row on a narrow
				    phone. This pill is passive reassurance and the cheapest thing to
				    demote; the layout tabs and Print are why the toolbar exists. */}
				{bare ? null : <OfflineBadge id={meetingId} />}
			</PrintToolbar>
			{!bare && flexBanner ? (
				<div
					className="no-print"
					style={{
						margin: "8px auto 0",
						maxWidth: 640,
						padding: "8px 12px",
						borderRadius: 8,
						fontSize: 13,
						textAlign: "center",
						background: flex.status === "over" ? "#fbeaea" : "#eef2f7",
						color: flex.status === "over" ? "#8a1c1c" : "#41546b",
					}}
				>
					{flexBanner}
				</div>
			) : null}
			<style>{PRINT_PAGE_CSS}</style>
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				roles={roles}
				officers={officers}
				explainers={explainers}
				rows={rows}
				ballotUrl={ballotUrl}
			/>
		</div>
	);
}

const tabStyle: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 600,
	color: MUTED,
	textDecoration: "none",
};

const tabActiveStyle: React.CSSProperties = {
	background: INK,
	color: "#fff",
};
