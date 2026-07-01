/** Convert a timezone-less wall-clock string to the UTC instant it denotes in `timeZone`. */
export function zonedWallTimeToUtc(wall: string, timeZone: string): Date {
	// Parse the wall components.
	const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
	if (!m) throw new Error("Invalid date/time.");
	const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
	// Treat the components as if they were UTC, then correct by the zone's offset.
	const asUtc = Date.UTC(y, mo - 1, d, h, mi);
	const offset = zoneOffsetMs(asUtc, timeZone);
	return new Date(asUtc - offset);
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
