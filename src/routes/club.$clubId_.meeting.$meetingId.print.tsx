// src/routes/club.$clubId_.meeting.$meetingId.print.tsx

import {
	createFileRoute,
	Link,
	notFound,
	redirect,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	type AgendaExplainer,
	type AgendaLayout,
	type AgendaRoleEntry,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import {
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "#/components/agenda/print-theme";
import {
	AGENDA_TAB_ACTIVE_STYLE,
	AGENDA_TAB_STYLE,
} from "#/components/agenda/print-toolbar-styles";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { ShareLinkButton } from "#/components/share-link-button";
import { buildRosterEntries } from "#/lib/agenda";
import {
	AGENDA_LAYOUT_LABELS,
	AGENDA_LAYOUTS,
	CLUB_DEFAULT_LABEL,
	isAgendaLayout,
} from "#/lib/agenda-layouts";
import {
	applyFlex,
	flexBannerMessage,
	resolveAgendaRows,
} from "#/lib/agenda-runsheet";
import { buildAgendaSharePath } from "#/lib/agenda-share-url";
import { buildTimeline } from "#/lib/agenda-timing";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { APP_LOCALE } from "#/lib/format";
import { inRoomMeetingPayload } from "#/lib/in-room-meeting-payload";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { meetingHubUrlFor } from "#/lib/meeting-hub";
import { meetingPdfBasename } from "#/lib/pdf-filename";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";

// One-page layouts lead: we prefer single-page agendas, and both one-pagers now
// carry color-coded timing. The two-page Timing/Spacious layouts stay available.
// Built from the one list (#1069), which owns that order.
export const LAYOUTS: { id: AgendaLayout; label: string }[] =
	AGENDA_LAYOUTS.map((id) => ({ id, label: AGENDA_LAYOUT_LABELS[id] }));

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/print")(
	{
		validateSearch: (
			search: Record<string, unknown>,
		): { layout?: AgendaLayout; chrome?: "none" } => ({
			// No default here (#1069). A missing, empty or unknown layout is
			// `undefined`, and the LOADER redirects it to the club's own default,
			// which only the loader can know. Defaulting here is what hard-coded
			// every print to Grid.
			layout: isAgendaLayout(search.layout) ? search.layout : undefined,
			// `chrome=none` is the clean shareable view (#334): no layout selector,
			// offline badge, or timing banner — just the agenda + a Print button.
			chrome: search.chrome === "none" ? "none" : undefined,
		}),
		// NO `loaderDeps`, deliberately (#1069 review). TanStack builds a match's
		// id from the route, the path AND `JSON.stringify(loaderDeps)`, and SSR
		// hydration finds the server's data by that id. Offline, the service
		// worker answers a bare `/…/print` with the page it cached for
		// `?layout=X` (its `ignoreSearch` fallback): a dep that differs between
		// the two URLs gives the client a match the HTML has no data for, so the
		// loader re-runs, needs the network, and the officer gets the error
		// boundary instead of the agenda (#362). Search therefore stays out of
		// the match id, and the redirect below reads `location.search`.
		loader: async ({ params, location }) => {
			const club = await resolveClubOrRedirect(params.clubId, location);
			// The RAW parsed search, not the validated one: the loader is not
			// handed that without `loaderDeps`. So the layout is re-checked here.
			const search = (location.search ?? {}) as Record<string, unknown>;
			const printedLayout = isAgendaLayout(search.layout)
				? search.layout
				: undefined;
			// No layout named ⇒ 307 to the club's default (#1069), so every
			// rendered print page carries an explicit `?layout=`. The service
			// worker depends on that: it primes a bare `/…/print`, follows this
			// redirect and caches the page under the FINAL url (`public/sw.js`).
			// After the club resolves, so an archived or unknown club is still a
			// 404 rather than a redirect to one. The target is re-checked so a
			// value the column should never hold cannot become a redirect loop.
			if (printedLayout === undefined) {
				throw redirect({
					to: "/club/$clubId/meeting/$meetingId/print",
					params: { clubId: params.clubId, meetingId: params.meetingId },
					search: {
						layout: isAgendaLayout(club.defaultPrintLayout)
							? club.defaultPrintLayout
							: "grid",
						chrome: search.chrome === "none" ? "none" : undefined,
					},
				});
			}
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
			// Whatever this returns is DEHYDRATED into the served document, so the
			// projection is the withholding — not what the layouts below choose to
			// draw (#754). `inRoomMeetingPayload` names the meeting columns a
			// printed sheet may carry and drops the rest; its docblock says why an
			// allowlist rather than a delete.
			return {
				...inRoomMeetingPayload(data),
				logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt),
				// So the toolbar can mark the club's default tab (#1069).
				defaultPrintLayout: club.defaultPrintLayout,
				// The layout this payload was RENDERED for. Read only when the URL
				// names none, which is the offline case above: the cached HTML
				// shows this layout, so drawing it is what hydrates cleanly.
				printedLayout,
			};
		},
		component: PrintAgenda,
		notFoundComponent: PrintNotFound,
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
		new Intl.DateTimeFormat(APP_LOCALE, {
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
	const { layout: searchLayout, chrome } = Route.useSearch();
	const { clubId: clubIdParam, meetingId } = Route.useParams();
	// Clean shareable view: hide the editing chrome, keep only the Print button.
	const bare = chrome === "none";
	// The QR's absolute URL is derived in the browser (#510), same as the
	// present route's own QR and the guest-book QR on the VP Membership page:
	// this route renders on the server first, where `window` doesn't exist, and
	// a QR baked from a relative path is not a URL a phone's camera can resolve.
	// Unknown until the effect fires, which `meetingHubUrlFor` answers with an
	// empty `qrUrl` — every layout treats that as "no QR yet" rather than
	// rendering one that can't scan.
	const [origin, setOrigin] = useState<string | null>(null);
	useEffect(() => setOrigin(window.location.origin), []);
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
		tableTopicsMinSeconds,
		tableTopicsMaxSeconds,
		template,
		logoUrl,
		defaultPrintLayout,
		printedLayout,
	} = Route.useLoaderData();
	// Online, the loader redirects a URL naming no layout, so `searchLayout` is
	// set. Offline, a bare `/…/print` is answered from the page cached for
	// `?layout=X` and hydrates against ITS data: draw the layout that HTML was
	// rendered in, not the club default (which may since differ), or the first
	// client render would disagree with the server's.
	const layout = searchLayout ?? printedLayout;
	// The meeting page "in the room" (#913), not the ballot: its strip leads with
	// Vote while a category is open, so voting still costs one tap — and a club
	// that votes on paper gets a code too, since the strip is more than Vote.
	// No voting gate here, deliberately; the only wait is for the origin.
	const qrUrl = meetingHubUrlFor(
		{ clubKey: clubIdParam, meetingKey: meetingId },
		origin,
	);

	// ONE seam for both meeting shapes (#agenda-templates). `resolveAgendaRows`
	// returns finished rows: the standard flow expands the code-derived
	// RUN_OF_SHOW exactly as before, a templated meeting builds rows from its
	// stored beats. The screen route calls the same function, so the two
	// surfaces cannot disagree about what the meeting is.
	const runRows = resolveAgendaRows({
		geIntroducesFunctionaries,
		// The club's Table Topics window (#443). THIS is the surface the issue is
		// about: the Timer's printed green/yellow/red trio. Omitting it here is
		// what made the first cut print red at 2:00 beside a deck saying 2:30.
		tableTopicsLimits: {
			minSeconds: tableTopicsMinSeconds,
			maxSeconds: tableTopicsMaxSeconds,
		},
		template,
		slots,
	});
	const flex = applyFlex(runRows, meeting.lengthMinutes);
	// null when the agenda fits. The copy is conditional on a flex row actually
	// existing (#395) — see `flexBannerMessage`.
	const flexBanner = flexBannerMessage(flex);
	const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);

	// Meeting end = start + the flexed (projected) run-of-show length.
	const startsAt = new Date(meeting.scheduledAt);
	const endsAt = new Date(startsAt.getTime() + flex.projectedMinutes * 60_000);

	const dateLong = new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	}).format(startsAt);
	const dateShort = new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	})
		.format(startsAt)
		.replace(",", " ·");

	// Meeting-roles roster: one entry per slot, numbered where a role repeats,
	// with assignee or open — except an UNORDERED role (#624), which collapses
	// into one entry naming every holder. Speakers are interleaved with their
	// paired evaluators so each pair shares a row in the two-column print layout.
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
									...AGENDA_TAB_STYLE,
									...(l.id === layout ? AGENDA_TAB_ACTIVE_STYLE : null),
								}}
							>
								{l.label}
								{l.id === defaultPrintLayout ? (
									<span
										data-testid="club-default-marker"
										// Muted, as secondary text: it inherits the tab's colour
										// (MUTED, or white on the active tab) at 0.85, which keeps
										// 4.7:1 on the white toolbar and 9.3:1 on the active tab.
										style={{
											marginLeft: 6,
											fontSize: 11,
											fontWeight: 500,
											opacity: 0.85,
										}}
									>
										{CLUB_DEFAULT_LABEL}
									</span>
								) : null}
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
				qrUrl={qrUrl || undefined}
			/>
		</div>
	);
}

/** A key naming no meeting (#877): the same page every meeting sub-route shows. */
function PrintNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
