/**
 * The six numbers the Area Director's view shows for a club, and the club
 * notice lists (#1115). Client-safe: no `#/db`, no server import.
 *
 * One list, imported by the area view (#1118), the club notice (#1119) and the
 * health computation (#1117), so a number is named, labelled and described
 * once. #1117–#1119 import this file; none of them edits it.
 *
 * `key` is the identifier the computation returns and a stored notice may
 * name, so it is a contract: rename one and a stored notice keeps the old
 * word. `label` is the short heading, `description` the sentence a club reads
 * to learn what the Area Director is looking at.
 */
export const AREA_HEALTH_FIELDS = [
	{
		key: "meetings",
		label: "Meetings",
		description:
			"How many meetings the club has held this program year, against how many it has on the calendar.",
	},
	{
		key: "roleFillRate",
		label: "Role fill rate",
		description:
			"The share of roles in the club's upcoming meetings that have someone signed up.",
	},
	{
		key: "attendance",
		label: "Attendance",
		description:
			"How many members were present, on average, at recent meetings.",
	},
	{
		key: "officers",
		label: "Officers",
		description: "How many of the club's officer offices are filled.",
	},
	{
		key: "dcp",
		label: "Distinguished Club Program",
		description:
			"How many of the ten Distinguished Club Program goals the club has met this program year.",
	},
	{
		key: "renewals",
		label: "Renewals",
		description: "How many members have renewed for the current period.",
	},
] as const;

export type AreaHealthField = (typeof AREA_HEALTH_FIELDS)[number];
export type AreaHealthFieldKey = AreaHealthField["key"];

/**
 * An area's label as members and Area Directors say it: the division letter
 * followed by the area number, "C3". Trims both, so a stored value with stray
 * whitespace cannot print as "C 3".
 */
export function areaLabel(divisionLetter: string, areaNumber: string): string {
	return `${divisionLetter.trim()}${areaNumber.trim()}`;
}
