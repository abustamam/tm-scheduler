// src/components/agenda/meeting-agenda-print.tsx
//
// Faithful React port of the four designed layouts in
// templates/meeting-agenda/MeetingAgenda.dc.html (editorial + grid = one page,
// spacious + timing = two pages). Everything is data-driven from the meeting's
// slots, officers, and run-of-show. The club's district, mission, and
// meeting-schedule are optional free-text profile fields: each renders in its
// designated slot when set and is omitted gracefully (no empty label) when not.
// Logo upload remains a tracked follow-up (#83).
import { useEffect, useRef, useState } from "react";
import type { TimelineRow } from "#/lib/agenda-timing";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

export type AgendaLayout = "timing" | "spacious" | "editorial" | "grid";

export type AgendaHeader = {
	clubName: string;
	clubNumber: string | null;
	district: string | null; // "District 39"
	mission: string | null; // free text, may be multi-line
	meetingSchedule: string | null; // "2nd & 4th Thursday, 6:45–7:45 PM"
	dateLong: string; // "Thursday, June 25, 2026"
	dateShort: string; // "Thu · Jun 25, 2026"
	timeRange: string; // "6:45 – 7:45 PM"
	theme: string | null;
	wordOfTheDay: string | null;
	location: string | null;
};

/** "Club #NNN  ·  District 39" — either half optional; "" when both unset. */
function clubLine(clubNumber: string | null, district: string | null): string {
	return [clubNumber ? `Club #${clubNumber}` : null, district]
		.filter(Boolean)
		.join("  ·  ");
}

/** One row of the "Meeting Roles" roster (name null → open/unfilled). */
export type AgendaRoleEntry = { label: string; name: string | null };

/** A club officer for the officer grid. */
export type AgendaOfficer = { office: string; name: string };

/** A role + its plain-language responsibility blurb (timing page 1). */
export type AgendaExplainer = { role: string; description: string };

type Props = {
	layout: AgendaLayout;
	header: AgendaHeader;
	roles: AgendaRoleEntry[];
	officers: AgendaOfficer[];
	explainers: AgendaExplainer[];
	rows: TimelineRow[];
};

// Brand palette transcribed from templates/meeting-agenda/MeetingAgenda.dc.html.
const INK = "#173a40";
const LAGOON = "#328f97";
const TEAL = "#4fb8b2";
const MUTED = "#416166";
const GREEN = "#2f9e5b";
const FOREST = "#2f6a4a";
const AMBER = "#d99a2e";
const RED = "#c8482f";
const OPEN = "#a8761a";
const MINT = "#f3faf5";
const SEAFOAM = "#8fd6d0";
const SERIF = "'Fraunces', Georgia, serif";
const SANS = "'Manrope', ui-sans-serif, system-ui, sans-serif";
const HAIR = "1px solid rgba(23,58,64,.08)";

// US Letter at 96 CSS px/in. The outer sheet is fixed at exactly this so one
// .agenda-page always maps to one printed page.
const PAGE_W = 816;
const PAGE_H = 1056;

/** The letter-sized sheet: fixed size, clipped, prints its background fills. */
const PAGE_OUTER: React.CSSProperties = {
	width: PAGE_W,
	height: PAGE_H,
	background: "#fff",
	boxShadow: "0 14px 44px rgba(23,58,64,.22)",
	overflow: "hidden",
	position: "relative",
	color: INK,
	fontFamily: SANS,
	// Browsers drop background colors/images when printing by default; this keeps
	// the signal dots, dark footer, header gradient, mint cards, and zebra rows.
	printColorAdjust: "exact",
	WebkitPrintColorAdjust: "exact",
};

/**
 * One letter page that never overflows onto a second sheet.
 *
 * Renders its children at the natural 816px width, measures the real content
 * height once (after webfonts settle), and if it's taller than the sheet,
 * reflows the content at a wider virtual width and scales it back down. Because
 * the pre-scale width is 816/scale, the scaled result is exactly 816px wide
 * (full-bleed preserved) and ≤ 1056px tall (nothing clipped) — true WYSIWYG:
 * the on-screen card matches the printed page.
 */
function FitPage({ children }: { children: React.ReactNode }) {
	const innerRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<number | null>(null);

	useEffect(() => {
		const el = innerRef.current;
		if (!el || fit !== null) return; // measure once, at the natural width
		let cancelled = false;
		const measure = () => {
			if (cancelled) return;
			const h = el.scrollHeight;
			// -2px guard against the "content == page height" phantom blank page.
			if (h > PAGE_H) setFit((PAGE_H - 2) / h);
		};
		const fonts = (
			document as Document & { fonts?: { ready: Promise<unknown> } }
		).fonts;
		if (fonts?.ready) fonts.ready.then(measure);
		else measure();
		return () => {
			cancelled = true;
		};
	}, [fit]);

	return (
		<div className="agenda-page" style={PAGE_OUTER}>
			<div
				ref={innerRef}
				style={{
					width: fit ? PAGE_W / fit : PAGE_W,
					minHeight: fit ? undefined : PAGE_H,
					transform: fit ? `scale(${fit})` : undefined,
					transformOrigin: "top left",
					display: "flex",
					flexDirection: "column",
					flex: "none",
				}}
			>
				{children}
			</div>
		</div>
	);
}

/** minutes (e.g. 6.5) → "6:30" for the timing marks. */
function mark(minutes: number): string {
	const whole = Math.floor(minutes);
	const secs = Math.round((minutes - whole) * 60);
	return `${whole}:${String(secs).padStart(2, "0")}`;
}

/** The colored spine for a run-of-show beat, keyed off the role/segment name. */
function beatColor(who: string): string {
	const w = who.toLowerCase();
	if (w.startsWith("sergeant")) return MUTED;
	if (w.startsWith("president")) return INK;
	if (w.includes("table topics")) return FOREST;
	if (w.includes("general evaluator")) return LAGOON;
	if (w.startsWith("speaker")) return TEAL;
	if (w.startsWith("evaluator")) return AMBER;
	if (w.includes("award") || w.startsWith("toastmaster")) return LAGOON;
	return MUTED;
}

/** A speaker beat gets the faint mint highlight in the narrative layouts. */
function isHighlighted(who: string): boolean {
	return who.toLowerCase().startsWith("speaker");
}

function Kick({
	children,
	style,
}: {
	children: React.ReactNode;
	style?: React.CSSProperties;
}) {
	return (
		<div
			style={{
				textTransform: "uppercase",
				letterSpacing: ".09em",
				fontSize: 9,
				fontWeight: 800,
				color: FOREST,
				...style,
			}}
		>
			{children}
		</div>
	);
}

/** The "Meeting Roles" roster, either boxed (grid/timing) or plain (editorial/spacious). */
function RolesRoster({
	roles,
	variant,
}: {
	roles: AgendaRoleEntry[];
	variant: "boxed" | "plain" | "large";
}) {
	const boxed = variant === "boxed";
	const large = variant === "large";
	const labelSize = large ? 11 : boxed ? 9.5 : 9;
	const nameSize = large ? 14 : boxed ? 11.5 : 10.5;
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "1fr 1fr",
				columnGap: large ? 34 : 12,
				...(boxed && {
					border: "1px solid rgba(23,58,64,.12)",
					borderRadius: 10,
					overflow: "hidden",
				}),
			}}
		>
			{roles.map((r, i) => (
				<div
					key={r.label}
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: large ? "baseline" : "center",
						padding: boxed ? "6px 14px" : large ? "9px 0" : "5px 0",
						borderBottom:
							boxed && i >= roles.length - 2
								? undefined
								: "1px solid rgba(23,58,64,.09)",
						background: boxed && i % 2 === 1 ? "#fafdfb" : undefined,
					}}
				>
					<span
						style={{
							fontSize: labelSize,
							textTransform: "uppercase",
							letterSpacing: ".03em",
							color: MUTED,
							fontWeight: 700,
							whiteSpace: "nowrap",
						}}
					>
						{r.label}
					</span>
					{r.name ? (
						<span style={{ fontSize: nameSize, fontWeight: 600 }}>
							{r.name}
						</span>
					) : (
						<span
							style={{
								fontSize: nameSize - 1,
								fontWeight: 700,
								color: OPEN,
							}}
						>
							{boxed ? "○ Open" : "Open"}
						</span>
					)}
				</div>
			))}
		</div>
	);
}

function OfficerGrid({
	officers,
	onDark,
}: {
	officers: AgendaOfficer[];
	onDark?: boolean;
}) {
	if (officers.length === 0) return null;
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(4, 1fr)",
				gap: "9px 20px",
				...(!onDark && {
					border: "1px solid rgba(23,58,64,.12)",
					borderRadius: 10,
					padding: "12px 16px",
				}),
			}}
		>
			{officers.map((o) => (
				<div key={o.office + o.name}>
					<div
						style={{
							fontSize: 8,
							textTransform: "uppercase",
							letterSpacing: ".04em",
							color: onDark ? SEAFOAM : FOREST,
							fontWeight: 800,
						}}
					>
						{o.office}
					</div>
					<div
						style={{
							fontSize: 11.5,
							fontWeight: 600,
							marginTop: 1,
							color: onDark ? "#fff" : INK,
						}}
					>
						{o.name}
					</div>
				</div>
			))}
		</div>
	);
}

/** The narrative run-of-show (editorial / spacious): a colored-spine list. */
function RunNarrative({
	rows,
	scale,
}: {
	rows: TimelineRow[];
	scale: "sm" | "lg";
}) {
	const lg = scale === "lg";
	return (
		<div>
			{rows.map((r, i) => {
				const color = beatColor(r.who);
				const highlight = isHighlighted(r.who);
				return (
					<div
						key={`${r.time}-${r.who}`}
						style={{
							display: "flex",
							borderLeft: `4px solid ${color}`,
							background: highlight ? MINT : undefined,
							padding: lg ? "11px 0 11px 15px" : "8px 0 8px 11px",
							borderBottom: i < rows.length - 1 ? HAIR : undefined,
						}}
					>
						<div
							style={{
								flex: "none",
								width: lg ? 64 : 54,
								fontSize: lg ? 13 : 10.5,
								fontWeight: lg ? 800 : 700,
								color: INK,
							}}
						>
							{r.time}
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: lg ? 14 : 11.5, fontWeight: 700 }}>
								{r.who}
								{r.marks ? (
									<span style={{ fontWeight: 600, color: MUTED }}>
										{" · "}
										{mark(r.marks.green)}–{mark(r.marks.red)}
									</span>
								) : null}
							</div>
							<div
								style={{
									fontSize: lg ? 12 : 10.5,
									color: MUTED,
									lineHeight: 1.4,
									marginTop: 1,
								}}
							>
								{r.detail}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function HeaderBand({ header }: { header: AgendaHeader }) {
	const meta = [clubLine(header.clubNumber, header.district), header.dateLong]
		.filter(Boolean)
		.join("  ·  ");
	return (
		<div
			style={{
				background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
				color: "#fff",
				padding: "22px 38px",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 18 }}>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							font: `600 24px ${SERIF}`,
							lineHeight: 1.05,
							letterSpacing: "-.01em",
						}}
					>
						{header.clubName}
					</div>
					<div
						style={{
							fontSize: 11,
							color: "rgba(255,255,255,.82)",
							marginTop: 3,
							letterSpacing: ".02em",
						}}
					>
						{meta}
					</div>
				</div>
				<div
					style={{ flex: "none", textAlign: "right", display: "flex", gap: 24 }}
				>
					{header.theme ? (
						<div style={{ whiteSpace: "nowrap" }}>
							<div
								style={{
									fontSize: 8.5,
									letterSpacing: ".1em",
									textTransform: "uppercase",
									color: SEAFOAM,
									fontWeight: 800,
								}}
							>
								Theme
							</div>
							<div style={{ font: `600 15px ${SERIF}`, marginTop: 2 }}>
								{header.theme}
							</div>
						</div>
					) : null}
					{header.wordOfTheDay ? (
						<div style={{ whiteSpace: "nowrap" }}>
							<div
								style={{
									fontSize: 8.5,
									letterSpacing: ".1em",
									textTransform: "uppercase",
									color: SEAFOAM,
									fontWeight: 800,
								}}
							>
								Word of the Day
							</div>
							<div style={{ font: `600 15px ${SERIF}`, marginTop: 2 }}>
								{header.wordOfTheDay}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function DarkFooter({
	left,
	right,
}: {
	left: React.ReactNode;
	right: React.ReactNode;
}) {
	return (
		<div
			style={{
				marginTop: "auto",
				background: INK,
				padding: "11px 38px",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<span style={{ fontSize: 11, fontWeight: 600, color: "#fff" }}>
					{left}
				</span>
				<span
					style={{
						fontSize: 11,
						fontWeight: 700,
						color: SEAFOAM,
						letterSpacing: ".03em",
					}}
				>
					{right}
				</span>
			</div>
			<p
				style={{
					margin: "6px 0 0",
					fontSize: 7.5,
					lineHeight: 1.35,
					color: "rgba(255,255,255,0.5)",
				}}
			>
				{TOASTMASTERS_DISCLAIMER}
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// EDITORIAL — one page
// ---------------------------------------------------------------------------
function EditorialLayout({
	header,
	roles,
	officers,
	rows,
}: Omit<Props, "layout" | "explainers">) {
	return (
		<FitPage>
			<HeaderBand header={header} />
			{/* date strip */}
			<div
				style={{
					background: "#e7f0e8",
					padding: "7px 38px",
					display: "flex",
					justifyContent: "space-between",
					fontSize: 10.5,
					color: INK,
					fontWeight: 600,
				}}
			>
				<span>
					{header.dateLong}
					{"  ·  "}
					{header.timeRange}
				</span>
				{header.location ? (
					<span style={{ color: MUTED, fontWeight: 500 }}>
						{header.location}
					</span>
				) : null}
			</div>

			<div
				style={{ display: "flex", gap: 22, padding: "18px 38px 0", flex: 1 }}
			>
				{/* left rail — officers + venue */}
				<div style={{ flex: "none", width: 212 }}>
					{officers.length > 0 ? (
						<>
							<Kick style={{ marginBottom: 6 }}>Club Officers</Kick>
							<div style={{ display: "flex", flexDirection: "column" }}>
								{officers.map((o, i) => (
									<div
										key={o.office + o.name}
										style={{
											display: "flex",
											justifyContent: "space-between",
											padding: "4.5px 0",
											borderBottom:
												i < officers.length - 1
													? "1px solid rgba(23,58,64,.08)"
													: undefined,
										}}
									>
										<span
											style={{
												fontSize: 9,
												textTransform: "uppercase",
												letterSpacing: ".03em",
												color: MUTED,
												fontWeight: 600,
												whiteSpace: "nowrap",
											}}
										>
											{o.office}
										</span>
										<span style={{ fontSize: 10.5, fontWeight: 600 }}>
											{o.name}
										</span>
									</div>
								))}
							</div>
						</>
					) : null}
					{header.meetingSchedule || header.location ? (
						<div
							style={{
								background: MINT,
								border: "1px solid rgba(23,58,64,.1)",
								borderRadius: 10,
								padding: "11px 13px",
								marginTop: 14,
							}}
						>
							{header.meetingSchedule ? (
								<>
									<Kick style={{ marginBottom: 3 }}>Meets</Kick>
									<div
										style={{
											fontSize: 10.5,
											fontWeight: 600,
											lineHeight: 1.35,
											color: INK,
											whiteSpace: "pre-line",
										}}
									>
										{header.meetingSchedule}
									</div>
								</>
							) : null}
							{header.location ? (
								<>
									<Kick
										style={{
											marginBottom: 3,
											...(header.meetingSchedule && { marginTop: 9 }),
										}}
									>
										Location
									</Kick>
									<div style={{ fontSize: 10.5, lineHeight: 1.35, color: INK }}>
										{header.location}
									</div>
								</>
							) : null}
						</div>
					) : null}
					{header.mission ? (
						<>
							<Kick style={{ margin: "14px 0 4px" }}>Club Mission</Kick>
							<div
								style={{
									fontSize: 9.5,
									lineHeight: 1.45,
									color: MUTED,
									whiteSpace: "pre-line",
								}}
							>
								{header.mission}
							</div>
						</>
					) : null}
				</div>

				{/* main — roles + run of show */}
				<div style={{ flex: 1, minWidth: 0 }}>
					<Kick style={{ marginBottom: 6 }}>Meeting Roles</Kick>
					<div style={{ marginBottom: 4 }}>
						<RolesRoster roles={roles} variant="plain" />
					</div>
					<Kick style={{ margin: "18px 0 8px" }}>Run of Show</Kick>
					<RunNarrative rows={rows} scale="sm" />
				</div>
			</div>

			<DarkFooter
				left="Guests are always welcome — speak to any officer about getting involved."
				right="toastmasters.org"
			/>
		</FitPage>
	);
}

// ---------------------------------------------------------------------------
// GRID — one page
// ---------------------------------------------------------------------------
function GridLayout({
	header,
	roles,
	officers,
	rows,
}: Omit<Props, "layout" | "explainers">) {
	return (
		<FitPage>
			{/* header */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 16,
					padding: "20px 36px 18px",
					borderBottom: `3px solid ${TEAL}`,
				}}
			>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							font: `600 23px ${SERIF}`,
							lineHeight: 1.05,
							letterSpacing: "-.01em",
							color: INK,
						}}
					>
						{header.clubName}
					</div>
					{clubLine(header.clubNumber, header.district) ? (
						<div
							style={{
								fontSize: 10.5,
								color: MUTED,
								marginTop: 3,
								fontWeight: 600,
							}}
						>
							{clubLine(header.clubNumber, header.district)}
						</div>
					) : null}
				</div>
				<div style={{ flex: "none", display: "flex", gap: 7 }}>
					<Pill dark>{header.dateShort}</Pill>
					<Pill>{header.timeRange}</Pill>
				</div>
			</div>

			<div
				style={{
					padding: "14px 36px 0",
					flex: 1,
					display: "flex",
					flexDirection: "column",
				}}
			>
				{(header.theme || header.wordOfTheDay) && (
					<div style={{ display: "flex", gap: 12, marginBottom: 13 }}>
						{header.theme ? (
							<ThemeCard
								label="Meeting Theme"
								value={header.theme}
								color={TEAL}
							/>
						) : null}
						{header.wordOfTheDay ? (
							<ThemeCard
								label="Word of the Day"
								value={header.wordOfTheDay}
								color={FOREST}
							/>
						) : null}
					</div>
				)}

				<Kick style={{ marginBottom: 6 }}>Meeting Roles</Kick>
				<div style={{ marginBottom: 14 }}>
					<RolesRoster roles={roles} variant="boxed" />
				</div>

				<Kick style={{ marginBottom: 6 }}>Run of Show</Kick>
				<div
					style={{
						border: "1px solid rgba(23,58,64,.12)",
						borderRadius: 10,
						overflow: "hidden",
					}}
				>
					{rows.map((r, i) => (
						<div
							key={`${r.time}-${r.who}`}
							style={{
								display: "flex",
								background: isHighlighted(r.who)
									? MINT
									: i % 2 === 1
										? "#fafdfb"
										: "#fff",
								borderBottom: i < rows.length - 1 ? HAIR : undefined,
							}}
						>
							<div
								style={{
									flex: "none",
									width: 60,
									borderLeft: `4px solid ${beatColor(r.who)}`,
									padding: "4px 0 4px 10px",
									fontSize: 10.5,
									fontWeight: 700,
									color: INK,
								}}
							>
								{r.time}
							</div>
							<div style={{ flex: 1, padding: "4px 12px 4px 8px" }}>
								<span style={{ fontSize: 10.5, fontWeight: 700 }}>
									{r.who}.
								</span>{" "}
								<span style={{ fontSize: 10, color: MUTED }}>{r.detail}</span>
							</div>
						</div>
					))}
				</div>

				{/* officer footer (also carries the club's meets schedule + mission) */}
				{officers.length > 0 || header.meetingSchedule || header.mission ? (
					<div
						style={{
							marginTop: "auto",
							background: INK,
							margin: "14px -36px 0",
							padding: "13px 36px 16px",
							color: "#fff",
						}}
					>
						{officers.length > 0 || header.meetingSchedule ? (
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "baseline",
									gap: 16,
									marginBottom: officers.length > 0 ? 8 : 0,
								}}
							>
								{officers.length > 0 ? (
									<span
										style={{
											textTransform: "uppercase",
											letterSpacing: ".09em",
											fontSize: 9,
											fontWeight: 800,
											color: SEAFOAM,
										}}
									>
										Club Officers
									</span>
								) : (
									<span />
								)}
								{header.meetingSchedule ? (
									<span
										style={{
											fontSize: 9.5,
											color: "rgba(255,255,255,.7)",
											textAlign: "right",
										}}
									>
										Meets {header.meetingSchedule}
									</span>
								) : null}
							</div>
						) : null}
						{officers.length > 0 ? (
							<OfficerGrid officers={officers} onDark />
						) : null}
						{header.mission ? (
							<div
								style={{
									fontSize: 9,
									fontWeight: 500,
									color: "rgba(255,255,255,.8)",
									lineHeight: 1.3,
									marginTop: officers.length > 0 ? 10 : 0,
									whiteSpace: "pre-line",
								}}
							>
								<span
									style={{
										textTransform: "uppercase",
										letterSpacing: ".04em",
										fontSize: 8,
										fontWeight: 700,
										color: SEAFOAM,
										marginRight: 6,
									}}
								>
									Mission
								</span>
								{header.mission}
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</FitPage>
	);
}

function Pill({
	children,
	dark,
}: {
	children: React.ReactNode;
	dark?: boolean;
}) {
	return (
		<span
			style={{
				background: dark ? INK : "#e7f0e8",
				color: dark ? "#fff" : INK,
				fontSize: 9.5,
				fontWeight: 700,
				padding: "4px 10px",
				borderRadius: 999,
				whiteSpace: "nowrap",
			}}
		>
			{children}
		</span>
	);
}

function ThemeCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color: string;
}) {
	return (
		<div
			style={{
				flex: 1,
				background: MINT,
				borderLeft: `3px solid ${color}`,
				borderRadius: "0 9px 9px 0",
				padding: "9px 14px",
			}}
		>
			<Kick>{label}</Kick>
			<div style={{ font: `600 17px ${SERIF}`, color: INK, marginTop: 1 }}>
				{value}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// SPACIOUS — two pages
// ---------------------------------------------------------------------------
function SpaciousLayout({
	header,
	roles,
	officers,
	rows,
}: Omit<Props, "layout" | "explainers">) {
	return (
		<TwoPage>
			{/* PAGE 1 */}
			<FitPage>
				<div
					style={{
						background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
						padding: "34px 52px",
						color: "#fff",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
						<div style={{ flex: 1, minWidth: 0 }}>
							<div
								style={{
									font: `600 34px ${SERIF}`,
									lineHeight: 1.02,
									letterSpacing: "-.015em",
								}}
							>
								{header.clubName}
							</div>
							{clubLine(header.clubNumber, header.district) ? (
								<div
									style={{
										fontSize: 12.5,
										color: "rgba(255,255,255,.82)",
										marginTop: 5,
										letterSpacing: ".02em",
									}}
								>
									{clubLine(header.clubNumber, header.district)}
								</div>
							) : null}
						</div>
						<div style={{ flex: "none", textAlign: "right" }}>
							<div style={{ font: `600 15px ${SERIF}` }}>{header.dateLong}</div>
							<div
								style={{
									fontSize: 12,
									color: "rgba(255,255,255,.82)",
									marginTop: 2,
								}}
							>
								{header.timeRange}
							</div>
						</div>
					</div>
				</div>

				<div
					style={{
						padding: "26px 52px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					{(header.theme || header.wordOfTheDay) && (
						<div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
							{header.theme ? (
								<BigThemeCard
									label="Meeting Theme"
									value={header.theme}
									color={TEAL}
								/>
							) : null}
							{header.wordOfTheDay ? (
								<BigThemeCard
									label="Word of the Day"
									value={header.wordOfTheDay}
									color={FOREST}
								/>
							) : null}
						</div>
					)}

					<Kick style={{ fontSize: 11, marginBottom: 12 }}>Meeting Roles</Kick>
					<div style={{ marginBottom: 26 }}>
						<RolesRoster roles={roles} variant="large" />
					</div>

					{header.mission ? (
						<>
							<Kick style={{ fontSize: 11, marginBottom: 12 }}>
								Club Mission
							</Kick>
							<div
								style={{
									font: `400 15px/1.6 ${SERIF}`,
									color: "#2b4d52",
									maxWidth: 640,
									whiteSpace: "pre-line",
									marginBottom: 26,
								}}
							>
								{header.mission}
							</div>
						</>
					) : null}

					{header.location ? (
						<>
							<Kick style={{ fontSize: 11, marginBottom: 12 }}>
								Where We Meet
							</Kick>
							<div
								style={{
									font: `400 15px/1.6 ${SERIF}`,
									color: "#2b4d52",
									maxWidth: 640,
								}}
							>
								{header.location}
							</div>
						</>
					) : null}
				</div>

				{officers.length > 0 || header.meetingSchedule ? (
					<div
						style={{
							marginTop: "auto",
							background: INK,
							padding: "16px 52px",
							color: "#fff",
						}}
					>
						{officers.length > 0 ? (
							<>
								<Kick
									style={{ color: SEAFOAM, fontSize: 9.5, marginBottom: 9 }}
								>
									Club Officers
								</Kick>
								<OfficerGrid officers={officers} onDark />
							</>
						) : null}
						{header.meetingSchedule ? (
							<div style={{ marginTop: officers.length > 0 ? 12 : 0 }}>
								<Kick
									style={{ color: SEAFOAM, fontSize: 9.5, marginBottom: 3 }}
								>
									Meets
								</Kick>
								<div
									style={{
										fontSize: 11,
										fontWeight: 500,
										color: "rgba(255,255,255,.85)",
										lineHeight: 1.3,
										whiteSpace: "pre-line",
									}}
								>
									{header.meetingSchedule}
								</div>
							</div>
						) : null}
					</div>
				) : null}
			</FitPage>

			{/* PAGE 2 */}
			<FitPage>
				<div
					style={{
						padding: "34px 52px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "baseline",
							justifyContent: "space-between",
							borderBottom: `3px solid ${TEAL}`,
							paddingBottom: 12,
							marginBottom: 20,
						}}
					>
						<div style={{ font: `600 26px ${SERIF}`, color: INK }}>
							Run of Show
						</div>
						<div style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>
							{header.dateLong} · {header.timeRange}
						</div>
					</div>

					<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
						<RunNarrative rows={rows} scale="lg" />
					</div>

					<div style={{ display: "flex", gap: 20, marginTop: 22 }}>
						<NotesBlock lines={3} />
						<VotesBlock />
					</div>
				</div>

				<DarkFooter
					left="Guests are always welcome — speak to any officer about getting involved."
					right="toastmasters.org"
				/>
			</FitPage>
		</TwoPage>
	);
}

function BigThemeCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color: string;
}) {
	return (
		<div
			style={{
				flex: 1,
				background: MINT,
				borderLeft: `4px solid ${color}`,
				borderRadius: "0 12px 12px 0",
				padding: "15px 20px",
			}}
		>
			<Kick style={{ fontSize: 10 }}>{label}</Kick>
			<div style={{ font: `600 25px ${SERIF}`, color: INK, marginTop: 3 }}>
				{value}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// TIMING — two pages (the detailed timing sheet, default)
// ---------------------------------------------------------------------------
function TimingLayout({
	header,
	roles,
	officers,
	explainers,
	rows,
}: Omit<Props, "layout">) {
	return (
		<TwoPage>
			{/* PAGE 1 — roles, signals, officers, explainers */}
			<FitPage>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 16,
						padding: "24px 44px 18px",
						borderBottom: `3px solid ${TEAL}`,
					}}
				>
					<div style={{ flex: 1, minWidth: 0 }}>
						<div
							style={{
								font: `600 24px ${SERIF}`,
								lineHeight: 1.05,
								letterSpacing: "-.01em",
								color: INK,
							}}
						>
							{header.clubName}
						</div>
						{clubLine(header.clubNumber, header.district) ? (
							<div
								style={{
									fontSize: 11,
									color: MUTED,
									marginTop: 3,
									fontWeight: 600,
								}}
							>
								{clubLine(header.clubNumber, header.district)}
							</div>
						) : null}
					</div>
					<div style={{ flex: "none", textAlign: "right" }}>
						<div
							style={{
								fontSize: 8.5,
								letterSpacing: ".1em",
								textTransform: "uppercase",
								color: FOREST,
								fontWeight: 800,
							}}
						>
							Detailed Timing Agenda
						</div>
						<div
							style={{ font: `600 14px ${SERIF}`, color: INK, marginTop: 2 }}
						>
							{header.dateShort} · {header.timeRange}
						</div>
					</div>
				</div>

				<div
					style={{
						padding: "18px 44px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					{/* meta */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1fr 1.3fr",
							gap: 12,
							marginBottom: 18,
						}}
					>
						{header.theme ? (
							<MetaCard label="Theme" value={header.theme} color={TEAL} serif />
						) : null}
						{header.wordOfTheDay ? (
							<MetaCard
								label="Word of the Day"
								value={header.wordOfTheDay}
								color={FOREST}
								serif
							/>
						) : null}
						{header.location ? (
							<MetaCard label="Venue" value={header.location} color={LAGOON} />
						) : null}
					</div>

					<Kick style={{ marginBottom: 7 }}>Meeting Roles</Kick>
					<div style={{ marginBottom: 20 }}>
						<RolesRoster roles={roles} variant="boxed" />
					</div>

					{/* timing signals */}
					<Kick style={{ marginBottom: 7 }}>Timing Signals</Kick>
					<div
						style={{
							display: "flex",
							gap: 22,
							background: MINT,
							border: "1px solid rgba(23,58,64,.1)",
							borderRadius: 10,
							padding: "12px 18px",
							marginBottom: 20,
						}}
					>
						<Signal color={GREEN} label="Green" text="minimum time reached" />
						<Signal color={AMBER} label="Amber" text="approaching the target" />
						<Signal color={RED} label="Red" text="maximum; please conclude" />
					</div>

					{officers.length > 0 ? (
						<>
							<Kick style={{ marginBottom: 7 }}>Club Officers</Kick>
							<div style={{ marginBottom: 16 }}>
								<OfficerGrid officers={officers} />
							</div>
						</>
					) : null}

					{header.meetingSchedule || header.mission ? (
						<div style={{ display: "flex", gap: 22, marginBottom: 16 }}>
							{header.meetingSchedule ? (
								<div style={{ flex: "none", maxWidth: 220 }}>
									<Kick style={{ marginBottom: 3 }}>Meets</Kick>
									<div
										style={{
											font: `600 12px ${SERIF}`,
											color: INK,
											lineHeight: 1.35,
											whiteSpace: "pre-line",
										}}
									>
										{header.meetingSchedule}
									</div>
								</div>
							) : null}
							{header.mission ? (
								<div style={{ flex: 1, minWidth: 0 }}>
									<Kick style={{ marginBottom: 3 }}>Club Mission</Kick>
									<div
										style={{
											font: `400 12px/1.5 ${SERIF}`,
											color: "#2b4d52",
											whiteSpace: "pre-line",
										}}
									>
										{header.mission}
									</div>
								</div>
							) : null}
						</div>
					) : null}

					{explainers.length > 0 ? (
						<>
							<Kick style={{ marginBottom: 7 }}>
								New to Toastmasters? The Roles, Explained
							</Kick>
							<div
								style={{
									border: "1px solid rgba(23,58,64,.12)",
									borderRadius: 10,
									padding: "14px 18px",
									flex: 1,
									display: "flex",
									flexDirection: "column",
								}}
							>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "1fr 1fr",
										gap: "10px 30px",
									}}
								>
									{explainers.map((e) => (
										<div
											key={e.role}
											style={{ fontSize: 11, lineHeight: 1.4, color: MUTED }}
										>
											<b style={{ color: INK }}>{e.role}</b> — {e.description}
										</div>
									))}
								</div>
							</div>
						</>
					) : null}
				</div>

				<DarkFooter
					left="Page 1 of 2 · Officers & roles"
					right="toastmasters.org"
				/>
			</FitPage>

			{/* PAGE 2 — detailed timing table */}
			<FitPage>
				<div
					style={{
						padding: "28px 44px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "baseline",
							justifyContent: "space-between",
							borderBottom: `3px solid ${TEAL}`,
							paddingBottom: 11,
							marginBottom: 14,
						}}
					>
						<div style={{ font: `600 24px ${SERIF}`, color: INK }}>
							Run of Show — Detailed Timing
						</div>
						<div style={{ fontSize: 11, color: MUTED, fontWeight: 600 }}>
							{header.timeRange}
						</div>
					</div>

					{/* table header */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							background: INK,
							color: "#fff",
							borderRadius: "8px 8px 0 0",
							padding: "7px 12px",
							fontSize: 9,
							textTransform: "uppercase",
							letterSpacing: ".05em",
							fontWeight: 800,
						}}
					>
						<div style={{ flex: "none", width: 46 }}>Time</div>
						<div style={{ flex: "none", width: 150 }}>Role</div>
						<div style={{ flex: 1 }}>Segment</div>
						<div style={{ flex: "none", width: 150, textAlign: "center" }}>
							Green · Amber · Red
						</div>
					</div>

					<div
						style={{
							border: "1px solid rgba(23,58,64,.12)",
							borderTop: "none",
							borderRadius: "0 0 8px 8px",
							overflow: "hidden",
						}}
					>
						{rows.map((r, i) => {
							const [role, ...rest] = r.who.split(" · ");
							const name = rest.join(" · ");
							return (
								<div
									key={`${r.time}-${r.who}`}
									style={{
										display: "flex",
										alignItems: "center",
										padding: "6px 12px",
										borderBottom: i < rows.length - 1 ? HAIR : undefined,
										background: isHighlighted(r.who)
											? MINT
											: i % 2 === 1
												? "#fafdfb"
												: "#fff",
									}}
								>
									<div
										style={{
											flex: "none",
											width: 46,
											fontSize: 11,
											fontWeight: 800,
											color: INK,
										}}
									>
										{r.time}
									</div>
									<div
										style={{
											flex: "none",
											width: 150,
											fontSize: 10.5,
											fontWeight: name ? 700 : 600,
											color: INK,
										}}
									>
										{role}
										{name ? (
											<span style={{ fontWeight: 600, color: MUTED }}>
												{" · "}
												{name}
											</span>
										) : null}
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
										{r.marks ? (
											<>
												<span
													style={{
														fontSize: 10,
														color: GREEN,
														fontWeight: 700,
													}}
												>
													{mark(r.marks.green)}
												</span>
												<span
													style={{
														fontSize: 10,
														color: AMBER,
														fontWeight: 700,
													}}
												>
													{mark(r.marks.yellow)}
												</span>
												<span
													style={{ fontSize: 10, color: RED, fontWeight: 700 }}
												>
													{mark(r.marks.red)}
												</span>
											</>
										) : null}
									</div>
								</div>
							);
						})}
					</div>

					<div style={{ display: "flex", gap: 16, marginTop: 18 }}>
						<NotesBlock lines={4} />
						<VotesBlock compact />
					</div>
				</div>

				<DarkFooter
					left="Page 2 of 2 · Detailed run of show"
					right={`${header.clubName}`}
				/>
			</FitPage>
		</TwoPage>
	);
}

function MetaCard({
	label,
	value,
	color,
	serif,
}: {
	label: string;
	value: string;
	color: string;
	serif?: boolean;
}) {
	return (
		<div
			style={{
				background: MINT,
				borderLeft: `3px solid ${color}`,
				borderRadius: "0 9px 9px 0",
				padding: "9px 14px",
			}}
		>
			<Kick>{label}</Kick>
			<div
				style={
					serif
						? { font: `600 16px ${SERIF}`, color: INK, marginTop: 1 }
						: {
								fontSize: 11,
								color: INK,
								marginTop: 2,
								lineHeight: 1.35,
								fontWeight: 600,
							}
				}
			>
				{value}
			</div>
		</div>
	);
}

function Signal({
	color,
	label,
	text,
}: {
	color: string;
	label: string;
	text: string;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
			<span
				style={{
					width: 15,
					height: 15,
					borderRadius: "50%",
					background: color,
					flex: "none",
					boxShadow: `0 0 0 3px ${color}2e`,
				}}
			/>
			<span style={{ fontSize: 11.5, color: INK }}>
				<b>{label}</b> — {text}
			</span>
		</div>
	);
}

const NOTE_LINE_KEYS = ["a", "b", "c", "d", "e", "f"];

function NotesBlock({ lines }: { lines: number }) {
	return (
		<div style={{ flex: 1 }}>
			<Kick style={{ fontSize: 9.5, marginBottom: 7 }}>Meeting Notes</Kick>
			{NOTE_LINE_KEYS.slice(0, lines).map((k) => (
				<div
					key={k}
					style={{ borderBottom: "1px solid rgba(23,58,64,.16)", height: 20 }}
				/>
			))}
		</div>
	);
}

function VotesBlock({ compact }: { compact?: boolean }) {
	const rows = ["Best Speaker", "Best Table Topic", "Best Evaluator"];
	return (
		<div
			style={{
				flex: "none",
				width: compact ? 206 : 238,
				background: MINT,
				border: "1px solid rgba(23,58,64,.1)",
				borderRadius: compact ? 10 : 12,
				padding: compact ? "12px 15px" : "14px 16px",
			}}
		>
			<Kick style={{ fontSize: 9.5, marginBottom: 7 }}>Tonight's Votes</Kick>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 6,
					fontSize: 11,
					color: INK,
				}}
			>
				{rows.map((r, i) => (
					<div
						key={r}
						style={{
							display: "flex",
							justifyContent: "space-between",
							borderBottom:
								i < rows.length - 1
									? "1px dashed rgba(23,58,64,.2)"
									: undefined,
							paddingBottom: 4,
						}}
					>
						<span style={{ color: MUTED, fontWeight: 600 }}>{r}</span>
						<span>________</span>
					</div>
				))}
			</div>
		</div>
	);
}

/** Stacks two letter-size pages with a page break between them for print. */
function TwoPage({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="pgwrap"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 26,
			}}
		>
			{children}
		</div>
	);
}

export function MeetingAgendaPrint({
	layout,
	header,
	roles,
	officers,
	explainers,
	rows,
}: Props) {
	switch (layout) {
		case "editorial":
			return (
				<EditorialLayout
					header={header}
					roles={roles}
					officers={officers}
					rows={rows}
				/>
			);
		case "grid":
			return (
				<GridLayout
					header={header}
					roles={roles}
					officers={officers}
					rows={rows}
				/>
			);
		case "spacious":
			return (
				<SpaciousLayout
					header={header}
					roles={roles}
					officers={officers}
					rows={rows}
				/>
			);
		default:
			return (
				<TimingLayout
					header={header}
					roles={roles}
					officers={officers}
					explainers={explainers}
					rows={rows}
				/>
			);
	}
}
