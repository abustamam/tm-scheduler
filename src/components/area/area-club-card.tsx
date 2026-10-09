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
 * The phone layout of the area view (#1119): one card per club, the same six
 * numbers as the desktop table's row, stacked. A club that is not on GavelUp,
 * or no longer is, has no numbers: its card names it and says so.
 */
export function AreaClubCard({
	areaId,
	club,
	visits,
	readOnly = false,
}: {
	areaId: string;
	club: ClubHealth;
	visits: AreaVisits;
	readOnly?: boolean;
}) {
	const note = statusNote(club.status);
	const number = clubNumberText(club.clubNumber);
	return (
		<article className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
			<header>
				<h3 className="font-semibold">{club.name}</h3>
				{number ? (
					<p className="text-xs text-muted-foreground">{number}</p>
				) : null}
			</header>
			{note ? (
				<p className="text-sm text-muted-foreground">{note}</p>
			) : (
				<dl className="grid grid-cols-1 gap-3 text-sm">
					{AREA_HEALTH_FIELDS.map((field) => (
						<div key={field.key}>
							<dt className="text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
								{field.label}
							</dt>
							<dd className="mt-0.5">
								<FieldValue club={club} field={field.key} />
							</dd>
						</div>
					))}
				</dl>
			)}
			<div>
				<h4 className="text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
					Visits
				</h4>
				<div className="mt-0.5">
					<AreaVisitsCell
						areaClubId={club.areaClubId}
						visits={visits[club.areaClubId]}
						readOnly={readOnly}
					/>
				</div>
			</div>
			<PrintSummaryLink
				areaId={areaId}
				areaClubId={club.areaClubId}
				readOnly={readOnly}
				className="inline-block text-sm"
			/>
		</article>
	);
}
