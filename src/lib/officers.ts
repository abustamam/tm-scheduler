/**
 * Canonical Toastmasters club-officer ordering for display (President first,
 * down to Sergeant-at-Arms). `office` is a free-text field, so matching is
 * case-insensitive and tolerant of common abbreviations ("VPE", "VP Education").
 * Unrecognized offices sort last, alphabetically, after the known ones.
 */
const OFFICER_ORDER: { rank: number; test: RegExp }[] = [
	{ rank: 0, test: /president/i }, // note: "VP …" is caught below first
	{ rank: 1, test: /^vp\b.*edu|vice.?president.*edu|^vpe$/i },
	{ rank: 2, test: /^vp\b.*mem|vice.?president.*mem|^vpm$/i },
	{ rank: 3, test: /^vp\b.*(pub|pr)|vice.?president.*(pub|rel)|^vppr$/i },
	{ rank: 4, test: /secretary/i },
	{ rank: 5, test: /treasurer/i },
	{ rank: 6, test: /sergeant|sgt|arms|saa/i },
];

/** Lower rank sorts earlier. VP roles must be tested before the bare
 *  "president" rule, so we check the VP patterns first. */
export function officerRank(office: string): number {
	const o = office.trim();
	// VP roles first (so "VP Education" doesn't match the plain /president/ rule).
	for (const { rank, test } of OFFICER_ORDER) {
		if (rank >= 1 && rank <= 3 && test.test(o)) return rank;
	}
	if (/president/i.test(o) && !/vice|vp\b/i.test(o)) return 0;
	for (const { rank, test } of OFFICER_ORDER) {
		if (rank >= 4 && test.test(o)) return rank;
	}
	return 100; // unknown offices sort last
}
