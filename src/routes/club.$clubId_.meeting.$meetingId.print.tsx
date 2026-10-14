// src/routes/club.$clubId_.meeting.$meetingId.print.tsx

import {
	createFileRoute,
	Link,
	notFound,
	redirect,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgendaCopies } from "#/components/agenda/agenda-copies";
import {
	type AgendaExplainer,
	type AgendaHeader,
	type AgendaLayout,
	type AgendaOfficer,
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
import {
	AGENDA_TAB_ACTIVE_STYLE,
	AGENDA_TAB_STYLE,
} from "#/components/agenda/print-toolbar-styles";
import {
	CancelledArtifactMarker,
	CancelledWatermark,
} from "#/components/club/cancelled-meeting-notice";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { ShareLinkButton } from "#/components/share-link-button";
import { buildRosterEntries } from "#/lib/agenda";
import {
	AGENDA_LAYOUT_LABELS,
	AGENDA_LAYOUT_PAGES,
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
import { buildTimeline, type TimelineRow } from "#/lib/agenda-timing";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { APP_LOCALE } from "#/lib/format";
import { inRoomMeetingPayload } from "#/lib/in-room-meeting-payload";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { meetingHubUrlFor } from "#/lib/meeting-hub";
import { AGENDA_COPIES } from "#/lib/meeting-packet";
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
		): {
			layout?: AgendaLayout;
			chrome?: "none";
			copies?: number;
			duplex?: 1;
		} => ({
			// No default here (#1069). A missing, empty or unknown layout is
			// `undefined`, and the LOADER redirects it to the club's own default,
			// which only the loader can know. Defaulting here is what hard-coded
			// every print to Grid.
			layout: isAgendaLayout(search.layout) ? search.layout : undefined,
			// `chrome=none` is the clean shareable view (#334): no layout selector,
			// offline badge, or timing banner — just the agenda + a Print button.
			chrome: search.chrome === "none" ? "none" : undefined,
			// How many copies to print, and whether to pad for a duplex printer
			// (#1166), both set by the packet dialog. Parsed here and read by the
			// component only: see the note on `loaderDeps` below.
			copies: parseCopies(search.copies),
			duplex: parseDuplex(search.duplex),
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
						// A bare URL that still names a copy count keeps it (#1166).
						copies: parseCopies(search.copies),
						duplex: parseDuplex(search.duplex),
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
				// #1057: a cancelled meeting's agenda is marked, on screen and on
				// paper, rather than printed as if it were happening. A boolean
				// beside the projection, so the allowlist above stays as it is.
				cancelled: data.meeting.status === "cancelled",
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

/**
 * `?copies=` (#1166): a whole number of agendas, 2..60. Anything that is not a
 * finite number, or floors below 1, means "one" and is `undefined`, so the URL
 * `/print?layout=grid` and `?copies=abc` render identically. The router
 * JSON-parses a numeric value, so this takes a number or a string.
 */
function parseCopies(raw: unknown): number | undefined {
	const n = Number(raw);
	if (!Number.isFinite(n)) return undefined;
	const whole = Math.min(AGENDA_COPIES.max, Math.floor(n));
	return whole < 1 ? undefined : whole;
}

/** `?duplex=1` (#1166), and only that: the packet PDF turns on for the literal
 *  `1` alone, so a URL that pads the HTML but not the PDF must not exist. The
 *  router JSON-parses the `1` in the URL to a number before this sees it; the
 *  string is for a caller that bypasses the parser. */
function parseDuplex(raw: unknown): 1 | undefined {
	return raw === "1" || raw === 1 ? 1 : undefined;
}

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
	const {
		layout: searchLayout,
		chrome,
		copies: requestedCopies,
		duplex,
	} = Route.useSearch();
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
	const loaderData = Route.useLoaderData();
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
		cancelled,
	} = loaderData;
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
		<PrintAgendaView
			layout={layout}
			source={loaderData}
			bare={bare}
			requestedCopies={requestedCopies}
			duplex={duplex}
			clubId={clubIdParam}
			meetingId={meetingId}
			defaultPrintLayout={defaultPrintLayout}
			cancelled={cancelled}
			flexBanner={
				flexBanner
					? { message: flexBanner, over: flex.status === "over" }
					: null
			}
			header={header}
			roles={roles}
			officers={officers}
			explainers={explainers}
			rows={rows}
			qrUrl={qrUrl || undefined}
		/>
	);
}

/**
 * The words in the toolbar when a layout was swapped for Timing (#1225): which
 * layout the club picked, what it promised, and what it is getting instead.
 */
export function fallbackNotice(layout: AgendaLayout): string {
	const n = AGENDA_LAYOUT_PAGES[layout];
	const timing = AGENDA_LAYOUT_PAGES.timing;
	return `This agenda is too long for ${AGENDA_LAYOUT_LABELS[layout]} on ${n} ${n === 1 ? "page" : "pages"}. Showing Timing (${timing} ${timing === 1 ? "page" : "pages"}) instead.`;
}

export type PrintAgendaViewProps = {
	/** The layout the URL asked for. */
	layout: AgendaLayout;
	/** The loader's data object. A new one means a new agenda, so a fallback
	 *  decided for the old one no longer stands. */
	source: unknown;
	bare: boolean;
	requestedCopies: number | undefined;
	duplex: 1 | undefined;
	clubId: string;
	meetingId: string;
	defaultPrintLayout: string | null;
	cancelled: boolean;
	flexBanner: { message: string; over: boolean } | null;
	header: AgendaHeader;
	roles: AgendaRoleEntry[];
	officers: AgendaOfficer[];
	explainers: AgendaExplainer[];
	rows: TimelineRow[];
	qrUrl: string | undefined;
};

/**
 * The toolbar and the sheets, with the one-sheet promise (#1225): a layout
 * whose sheet is too long to scale legibly would FLOW onto extra pages, and a
 * club printing "Grid, 1 page" must not get two. When one of its sheets says so
 * (`onWouldFlow`), this renders Timing instead, for this render only, and the
 * toolbar says why. The active tab stays the one the person picked, and the
 * club's saved default is never written.
 *
 * `fellBackFrom` starts `null` so the server render and hydration are the
 * requested layout, exactly as before; the fallback is decided by the
 * post-mount measurement. It is dropped when the requested layout or the agenda
 * changes, so that layout is measured again from scratch (`FitPage` measures
 * once per mount, and Timing's own sheets are never given `onWouldFlow`).
 */
export function PrintAgendaView({
	layout,
	source,
	bare,
	requestedCopies,
	duplex,
	clubId,
	meetingId,
	defaultPrintLayout,
	cancelled,
	flexBanner,
	header,
	roles,
	officers,
	explainers,
	rows,
	qrUrl,
}: PrintAgendaViewProps) {
	// Extra copies draw only after mount (#1166). The server HTML, and the page
	// the service worker serves for ANY `?copies=` URL offline, hold exactly one
	// agenda, so the first client render must too or it will not hydrate.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const copies = mounted ? (requestedCopies ?? 1) : 1;
	const [fellBackFrom, setFellBackFrom] = useState<AgendaLayout | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `layout` and `source` are the triggers, not values the effect reads
	useEffect(() => setFellBackFrom(null), [layout, source]);
	const effectiveLayout: AgendaLayout =
		fellBackFrom === layout ? "timing" : layout;
	const onWouldFlow = () => setFellBackFrom(layout);

	return (
		<div>
			{/* #1057: marked on screen (the toolbar) and on paper (the fixed
			    watermark, which no layout measures). */}
			{cancelled ? <CancelledWatermark /> : null}
			<PrintToolbar
				leading={cancelled ? <CancelledArtifactMarker /> : undefined}
			>
				{bare ? null : (
					<div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
						{LAYOUTS.map((l) => (
							<Link
								key={l.id}
								to="/club/$clubId/meeting/$meetingId/print"
								params={{ clubId, meetingId }}
								// Switching layout keeps the packet's copy count and duplex
								// flag (#1166), so the person printing does not lose them.
								// Written only after mount, like the copies themselves: the
								// first render must match the HTML the service worker cached
								// for `?layout=X`, which carries neither.
								search={{
									layout: l.id,
									copies: mounted ? requestedCopies : undefined,
									duplex: mounted ? duplex : undefined,
								}}
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
				{bare || fellBackFrom !== layout ? null : (
					<output
						data-testid="print-fallback-notice"
						style={{
							flexBasis: "100%",
							textAlign: "right",
							fontSize: 13,
							color: INK,
						}}
					>
						{fallbackNotice(layout)}
					</output>
				)}
				{bare ? null : (
					<ShareLinkButton
						path={buildAgendaSharePath(clubId, meetingId, layout)}
						label="Copy shareable link"
					/>
				)}
				{copies > 1 ? (
					// So the person printing knows the copies are already in the page
					// and not to ask the browser for more.
					<span
						data-testid="print-copies-note"
						style={{ fontSize: 13, color: MUTED }}
					>
						{copies} copies
					</span>
				) : null}
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
						background: flexBanner.over ? "#fbeaea" : "#eef2f7",
						color: flexBanner.over ? "#8a1c1c" : "#41546b",
					}}
				>
					{flexBanner.message}
				</div>
			) : null}
			<style>{PRINT_PAGE_CSS}</style>
			{/* One copy is the bare agenda, as it always was; only more than one
			    goes through the repeater. Also keeps the disclaimer guard's
			    `<MeetingAgendaPrint` in this file (#381). */}
			{copies > 1 ? (
				<AgendaCopies
					copies={copies}
					duplex={duplex === 1}
					layout={effectiveLayout}
					onWouldFlow={onWouldFlow}
					header={header}
					roles={roles}
					officers={officers}
					explainers={explainers}
					rows={rows}
					qrUrl={qrUrl}
				/>
			) : (
				<MeetingAgendaPrint
					layout={effectiveLayout}
					onWouldFlow={onWouldFlow}
					header={header}
					roles={roles}
					officers={officers}
					explainers={explainers}
					rows={rows}
					qrUrl={qrUrl}
				/>
			)}
		</div>
	);
}

/** A key naming no meeting (#877): the same page every meeting sub-route shows. */
function PrintNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
