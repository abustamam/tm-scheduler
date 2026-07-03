/** A role definition's shape needed to generate slots. */
export type SlotGenInput = { id: string; defaultCount: number };

/** Generate one slot row per (definition × defaultCount), 0-based slotIndex. */
export function generateSlotRows(
	defs: SlotGenInput[],
	meetingId: string,
): { meetingId: string; roleDefinitionId: string; slotIndex: number }[] {
	return defs.flatMap((def) =>
		Array.from({ length: def.defaultCount }, (_, i) => ({
			meetingId,
			roleDefinitionId: def.id,
			slotIndex: i,
		})),
	);
}

/** Build the count of slots per role name (for numbering repeated roles). */
export function buildRoleCounts<T extends { roleName: string }>(
	slots: T[],
): Record<string, number> {
	return slots.reduce<Record<string, number>>((acc, s) => {
		acc[s.roleName] = (acc[s.roleName] ?? 0) + 1;
		return acc;
	}, {});
}

/** "Speaker 1" when a role repeats, otherwise just "Speaker". */
export function slotLabel(
	slot: { roleName: string; slotIndex: number },
	roleCounts: Record<string, number>,
): string {
	return roleCounts[slot.roleName] > 1
		? `${slot.roleName} ${slot.slotIndex + 1}`
		: slot.roleName;
}

type EvaluatorRow = {
	id: string;
	evaluatesSlotId: string | null;
	assigneeName: string | null;
	speechTitle: string | null;
};

/** Attach `evaluates` (the speaker slot this row evaluates) by id lookup. */
export function resolveEvaluatorLinks<T extends EvaluatorRow>(
	rows: T[],
): (T & {
	evaluates: {
		slotId: string;
		speakerName: string | null;
		speechTitle: string | null;
	} | null;
})[] {
	const bySlotId = new Map(rows.map((r) => [r.id, r]));
	return rows.map((r) => {
		const target = r.evaluatesSlotId
			? bySlotId.get(r.evaluatesSlotId)
			: undefined;
		return {
			...r,
			evaluates: target
				? {
						slotId: target.id,
						speakerName: target.assigneeName,
						speechTitle: target.speechTitle,
					}
				: null,
		};
	});
}

const STOPWORDS = new Set(["of", "the", "and", "a", "an", "to"]);

/**
 * Clean short codes for common single-word Toastmasters roles. These read as
 * intentional abbreviations rather than mid-word truncations. Roles not listed
 * fall back to the general consonant rule in `singleWordAbbrev`.
 */
const SINGLE_WORD_CODES = new Map<string, string>([
	["speaker", "SP"],
	["timer", "TMR"],
	["evaluator", "EV"],
	["grammarian", "GRM"],
]);

/**
 * Short code for a single word: an uppercase initial followed by its next
 * consonants (vowels dropped), capped at 3 chars. Yields readable codes like
 * "Timer" → TMR, "Grammarian" → GRM, "Wordmaster" → WRD. A small set of common
 * roles (see `SINGLE_WORD_CODES`) is special-cased for the cleanest result.
 */
function singleWordAbbrev(w: string): string {
	const special = SINGLE_WORD_CODES.get(w.toLowerCase());
	if (special) return special;
	const upper = w.toUpperCase();
	const consonants = upper.slice(1).replace(/[AEIOU]/g, "");
	return (upper[0] + consonants).slice(0, 3);
}

/** Deterministic base abbreviation for a role name. */
export function roleAbbrev(name: string): string {
	const words = name
		.split(/[^A-Za-z]+/)
		.filter((w) => w.length > 0 && !STOPWORDS.has(w.toLowerCase()));
	if (words.length === 0) return name.slice(0, 4) || "?";
	if (words.length >= 2) {
		return words
			.map((w) => (w[0] ?? "").toUpperCase())
			.join("")
			.slice(0, 4);
	}
	const w = words[0];
	if (!w) return "?";
	return singleWordAbbrev(w);
}

export type ShortCodeInput = {
	roleDefinitionId: string;
	slotIndex: number;
	name: string;
};

/**
 * Build unique short codes keyed `${roleDefinitionId}:${slotIndex}`.
 * Repeated roles get a 1-based number; different names that collapse to the
 * same base get a `#2`, `#3` … suffix in input order.
 *
 * Rows sharing the same human-readable `name` intentionally share a code; the
 * caller must ensure role names are unique per club. The disambiguation only
 * triggers for *different* names colliding on the same base code.
 */
export function buildShortCodes(rows: ShortCodeInput[]): Map<string, string> {
	// Counts slots per definition id (reusing buildRoleCounts; `roleName` here
	// = `roleDefinitionId`).
	const countByDef = buildRoleCounts(
		rows.map((r) => ({ roleName: r.roleDefinitionId })),
	);
	const baseByName = new Map<string, string>();
	const seenBases = new Map<string, string>(); // base -> first roleDefinitionId
	const result = new Map<string, string>();

	for (const r of rows) {
		let base = baseByName.get(r.name);
		if (base === undefined) {
			base = roleAbbrev(r.name);
			const owner = seenBases.get(base);
			if (owner !== undefined && owner !== r.roleDefinitionId) {
				let n = 2;
				while (seenBases.has(`${base}#${n}`)) n += 1;
				base = `${base}#${n}`;
			}
			seenBases.set(base, r.roleDefinitionId);
			baseByName.set(r.name, base);
		}
		const repeated = (countByDef[r.roleDefinitionId] ?? 0) > 1;
		result.set(
			`${r.roleDefinitionId}:${r.slotIndex}`,
			repeated ? `${base}${r.slotIndex + 1}` : base,
		);
	}
	return result;
}

/** Which server fn an assign action maps to for a given slot. */
export function resolveAssignAction(slot: {
	status: "open" | "claimed" | "confirmed";
	isSpeakerRole: boolean;
}): { kind: "claim" | "reassign"; speakerTba: boolean } {
	if (slot.status === "open") {
		return { kind: "claim", speakerTba: slot.isSpeakerRole };
	}
	return { kind: "reassign", speakerTba: false };
}

export type PickerRow = {
	id: string;
	name: string;
	unavailable: boolean;
	currentRole: string | null;
};

/** Build member-picker rows. Members flagged unavailable-for-this-meeting or
 *  already holding a role this meeting sort after unflagged members (then by
 *  name); all remain selectable. */
export function buildPickerRows(
	roster: { id: string; name: string }[],
	roleByMemberId: Record<string, string>,
	unavailableIds: string[],
): PickerRow[] {
	const unavailable = new Set(unavailableIds);
	return roster
		.map((m) => ({
			id: m.id,
			name: m.name,
			unavailable: unavailable.has(m.id),
			currentRole: roleByMemberId[m.id] ?? null,
		}))
		.sort((a, b) => {
			const aFlag = a.unavailable || a.currentRole !== null;
			const bFlag = b.unavailable || b.currentRole !== null;
			if (aFlag !== bFlag) return aFlag ? 1 : -1;
			return a.name.localeCompare(b.name);
		});
}
