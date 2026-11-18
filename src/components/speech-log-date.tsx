import { Fragment, type ReactNode, useEffect, useState } from "react";
import { formatDayMonth } from "#/lib/format";

/**
 * The date stamp on a dashboard speech-log row (#608).
 *
 * Same defect as the greeting beside it, ~90 lines down the same route and
 * missed on the first pass. `dayMon` (now `formatDayMonth` in `#/lib/format`)
 * called `new Intl.DateTimeFormat(undefined, …)` during render, and BOTH of
 * those arguments resolve against the runtime:
 *
 *   - the timezone, so a Los Angeles member's 19:00 Aug 20 speech printed
 *     `21 AUG` in the UTC container and `20 AUG` in their browser;
 *   - the locale, so a Spanish-locale browser printed `AGO` against the
 *     server's `AUG` — a mismatch even for a member sitting in UTC.
 *
 * Both were measured, and either one alone is enough to make React throw the
 * server markup away.
 */

/**
 * The box the date sits in, empty. Non-breaking spaces rather than empty
 * strings so the three lines keep their height and the 64px grid column does not
 * collapse and reflow the row when the real date lands.
 */
const BLANK = "\u00A0";

export function SpeechLogDate({ value }: { value: Date | string }) {
	// Same pre-mount guard as `DashboardGreeting`. The server pass and every
	// first client render see `mounted === false`, so both emit the empty box and
	// hydration has nothing to reconcile; the effect then fills it in from the
	// viewer's own runtime zone.
	//
	// The POST-mount zone is the one the browser was already resolving to; the
	// locale is `APP_LOCALE` (#708), so a Spanish browser reads AUG, not AGO.
	// The server pass changes from "a guess that is wrong for most of the
	// planet" to "nothing".
	//
	// Blank rather than a placeholder date, which is the other way to make the
	// two passes agree. UTC is not neutral for an INSTANT the way it is for the
	// stored calendar day `formatCalendarDay` pins: rendering `21 AUG` and then
	// correcting it to `20 AUG` shows a concrete, authoritative, wrong date
	// first. #608 chose the generic-but-never-wrong first paint for the greeting
	// and this follows it.
	//
	// And deliberately NOT `suppressHydrationWarning`, which is React's
	// documented escape hatch for timestamps and looks like a one-word fix here.
	// It suppresses the WARNING without repairing the mismatch: React keeps the
	// SERVER's text for a suppressed text node and does not re-render it, so the
	// member would be left looking at the UTC date until something unrelated
	// re-rendered the row. That satisfies the letter of "no hydration mismatch is
	// logged" by making the data silently wrong, which is worse than the bug.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const parts = mounted ? formatDayMonth(value) : null;

	return (
		<div className="text-center leading-[1.1]">
			<div className="font-display text-lg font-semibold">
				{parts ? parts.day : BLANK}
			</div>
			<div className="text-xs font-bold tracking-[0.05em] text-muted-foreground">
				{parts ? parts.mon : BLANK}
			</div>
			<div className="text-xs font-bold tracking-[0.05em] text-muted-foreground">
				{parts ? parts.year : BLANK}
			</div>
		</div>
	);
}

const PAST_MONTHS = [
	"JAN",
	"FEB",
	"MAR",
	"APR",
	"MAY",
	"JUN",
	"JUL",
	"AUG",
	"SEP",
	"OCT",
	"NOV",
	"DEC",
];

/**
 * The date stamp of a past speech (#1656): `MAR` / `2023`, the year alone, or
 * `—`. A loose calendar date with no instant and no timezone, so unlike
 * `SpeechLogDate` it renders the same on the server and the client with no
 * pre-mount guard; the month names are fixed, not `Intl`.
 */
export function PastSpeechDate({
	year,
	month,
}: {
	year: number | null;
	month: number | null;
}) {
	return (
		<div className="text-center leading-[1.1]">
			<div className="font-display text-lg font-semibold">
				{year === null ? "—" : BLANK}
			</div>
			<div className="text-xs font-bold tracking-[0.05em] text-muted-foreground">
				{year !== null && month !== null ? PAST_MONTHS[month - 1] : BLANK}
			</div>
			<div className="text-xs font-bold tracking-[0.05em] text-muted-foreground">
				{year ?? BLANK}
			</div>
		</div>
	);
}

/** The muted badge a past speech wears where a meeting row has its state pill. */
export function PastBadge() {
	return (
		<span className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface-soft px-2.5 py-1 text-xs font-semibold text-muted-foreground">
			Past
		</span>
	);
}

/** The divider above the undated rows of a speech log. */
export function EarlierDivider() {
	return (
		<div className="border-t border-border px-5 pt-3 pb-1 text-xs text-muted-foreground">
			Earlier
		</div>
	);
}

/**
 * The id of the first undated past row, the one that sits under the "Earlier"
 * divider (#1656). The log is already ordered with every undated row last.
 */
export function firstUndatedPastId(
	rows: ReadonlyArray<
		| { kind: "meeting" }
		| { kind: "past"; speechId: string; deliveredYear: number | null }
	>,
): string | null {
	for (const r of rows) {
		if (r.kind === "past" && r.deliveredYear === null) return r.speechId;
	}
	return null;
}

/**
 * A past speech's row in a speech log (#1656), shared by the dashboard and the
 * member profile. `layout` carries each page's own meeting-row grid (the date
 * column and gap), so a past row lines up with the meeting rows beside it;
 * `showLevel` follows the same page's meeting-row subline. `edit` is the pencil,
 * which each page gates itself.
 */
export function PastSpeechRow({
	row,
	layout,
	showLevel,
	showEarlierDivider,
	edit,
}: {
	row: {
		speechTitle: string | null;
		projectName: string | null;
		pathwayPath: string | null;
		projectLevel: string | null;
		deliveredYear: number | null;
		deliveredMonth: number | null;
	};
	layout: "dashboard" | "profile";
	showLevel: boolean;
	showEarlierDivider: boolean;
	edit: ReactNode;
}) {
	const project = [
		row.projectName,
		row.pathwayPath,
		showLevel ? row.projectLevel : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<Fragment>
			{showEarlierDivider ? <EarlierDivider /> : null}
			<div
				className={`grid items-center border-t border-border px-5 py-3 transition-colors hover:bg-surface-soft ${
					layout === "dashboard"
						? "grid-cols-[64px_1fr_auto] gap-3.5"
						: "grid-cols-[54px_1fr_auto] gap-3"
				}`}
			>
				<PastSpeechDate year={row.deliveredYear} month={row.deliveredMonth} />
				<div className="min-w-0">
					<div className="truncate text-sm font-bold">{row.speechTitle}</div>
					<div className="truncate text-xs text-muted-foreground">
						{[project, "Not at a meeting"].filter(Boolean).join(" · ")}
					</div>
				</div>
				<div className="flex items-center gap-1">
					<PastBadge />
					{edit}
				</div>
			</div>
		</Fragment>
	);
}
