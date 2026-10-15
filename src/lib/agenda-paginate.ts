// src/lib/agenda-paginate.ts
//
// The pure half of Timing's continuation sheets (#1227). No React, no DOM: the
// component measures real heights in the browser and hands the numbers here.

/**
 * Greedy fill: which units go on which sheet.
 *
 * `unitHeights[i]` is the height, at scale 1, of unit `i` of the run of show.
 * The first sheet has `firstCapacity` px to put units in, every later one
 * `restCapacity` (the first sheet carries the title and the column header, a
 * continuation sheet a slimmer header). Returns the unit indices of each sheet,
 * in order.
 *
 * - A unit NEVER splits: it goes whole on a sheet, or on the next one.
 * - Order is kept, and a sheet is only closed when the next unit would not fit,
 *   so nothing is moved ahead of something that came before it.
 * - A unit too tall for an EMPTY sheet is not refused and not cut: it stays on
 *   the sheet it is on, alone, and the next unit starts a new sheet. The sheet's
 *   `FitPage` then scales it, or flows it past `MIN_FIT_SCALE`, which is
 *   unsupported input (no real agenda has a unit near a sheet's height).
 * - No units, no sheets.
 */
export function paginate(
	unitHeights: readonly number[],
	firstCapacity: number,
	restCapacity: number,
): number[][] {
	const sheets: number[][] = [];
	let current: number[] = [];
	let used = 0;
	let capacity = firstCapacity;
	unitHeights.forEach((height, i) => {
		if (current.length > 0 && used + height > capacity) {
			sheets.push(current);
			current = [];
			used = 0;
			capacity = restCapacity;
		}
		current.push(i);
		used += height;
	});
	if (current.length > 0) sheets.push(current);
	return sheets;
}

/** What `unitsOf` needs to know about one printed entry of the run of show. */
export type UnitItem = {
	/** The presenter group the entry's row belongs to (`groupByPresenter`, as the
	 *  row's index into that grouping). Neighbours sharing it stay together. */
	group: number;
	/** A section band, or a hand-off that kept its own band: it introduces what
	 *  FOLLOWS it, so it must never be the last thing on a sheet. */
	head: boolean;
};

/**
 * The units `paginate` packs: runs of neighbouring entries that may not be
 * separated by a sheet break (#1227).
 *
 * A unit is one presenter group with the hand-offs folded into it (those ride
 * inside their entry already). A `head` entry is merged into the unit that
 * follows it, so a section band can never end a sheet with its segment on the
 * next; a head with nothing after it joins the unit before it. Returns the
 * entry indices of each unit, in order.
 */
export function unitsOf(items: readonly UnitItem[]): number[][] {
	const units: { indices: number[]; head: boolean }[] = [];
	items.forEach((item, i) => {
		const last = units.at(-1);
		const previous = last ? items[last.indices.at(-1) as number] : undefined;
		// A head is its own run until what follows it arrives; nothing joins a head
		// by group, since a section or a hand-off band is a group of one.
		if (
			last &&
			previous &&
			!previous.head &&
			!item.head &&
			previous.group === item.group
		)
			last.indices.push(i);
		else units.push({ indices: [i], head: item.head });
	});
	const merged: number[][] = [];
	let carried: number[] = [];
	for (const unit of units) {
		if (unit.head) {
			carried.push(...unit.indices);
			continue;
		}
		merged.push([...carried, ...unit.indices]);
		carried = [];
	}
	// Heads with nothing after them (a trailing hand-off band) stay with the last
	// unit, or are the only unit when the whole run is heads.
	if (carried.length > 0) {
		const tail = merged.at(-1);
		if (tail) tail.push(...carried);
		else merged.push(carried);
	}
	return merged;
}
