// src/components/agenda/club-role-sheet.tsx
//
// A generic, club-level, one-page printable "role sheet": the club's meeting
// roles grouped by category with each role's plain-language responsibility. It
// is deliberately STATIC — no meeting, no assignees, no timing — so a club
// prints it once and reuses it at every meeting (e.g. hands it to guests / new
// members). See issue #341.
//
// Shares the print aesthetic (brand tokens, one-page FitPage, Kick, DarkFooter)
// with the meeting agenda layouts via `./print-theme` (#345).
import {
	DarkFooter,
	FitPage,
	HAIR,
	INK,
	Kick,
	LAGOON,
	MUTED,
	SERIF,
} from "./print-theme";

export type RoleSheetEntry = {
	id: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	description: string | null;
};

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

				<DarkFooter left={clubName} right="Meeting Roles" />
			</FitPage>
		</div>
	);
}
