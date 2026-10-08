// The Area Director notice at the top of club settings (#1118, part of #1115):
// who the club's Area Director is and which numbers they can see, shown to the
// club's admins before #1119 lets any director see them.
//
// The wording is scoped to the ROLE on purpose. A club's public pages stay
// public and `listMembers` is session-less by design, so "they can't see member
// names" would overclaim to anyone, director included, who has the club's link.
// What the notice promises is that BEING Area Director adds nothing to that.
//
// The numbers are rendered from `AREA_HEALTH_FIELDS`, never retyped: the same
// list the Area Director's view is built from, so the two cannot name different
// things. Renders nothing for a club in no area this program year (the loader
// returns null) so the route hands the loader result straight through.
import { AREA_HEALTH_FIELDS } from "#/lib/area-health-fields";
import type { ClubAreaNotice } from "#/server/club-area-notice-logic";

export function AreaNotice({ notice }: { notice: ClubAreaNotice | null }) {
	if (!notice) return null;
	const { areaLabel, divisionLetter, districtNumber, directorName } = notice;
	const numbers = AREA_HEALTH_FIELDS.map((field, i) => (
		<span key={field.key} data-field={field.key}>
			{i > 0 ? ", " : ""}
			{field.label}
		</span>
	));
	return (
		<div
			role="note"
			data-testid="area-notice"
			className="max-w-xl rounded-lg border bg-muted/40 p-4 text-sm"
		>
			<p>
				<strong>
					Area {areaLabel} · Division {divisionLetter} · District{" "}
					{districtNumber}.
				</strong>{" "}
				{directorName
					? `As your Area Director, ${directorName} can see these numbers for your club: `
					: "No Area Director is assigned yet. When one is, they'll see these numbers for your club: "}
				{numbers}. Being Area Director gives them nothing else: no member names
				and no contact details.
			</p>
		</div>
	);
}
