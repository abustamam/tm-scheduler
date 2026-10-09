import {
	FitPage,
	HAIR,
	INK,
	Kick,
	LAGOON,
	MUTED,
	SERIF,
} from "#/components/agenda/print-theme";
import {
	clubNumberText,
	FieldValue,
	formatAsOf,
	statusNote,
} from "#/components/area/area-health-values";
import { AREA_HEALTH_FIELDS } from "#/lib/area-health-fields";
import {
	type AreaClubSummary,
	formatVisitDate,
	VISIT_ROUNDS,
} from "#/lib/area-visits";
import { programYearLabel } from "#/lib/dcp";

/**
 * The one-page club visit summary (#1120): the club, the area, when the numbers
 * were read, the same six numbers the area view shows (and the next two
 * meetings, which `FieldValue` prints under "Meetings"), and both visit dates.
 * The report itself goes to Toastmasters International; this is the page an
 * Area Director takes into the room.
 *
 * Every number comes through `FieldValue`, the component the table and the card
 * use, so the sheet cannot say something the view does not. Nothing here names a
 * person.
 */
export function AreaClubSummarySheet({
	summary,
}: {
	summary: Pick<
		AreaClubSummary,
		"label" | "programYear" | "asOf" | "club" | "visits"
	>;
}) {
	const { club, visits } = summary;
	const note = statusNote(club.status);
	const number = clubNumberText(club.clubNumber);
	return (
		<div className="pgwrap">
			<FitPage>
				<div
					style={{
						background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
						color: "#fff",
						padding: "26px 44px",
					}}
				>
					<div style={{ font: `600 26px ${SERIF}`, lineHeight: 1.05 }}>
						{club.name}
					</div>
					<div
						style={{
							fontSize: 11,
							color: "rgba(255,255,255,.82)",
							marginTop: 4,
							letterSpacing: ".02em",
						}}
					>
						{[
							number,
							`Area ${summary.label}`,
							programYearLabel(summary.programYear),
							"Club visit summary",
						]
							.filter(Boolean)
							.join("  ·  ")}
					</div>
				</div>
				<div
					style={{
						padding: "22px 44px 0",
						color: INK,
						display: "flex",
						flexDirection: "column",
						gap: 20,
					}}
				>
					<div style={{ fontSize: 11, color: MUTED }}>
						As of {formatAsOf(summary.asOf)}
					</div>
					<div>
						<Kick style={{ marginBottom: 9 }}>Visits</Kick>
						<div
							style={{
								display: "flex",
								gap: 40,
								fontSize: 14,
								borderTop: HAIR,
								paddingTop: 10,
							}}
						>
							{VISIT_ROUNDS.map((round) => {
								const date = visits[round];
								return (
									<div key={round}>
										Round {round}:{" "}
										{date ? (
											<strong>{formatVisitDate(date)}</strong>
										) : (
											<span style={{ color: MUTED }}>not yet</span>
										)}
									</div>
								);
							})}
						</div>
					</div>
					<div>
						<Kick style={{ marginBottom: 9 }}>Club health</Kick>
						{note ? (
							<div style={{ fontSize: 13, color: MUTED }}>{note}</div>
						) : (
							<dl
								style={{
									display: "grid",
									gridTemplateColumns: "1fr 1fr",
									gap: "16px 32px",
									fontSize: 13,
									margin: 0,
								}}
							>
								{AREA_HEALTH_FIELDS.map((field) => (
									<div
										key={field.key}
										style={{ borderTop: HAIR, paddingTop: 8 }}
									>
										<dt
											style={{
												fontSize: 10,
												fontWeight: 800,
												letterSpacing: ".06em",
												textTransform: "uppercase",
												color: MUTED,
											}}
										>
											{field.label}
										</dt>
										<dd style={{ margin: "4px 0 0" }}>
											<FieldValue club={club} field={field.key} />
										</dd>
									</div>
								))}
							</dl>
						)}
					</div>
				</div>
			</FitPage>
		</div>
	);
}
