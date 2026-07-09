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

/** One row of the "Meeting Roles" roster (name null → open/unfilled). */
export type RosterEntry = { label: string; name: string | null };

/** Minimal slot shape needed to order the meeting-roles roster. */
export type RosterSlot = {
	roleName: string;
	slotIndex: number;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	isSpeakerRole: boolean;
	assigneeName: string | null;
};

/**
 * Order the meeting-roles roster so each speaker sits beside its paired
 * evaluator in the two-column print layout. Speakers and the paired evaluator
 * role are interleaved [Speaker 1, Evaluator 1, Speaker 2, Evaluator 2, …] in
 * place of the speaker block; every other role keeps its original position.
 *
 * The paired evaluator is the evaluator-category role with the most slots (tie
 * → first seen) — "Evaluator" (3), not "General Evaluator" (1), matching the
 * `pickSpeakerAndEvaluatorRoles` heuristic. When there is no speaker or no such
 * evaluator, the roster is returned in its original order.
 *
 * Assumes the roles before the speaker block fill whole rows (the standard
 * template has two leadership roles), so the interleaved pairs start in the
 * left column and each speaker/evaluator pair shares a row.
 */
export function buildRosterEntries<T extends RosterSlot>(
	slots: T[],
): RosterEntry[] {
	const roleCounts = buildRoleCounts(slots);
	const entry = (s: T): RosterEntry => ({
		label: slotLabel(s, roleCounts),
		name: s.assigneeName ?? null,
	});

	// Paired evaluator = evaluator-category role with the most slots.
	const evalCounts = new Map<string, number>();
	for (const s of slots) {
		if (s.category === "evaluator") {
			evalCounts.set(s.roleName, (evalCounts.get(s.roleName) ?? 0) + 1);
		}
	}
	let pairedEvalName: string | null = null;
	let bestCount = 0;
	for (const [name, count] of evalCounts) {
		if (count > bestCount) {
			bestCount = count;
			pairedEvalName = name;
		}
	}

	const speakers = slots.filter((s) => s.isSpeakerRole);
	const evaluators = pairedEvalName
		? slots.filter((s) => s.roleName === pairedEvalName)
		: [];
	if (speakers.length === 0 || evaluators.length === 0) {
		return slots.map(entry);
	}

	const interleaved: RosterEntry[] = [];
	const n = Math.max(speakers.length, evaluators.length);
	for (let i = 0; i < n; i++) {
		const sp = speakers[i];
		const ev = evaluators[i];
		if (sp) interleaved.push(entry(sp));
		if (ev) interleaved.push(entry(ev));
	}

	// Emit the interleaved block where the speaker block starts; drop the
	// speaker and paired-evaluator slots from their original spots.
	const result: RosterEntry[] = [];
	let emitted = false;
	for (const s of slots) {
		if (s.isSpeakerRole || s.roleName === pairedEvalName) {
			if (!emitted) {
				result.push(...interleaved);
				emitted = true;
			}
			continue;
		}
		result.push(entry(s));
	}
	return result;
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

export type AgendaSummary = {
	total: number;
	filled: number;
	open: number;
	pct: number;
	confirmed: number;
	speakerTotal: number;
	speakerFilled: number;
};

/** At-a-glance counts for a meeting's slots: fill/confirm/speaker tallies and
 *  the filled percentage (0 when there are no slots). */
export function summarizeAgenda(
	slots: {
		assigneeId: string | null;
		status: string;
		isSpeakerRole: boolean;
	}[],
): AgendaSummary {
	const total = slots.length;
	const filled = slots.filter((s) => s.assigneeId).length;
	const confirmed = slots.filter((s) => s.status === "confirmed").length;
	const speakers = slots.filter((s) => s.isSpeakerRole);
	const speakerFilled = speakers.filter((s) => s.assigneeId).length;
	return {
		total,
		filled,
		open: total - filled,
		pct: total === 0 ? 0 : Math.round((filled / total) * 100),
		confirmed,
		speakerTotal: speakers.length,
		speakerFilled,
	};
}
