import {
	clubNumberText,
	FieldValue,
	statusNote,
} from "#/components/area/area-health-values";
import { AreaVisitsCell } from "#/components/area/area-visits-cell";
import { PrintSummaryLink } from "#/components/area/print-summary-link";
import type { ClubHealth } from "#/lib/area-health";
import { AREA_HEALTH_FIELDS } from "#/lib/area-health-fields";
import type { AreaVisits } from "#/lib/area-visits";

/**
 * The desktop layout of the area view (#1119): one row per club, one column per
 * `AREA_HEALTH_FIELDS` entry, in that list's order. A club that is not on
 * GavelUp, or no longer is, has no numbers: its row names it and says so.
 *
 * `hidden md:block`: below `md` the phone layout (`AreaClubCard`) is shown
 * instead, and the caller renders both.
 */
export function AreaHealthTable({
	areaId,
	clubs,
	visits,
	readOnly = false,
}: {
	areaId: string;
	clubs: readonly ClubHealth[];
	visits: AreaVisits;
	readOnly?: boolean;
}) {
	return (
		<div className="hidden overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] md:block">
			<table className="w-full border-collapse text-left text-sm">
				<caption className="sr-only">Club health for the area</caption>
				<thead>
					<tr className="border-b border-[var(--line)] align-bottom">
						<th
							scope="col"
							className="px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground"
						>
							Club
						</th>
						{AREA_HEALTH_FIELDS.map((field) => (
							<th
								key={field.key}
								scope="col"
								className="px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground"
							>
								{field.label}
							</th>
						))}
						<th
							scope="col"
							className="px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground"
						>
							Visits
						</th>
					</tr>
				</thead>
				<tbody>
					{clubs.map((club) => {
						const note = statusNote(club.status);
						const number = clubNumberText(club.clubNumber);
						return (
							<tr
								key={club.areaClubId}
								className="border-b border-[var(--line)] align-top last:border-b-0"
							>
								<th scope="row" className="px-4 py-3 font-normal">
									<div className="font-semibold">{club.name}</div>
									{number ? (
										<div className="text-xs text-muted-foreground">
											{number}
										</div>
									) : null}
									<PrintSummaryLink
										areaId={areaId}
										areaClubId={club.areaClubId}
										readOnly={readOnly}
										className="text-xs"
									/>
								</th>
								{note ? (
									<td
										colSpan={AREA_HEALTH_FIELDS.length}
										className="px-4 py-3 text-muted-foreground"
									>
										{note}
									</td>
								) : (
									AREA_HEALTH_FIELDS.map((field) => (
										<td key={field.key} className="px-4 py-3">
											<FieldValue club={club} field={field.key} />
										</td>
									))
								)}
								<td className="px-4 py-3">
									<AreaVisitsCell
										areaClubId={club.areaClubId}
										visits={visits[club.areaClubId]}
										readOnly={readOnly}
									/>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
