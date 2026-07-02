// src/routes/club.$clubId_.meeting.$meetingId.print.tsx
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import {
	type AgendaExplainer,
	type AgendaLayout,
	type AgendaRoleEntry,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { expandRunSheet } from "#/lib/agenda-runsheet";
import { buildTimeline } from "#/lib/agenda-timing";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getMeeting } from "#/server/meetings";

const LAYOUTS: { id: AgendaLayout; label: string }[] = [
	{ id: "timing", label: "Timing" },
	{ id: "spacious", label: "Spacious" },
	{ id: "editorial", label: "Editorial" },
	{ id: "grid", label: "Grid" },
];
const LAYOUT_IDS = LAYOUTS.map((l) => l.id);

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/print")(
	{
		validateSearch: (
			search: Record<string, unknown>,
		): { layout: AgendaLayout } => {
			const l = search.layout;
			return {
				layout: LAYOUT_IDS.includes(l as AgendaLayout)
					? (l as AgendaLayout)
					: "timing",
			};
		},
		loader: async ({ params, location }) => {
			const club = await resolveClubOrRedirect(params.clubId, location);
			const data = await getMeeting({ data: params.meetingId });
			if (data.meeting.clubId !== club.id) throw notFound();
			return data;
		},
		component: PrintAgenda,
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
	const { layout } = Route.useSearch();
	const { clubId: clubIdParam, meetingId } = Route.useParams();
	const {
		meeting,
		slots,
		timezone,
		clubName,
		clubNumber,
		clubDistrict,
		clubMission,
		clubMeetingSchedule,
		officers,
	} = Route.useLoaderData();

	const runRows = expandRunSheet(slots);
	const rows = buildTimeline(runRows, meeting.scheduledAt, timezone);

	// Meeting end = start + total run-of-show minutes.
	const totalMinutes = runRows.reduce((sum, r) => sum + r.minutes, 0);
	const startsAt = new Date(meeting.scheduledAt);
	const endsAt = new Date(startsAt.getTime() + totalMinutes * 60_000);

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

	// Meeting-roles roster: one row per slot, numbered, with assignee or open.
	const roleCounts = buildRoleCounts(slots);
	const roles: AgendaRoleEntry[] = slots.map((s) => ({
		label: slotLabel(s, roleCounts),
		name: s.assigneeName ?? null,
	}));

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
	};

	return (
		<div>
			<div className="no-print" style={toolbarStyle}>
				<div style={{ display: "flex", gap: 4 }}>
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
				.pgwrap { padding: 28px 0; }
				@media print {
					.no-print { display: none !important; }
					body { background: #fff; }
					.pgwrap { padding: 0 !important; gap: 0 !important; }
					.pgwrap > div { break-after: page; box-shadow: none !important; }
					.pgwrap > div:last-child { break-after: auto; }
					@page { size: letter portrait; margin: 0; }
				}
			`}</style>
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				roles={roles}
				officers={officers}
				explainers={explainers}
				rows={rows}
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

const tabStyle: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 600,
	color: "#416166",
	textDecoration: "none",
};

const tabActiveStyle: React.CSSProperties = {
	background: "#173a40",
	color: "#fff",
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
