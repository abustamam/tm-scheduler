// src/components/agenda/club-role-sheet.tsx
//
// A generic, club-level, one-page printable "role sheet": the club's meeting
// roles grouped by category with each role's plain-language responsibility. It
// is deliberately STATIC — no meeting, no assignees, no timing — so a club
// prints it once and reuses it at every meeting (e.g. hands it to guests / new
// members). See issue #341.
//
// This file is intentionally self-contained (its own brand tokens + one-page
// FitPage primitive) rather than importing the module-private primitives of
// `meeting-agenda-print.tsx`, so this feature and the one-page-timing work
// (#342, which edits that file) stay on cleanly separable branches. A future
// cleanup can hoist the shared tokens/FitPage into one module.
import { useEffect, useRef, useState } from "react";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

export type RoleSheetEntry = {
	id: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	description: string | null;
};

// Brand palette, transcribed from meeting-agenda-print.tsx (kept in sync by eye;
// these are the canonical GavelUp agenda colors).
const INK = "#173a40";
const LAGOON = "#328f97";
const MUTED = "#416166";
const FOREST = "#2f6a4a";
const SEAFOAM = "#8fd6d0";
const SERIF = "'Fraunces', Georgia, serif";
const SANS = "'Manrope', ui-sans-serif, system-ui, sans-serif";
const HAIR = "1px solid rgba(23,58,64,.08)";

// US Letter at 96 CSS px/in — one .agenda-page maps to one printed page.
const PAGE_W = 816;
const PAGE_H = 1056;

const PAGE_OUTER: React.CSSProperties = {
	width: PAGE_W,
	height: PAGE_H,
	background: "#fff",
	boxShadow: "0 14px 44px rgba(23,58,64,.22)",
	overflow: "hidden",
	position: "relative",
	color: INK,
	fontFamily: SANS,
	printColorAdjust: "exact",
	WebkitPrintColorAdjust: "exact",
};

/** One letter page that never overflows onto a second sheet: measures the real
 *  content height once (after webfonts settle) and scales down to fit if taller
 *  than the sheet. Mirrors the `FitPage` in meeting-agenda-print.tsx. */
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
				fontSize: 10,
				fontWeight: 800,
				color: FOREST,
				...style,
			}}
		>
			{children}
		</div>
	);
}

// Categories render top-to-bottom in this order; empty ones are skipped.
const CATEGORY_ORDER = [
	"leadership",
	"speaker",
	"evaluator",
	"functionary",
] as const;
const CATEGORY_LABEL: Record<RoleSheetEntry["category"], string> = {
	leadership: "Leadership",
	speaker: "Speaking Roles",
	evaluator: "Evaluation",
	functionary: "Functionary Roles",
};

/** "Club #NNN" — empty string when the club has no number. */
function clubLine(clubNumber: string | null): string {
	return clubNumber ? `Club #${clubNumber}` : "";
}

export function ClubRoleSheet({
	clubName,
	clubNumber,
	roles,
}: {
	clubName: string;
	clubNumber: string | null;
	roles: RoleSheetEntry[];
}) {
	const byCategory = CATEGORY_ORDER.map((cat) => ({
		cat,
		label: CATEGORY_LABEL[cat],
		items: roles.filter((r) => r.category === cat),
	})).filter((g) => g.items.length > 0);

	const meta = clubLine(clubNumber);

	return (
		<div className="pgwrap">
			<FitPage>
				{/* header band */}
				<div
					style={{
						background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
						color: "#fff",
						padding: "26px 44px",
					}}
				>
					<div style={{ font: `600 26px ${SERIF}`, lineHeight: 1.05 }}>
						{clubName}
					</div>
					<div
						style={{
							fontSize: 11,
							color: "rgba(255,255,255,.82)",
							marginTop: 4,
							letterSpacing: ".02em",
						}}
					>
						{[meta, "Meeting Roles & Responsibilities"]
							.filter(Boolean)
							.join("  ·  ")}
					</div>
				</div>

				<div
					style={{
						padding: "26px 44px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
						gap: 20,
					}}
				>
					{byCategory.length === 0 ? (
						<div style={{ fontSize: 13, color: MUTED }}>
							No roles have been configured for this club yet.
						</div>
					) : (
						byCategory.map((group) => (
							<div key={group.cat}>
								<Kick style={{ marginBottom: 9 }}>{group.label}</Kick>
								<div
									style={{
										border: "1px solid rgba(23,58,64,.12)",
										borderRadius: 10,
										overflow: "hidden",
									}}
								>
									{group.items.map((r, i) => (
										<div
											key={r.id}
											style={{
												padding: "11px 16px",
												borderBottom:
													i < group.items.length - 1 ? HAIR : undefined,
												background: i % 2 === 1 ? "#fafdfb" : "#fff",
											}}
										>
											<div style={{ font: `700 14px ${SERIF}`, color: INK }}>
												{r.name}
											</div>
											{r.description ? (
												<div
													style={{
														fontSize: 11.5,
														color: MUTED,
														lineHeight: 1.45,
														marginTop: 2,
													}}
												>
													{r.description}
												</div>
											) : null}
										</div>
									))}
								</div>
							</div>
						))
					)}
				</div>

				{/* dark footer + non-affiliation disclaimer */}
				<div
					style={{
						marginTop: "auto",
						background: INK,
						padding: "12px 44px",
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
							{clubName}
						</span>
						<span
							style={{
								fontSize: 11,
								fontWeight: 700,
								color: SEAFOAM,
								letterSpacing: ".03em",
							}}
						>
							Meeting Roles
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
			</FitPage>
		</div>
	);
}
