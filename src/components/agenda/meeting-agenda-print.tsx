// src/components/agenda/meeting-agenda-print.tsx
import type { LegendEntry } from "#/lib/agenda-runsheet";
import type { TimelineRow } from "#/lib/agenda-timing";

export type AgendaLayout = "timing" | "spacious" | "editorial" | "grid";

export type AgendaHeader = {
	clubName: string;
	date: string; // preformatted (formatMeetingDate)
	theme: string | null;
	wordOfTheDay: string | null;
	location: string | null;
};

type Props = {
	layout: AgendaLayout;
	header: AgendaHeader;
	legend: LegendEntry[];
	rows: TimelineRow[];
};

// Brand palette transcribed from templates/meeting-agenda/MeetingAgenda.dc.html.
const INK = "#173a40";
const LAGOON = "#328f97";
const MUTED = "#416166";
const GREEN = "#2f9e5b";
const AMBER = "#d99a2e";
const RED = "#c8482f";

/** minutes (e.g. 6.5) → "6:30" for the timer-card marks. */
function mark(minutes: number): string {
	const whole = Math.floor(minutes);
	const secs = Math.round((minutes - whole) * 60);
	return `${whole}:${String(secs).padStart(2, "0")}`;
}

function TimingLayout({ header, legend, rows }: Omit<Props, "layout">) {
	return (
		<div
			style={{
				fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif",
				color: INK,
				maxWidth: 816,
				margin: "0 auto",
			}}
		>
			{/* Header band */}
			<div
				style={{
					background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
					color: "#fff",
					padding: "22px 38px",
				}}
			>
				<div style={{ fontSize: 22, fontWeight: 800 }}>{header.clubName}</div>
				<div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>
					{header.date}
					{header.location ? ` · ${header.location}` : ""}
				</div>
				{(header.theme || header.wordOfTheDay) && (
					<div style={{ fontSize: 12, marginTop: 6 }}>
						{header.theme ? `Theme: ${header.theme}` : ""}
						{header.theme && header.wordOfTheDay ? " · " : ""}
						{header.wordOfTheDay
							? `Word of the Day: ${header.wordOfTheDay}`
							: ""}
					</div>
				)}
			</div>

			{/* Roles legend */}
			{legend.length > 0 && (
				<div
					style={{
						padding: "8px 38px",
						fontSize: 11,
						color: MUTED,
						borderBottom: "1px solid rgba(23,58,64,.1)",
					}}
				>
					{legend.map((e) => `${e.role}: ${e.name}`).join("  ·  ")}
				</div>
			)}

			{/* Run of show */}
			<div style={{ padding: "0 38px" }}>
				{rows.map((r) => (
					<div
						key={`${r.time}-${r.who}`}
						style={{
							display: "flex",
							alignItems: "center",
							padding: "6px 0",
							borderBottom: "1px solid rgba(23,58,64,.07)",
						}}
					>
						<div
							style={{ flex: "none", width: 46, fontSize: 11, fontWeight: 800 }}
						>
							{r.time}
						</div>
						<div
							style={{
								flex: "none",
								width: 170,
								fontSize: 10.5,
								fontWeight: 700,
							}}
						>
							{r.who}
						</div>
						<div style={{ flex: 1, fontSize: 10.5, color: MUTED }}>
							{r.detail}
						</div>
						<div
							style={{
								flex: "none",
								width: 150,
								display: "flex",
								justifyContent: "center",
								gap: 11,
							}}
						>
							{r.marks && (
								<>
									<span style={{ fontSize: 10, color: GREEN, fontWeight: 700 }}>
										{mark(r.marks.green)}
									</span>
									<span style={{ fontSize: 10, color: AMBER, fontWeight: 700 }}>
										{mark(r.marks.yellow)}
									</span>
									<span style={{ fontSize: 10, color: RED, fontWeight: 700 }}>
										{mark(r.marks.red)}
									</span>
								</>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function MeetingAgendaPrint({ layout, header, legend, rows }: Props) {
	if (layout !== "timing") {
		return (
			<div style={{ padding: 48, fontFamily: "system-ui", color: MUTED }}>
				The "{layout}" layout is coming soon. Use the timing layout for now.
			</div>
		);
	}
	return <TimingLayout header={header} legend={legend} rows={rows} />;
}
