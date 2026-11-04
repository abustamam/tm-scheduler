// A `yyyy-mm` month as "May 2026", from a fixed English list so the text does
// not depend on the runtime's locale (#1491; the extension has its own copy,
// `extension/lib/last-export.ts`, because nothing under src/ imports from it).

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

export function monthLabel(yyyyMm: string): string {
	const name = MONTHS[Number(yyyyMm.slice(5, 7)) - 1];
	return name ? `${name} ${yyyyMm.slice(0, 4)}` : yyyyMm;
}
