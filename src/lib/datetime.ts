/**
 * Convert a timezone-less wall-clock string to the UTC instant it denotes in
 * `timeZone`.
 *
 * **Two passes, and the second one is not optional (#547).** Treating the wall
 * components as UTC and correcting by the offset AT THAT INSTANT is only right
 * while the zone's offset is the same at both. Near a DST transition it is not:
 * the first lookup happens `offset` away from the real moment, so it can land on
 * the far side of the changeover and return an instant one hour off — silently,
 * with no error, redisplaying through `utcToZonedWallTime` as a different time
 * than the one that was typed. Re-resolving the offset at the CANDIDATE instant
 * and recomputing when the two disagree is what fixes it.
 *
 * Measured across all 419 selectable zones at 18:00-22:00 on days 1-28 of every
 * month of 2026 (`datetime-dst.test.ts` — the bound is the sweep's, so the last
 * two or three days of each month, including the 2026-03-29 EU spring-forward,
 * are NOT covered; swept by hand once at #547 and clean, but do not read the
 * test as "every day"): the single-pass version was wrong in 14 zones —
 * Sydney, Melbourne, Adelaide, Hobart, Broken Hill, Lord Howe, Auckland,
 * Chatham, Norfolk, Macquarie, McMurdo, Cairo, Beirut and Easter. Two passes
 * reduce that to zero.
 *
 * Why it was invisible until now: `America/Chicago` was this app's only
 * reachable zone (the column had no writer before #547) and its transition is at
 * 02:00 local, which no club meets across. The bug is old; making the other 418
 * zones selectable is what exposed it.
 *
 * A wall time inside a spring-forward GAP (e.g. 22:00 on Easter Island's
 * changeover day, where clocks jump straight to 23:00) names no instant at all.
 * This returns the adjacent one rather than throwing — the same thing
 * `datetime-local` inputs and most calendar software do. Which SIDE it lands on
 * is an artifact of the correction above, not a promise: Easter resolves
 * backward, to 21:00.
 */
export function zonedWallTimeToUtc(wall: string, timeZone: string): Date {
	// Parse the wall components.
	const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
	if (!m) throw new Error("Invalid date/time.");
	const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
	// Treat the components as if they were UTC, then correct by the zone's offset.
	const asUtc = Date.UTC(y, mo - 1, d, h, mi);
	const offset = zoneOffsetMs(asUtc, timeZone);
	const candidate = asUtc - offset;
	// Second pass: the offset that actually applies at the instant we landed on.
	const settled = zoneOffsetMs(candidate, timeZone);
	return new Date(settled === offset ? candidate : asUtc - settled);
}

/**
 * Inverse of `zonedWallTimeToUtc`: render a UTC instant as a
 * `YYYY-MM-DDTHH:mm` wall-clock string in `timeZone`, suitable for a
 * `datetime-local` input value.
 */
export function utcToZonedWallTime(instant: Date, timeZone: string): string {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const p = Object.fromEntries(
		dtf.formatToParts(instant).map((x) => [x.type, x.value]),
	);
	const hour = p.hour === "24" ? "00" : p.hour;
	return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

/** Offset (ms) of `timeZone` at the given instant: localWall - utc. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts = Object.fromEntries(
		dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
	);
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour === "24" ? "0" : parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
	return asUtc - utcMs;
}
