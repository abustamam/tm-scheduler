// Pure, client-safe dues helpers (#206). NO `#/db` import lives here so both the
// server logic (`src/server/dues-logic.ts`) and the client route
// (`src/routes/_authed/admin/dues.tsx`) can use these without dragging `pg` into
// the browser bundle. Money is integer cents everywhere; format only at the edge.

/** A period, reduced to what the "which period is active?" pick needs. */
export interface PeriodLike {
	id: string;
	dueDate: Date | string;
}

function asTime(value: Date | string): number {
	return (typeof value === "string" ? new Date(value) : value).getTime();
}

/**
 * The period the Treasurer view defaults to. A period's window runs from its
 * own `due_date` up to the next period's `due_date`, so the ACTIVE period is the
 * one whose window contains `now` — i.e. the latest period with `due_date ≤ now`.
 * When every period is still upcoming, fall back to the nearest upcoming (the
 * earliest `due_date`). Returns null only when there are no periods. `periods`
 * need not be pre-sorted.
 */
export function selectActivePeriodId(
	periods: readonly PeriodLike[],
	now: Date = new Date(),
): string | null {
	if (periods.length === 0) return null;
	const sorted = [...periods].sort(
		(a, b) => asTime(a.dueDate) - asTime(b.dueDate),
	);
	const nowMs = now.getTime();
	let active: PeriodLike | null = null;
	for (const p of sorted) {
		if (asTime(p.dueDate) <= nowMs) active = p;
	}
	// `active` = latest period already due; else the earliest upcoming one.
	return (active ?? sorted[0])?.id ?? null;
}

// ---------------------------------------------------------------------------
// Money (integer cents ⇄ display)
// ---------------------------------------------------------------------------

/** Parse a dollars string (e.g. "45", "45.50") to integer cents, or null when
 *  blank. Throws on a malformed amount so the caller can surface the error. */
export function dollarsToCents(input: string): number | null {
	const trimmed = input.trim();
	if (trimmed === "") return null;
	const cleaned = trimmed.replace(/[$,\s]/g, "");
	if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
		throw new Error("Enter a dollar amount like 45 or 45.50.");
	}
	return Math.round(Number.parseFloat(cleaned) * 100);
}

/** Integer cents → a plain dollars string for an <input> (no currency symbol). */
export function centsToInput(cents: number | null | undefined): string {
	if (cents == null) return "";
	return (cents / 100).toFixed(2);
}

/** Integer cents → a localized currency string (USD), e.g. "$45.00". */
export function formatCents(cents: number | null | undefined): string {
	if (cents == null) return "—";
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
	}).format(cents / 100);
}

// ---------------------------------------------------------------------------
// Toastmasters International renewal presets (Apr 1 / Oct 1)
// ---------------------------------------------------------------------------

export interface RenewalPreset {
	key: "apr" | "oct";
	/** Short chip label, e.g. "Apr 1". */
	short: string;
	/** 0-based month for `new Date(y, month, day)`. */
	month: number;
	day: number;
}

/** The two Toastmasters International membership-renewal dates, offered as
 *  one-click presets in the create-period UI (semi-annual is the default). */
export const TI_RENEWAL_PRESETS: readonly RenewalPreset[] = [
	{ key: "apr", short: "Apr 1", month: 3, day: 1 },
	{ key: "oct", short: "Oct 1", month: 9, day: 1 },
];

/** The next occurrence of a preset's month/day on or after `now` (local). */
export function nextRenewalDate(
	preset: RenewalPreset,
	now: Date = new Date(),
): Date {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let d = new Date(now.getFullYear(), preset.month, preset.day);
	if (d.getTime() < today.getTime()) {
		d = new Date(now.getFullYear() + 1, preset.month, preset.day);
	}
	return d;
}

/** A default period label for a preset + resolved date, e.g. "2026 Apr 1 renewal". */
export function renewalLabel(preset: RenewalPreset, date: Date): string {
	return `${date.getFullYear()} ${preset.short} renewal`;
}

/** A local Date → the "yyyy-mm-dd" value an <input type="date"> expects. */
export function toDateInputValue(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
