import { listRoles } from "./list-roles";

/** A role definition's shape needed to generate slots. */
export type SlotGenInput = {
	id: string;
	defaultCount: number;
	enabled: boolean;
};

/** Generate one slot row per (definition × defaultCount), 0-based slotIndex.
 *  Definitions with `enabled: false` (#368 — a club's "skeleton crew" roles it
 *  has turned off) are skipped entirely: no slots are generated for them, but
 *  the definition row itself is untouched (disable, not delete — delete is
 *  blocked by `role_slots.role_definition_id`'s ON DELETE RESTRICT once any
 *  meeting has used the role). */
export function generateSlotRows(
	defs: SlotGenInput[],
	meetingId: string,
): { meetingId: string; roleDefinitionId: string; slotIndex: number }[] {
	return defs
		.filter((def) => def.enabled)
		.flatMap((def) =>
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

/** "Speaker 1" when a role repeats, otherwise just "Speaker" — and never
 *  numbered for an UNORDERED role (#624; `role_definitions.slots_unordered` in
 *  `schema.ts` says why). The flag is optional on the slot shape: callers that
 *  omit it keep numbering exactly as before. */
export function slotLabel(
	slot: { roleName: string; slotIndex: number; slotsUnordered?: boolean },
	roleCounts: Record<string, number>,
): string {
	if (slot.slotsUnordered) return slot.roleName;
	return roleCounts[slot.roleName] > 1
		? `${slot.roleName} ${slot.slotIndex + 1}`
		: slot.roleName;
}

/** The name a CONTROL on this slot is announced with: `slotLabel`, plus the
 *  holder's name for an unordered role (#624). Once "Contestant 1..4" all read
 *  "Contestant", four identical "Move Contestant up" buttons are
 *  indistinguishable to someone browsing by control — the number used to do
 *  that job, so the name takes it over. An ordered role keeps its number and
 *  needs nothing appended; an OPEN unordered slot has no name to append. */
export function slotAccessibleLabel(
	slot: {
		roleName: string;
		slotIndex: number;
		slotsUnordered?: boolean;
		assigneeName?: string | null;
	},
	roleCounts: Record<string, number>,
): string {
	const label = slotLabel(slot, roleCounts);
	return slot.slotsUnordered && slot.assigneeName
		? `${label} (${slot.assigneeName})`
		: label;
}

/** How an unfilled place reads in PROSE — the run of show, a multi-holder row
 *  and a collapsed roster entry all use this one string, so a partly-staffed
 *  role reads the same on every part of the sheet. Defined here rather than in
 *  `agenda-runsheet.ts` (which re-exports it) because that module imports from
 *  this one and the roster builder below needs it too. */
export const OPEN_LABEL = "— open —";

/** One row of the "Meeting Roles" roster (name null → open/unfilled). */
export type RosterEntry = {
	label: string;
	name: string | null;
	/** Set only on the ONE entry an unordered role collapses into (#624): how
	 *  many people `name` joins, open places not counted. Two or more is the
	 *  print layout's cue to give the entry a full row of the grid. */
	holderCount?: number;
	/** The same people `name` joins, UNJOINED — the layout input. A seven-name
	 *  prose list wrapped mid-sentence across the sheet and read as a paragraph,
	 *  so the print roster lays these out two to a row instead. Data beside the
	 *  prose for the same reason `AgendaRow.holders` is (#463): a joined string
	 *  forces one presentation on every layout and cannot be split back apart,
	 *  since a club's role names and the guest marker both contain the
	 *  separators a parser would key on. */
	holders?: string[];
};

/** Subtle marker appended to a guest assignee's name everywhere it renders
 *  (#151), e.g. "Ben Carter · Guest". */
export const GUEST_MARKER = "Guest";

/** Format an assignee's display name, appending the guest marker when the
 *  assignee is a non-member guest. Null name → null (caller shows "open"). */
export function assigneeDisplayName(
	name: string | null,
	isGuest?: boolean,
): string | null {
	if (!name) return null;
	return isGuest ? `${name} · ${GUEST_MARKER}` : name;
}

/** Minimal slot shape needed to order the meeting-roles roster. */
export type RosterSlot = {
	roleName: string;
	slotIndex: number;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	isSpeakerRole: boolean;
	assigneeName: string | null;
	/** True when the assignee is a non-member guest (#151) — renders "· Guest". */
	assigneeIsGuest?: boolean;
	/** See `role_definitions.slots_unordered` (#624). The roster collapses such
	 *  a role into one entry naming every holder; callers that omit the flag get
	 *  one numbered entry per slot, as before. */
	slotsUnordered?: boolean;
	/** Groups an unordered role's slots by DEFINITION when present, so an
	 *  ordered role that happens to share the name is not absorbed into the
	 *  collapsed entry. Fixtures without ids fall back to the name. */
	roleDefinitionId?: string;
};

/**
 * The single roster entry an UNORDERED role collapses into (#624): its bare
 * name and the people who hold it, both joined (`name`) and unjoined
 * (`holders`, which is what the sheet lays out in columns).
 *
 * NO open placeholder, unlike the multi-holder rows `agenda-template-rows.ts`
 * builds. There, one "— open —" is kept because an unstaffed Ballot Counter is
 * a job somebody still has to be recruited into. A contest is not staffed, it
 * is ENTERED: an unclaimed contestant place just means one fewer entrant, and a
 * placeholder trailing the speaking list reads as a gap someone ought to close.
 * The floor that rule exists to protect still holds — a role NOBODY holds
 * returns a null name and prints as open, so the row never silently vanishes.
 */
function collapsedRosterEntry(
	roleName: string,
	group: readonly RosterSlot[],
): RosterEntry {
	const names = group
		.map((g) => assigneeDisplayName(g.assigneeName, g.assigneeIsGuest))
		.filter((n): n is string => n != null);
	if (names.length === 0)
		return { label: roleName, name: null, holderCount: 0 };
	return {
		label: roleName,
		name: listRoles(names),
		holders: names,
		holderCount: names.length,
	};
}

/**
 * Order the meeting-roles roster so each speaker sits beside its paired
 * evaluator in the two-column print layout. Speakers and the paired evaluator
 * role are interleaved [Speaker 1, Evaluator 1, Speaker 2, Evaluator 2, …] in
 * place of the speaker block; every other role keeps its original position.
 *
 * The paired evaluator is the evaluator-category role with the most slots (tie
 * → first seen), matching the `pickSpeakerAndEvaluatorRoles` heuristic. In the
 * standard template that is "Evaluator" (3) uncontested, since General Evaluator
 * is a leadership role; the count tie-break still guards clubs that categorize
 * their GE as an evaluator. When there is no speaker or no such evaluator, the
 * roster is returned in its original order.
 *
 * Assumes the roles before the speaker block fill whole rows (the standard
 * template has two leadership roles), so the interleaved pairs start in the
 * left column and each speaker/evaluator pair shares a row.
 *
 * An UNORDERED role (#624) is one entry, not one per slot: it is collapsed
 * FIRST, carried by its first slot so it keeps the role's position, and the
 * pairing pass below never sees the role's other slots. Grouping is by role
 * DEFINITION where the slot carries one (the loaders do), by name otherwise,
 * and only ever gathers unordered slots — an ordered role sharing the name
 * keeps its own numbered entries. If a collapsed entry lands on either side of
 * the speaker/evaluator pairing, the roster keeps its original order instead:
 * pairing puts ONE speaker beside the ONE evaluator who evaluates them, and a
 * collapsed entry is a single item standing for the whole role — there is no
 * per-speaker partner to sit beside, however many holders it names (with two
 * or more it also takes the full row, so there is no shared row either).
 */
export function buildRosterEntries<T extends RosterSlot>(
	slots: T[],
): RosterEntry[] {
	const roleCounts = buildRoleCounts(slots);
	const groupKey = (s: RosterSlot) => s.roleDefinitionId ?? s.roleName;
	const items: { slot: T; entry: RosterEntry }[] = [];
	const collapsed = new Set<string>();
	for (const s of slots) {
		if (!s.slotsUnordered) {
			items.push({
				slot: s,
				entry: {
					label: slotLabel(s, roleCounts),
					name: assigneeDisplayName(s.assigneeName, s.assigneeIsGuest),
				},
			});
			continue;
		}
		const key = groupKey(s);
		if (collapsed.has(key)) continue;
		collapsed.add(key);
		items.push({
			slot: s,
			entry: collapsedRosterEntry(
				s.roleName,
				slots.filter((g) => g.slotsUnordered && groupKey(g) === key),
			),
		});
	}

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

	const speakers = items.filter((it) => it.slot.isSpeakerRole);
	const evaluators = pairedEvalName
		? items.filter((it) => it.slot.roleName === pairedEvalName)
		: [];
	// Any collapsed entry, not only a wide one: with 0 or 1 holders it still
	// stands for the whole role, so there is still no per-speaker partner.
	const collapsedSide = [...speakers, ...evaluators].some(
		(it) => it.entry.holderCount !== undefined,
	);
	if (speakers.length === 0 || evaluators.length === 0 || collapsedSide) {
		return items.map((it) => it.entry);
	}

	const interleaved: RosterEntry[] = [];
	const n = Math.max(speakers.length, evaluators.length);
	for (let i = 0; i < n; i++) {
		const sp = speakers[i];
		const ev = evaluators[i];
		if (sp) interleaved.push(sp.entry);
		if (ev) interleaved.push(ev.entry);
	}

	// Emit the interleaved block where the speaker block starts; drop the
	// speaker and paired-evaluator slots from their original spots.
	const result: RosterEntry[] = [];
	let emitted = false;
	for (const it of items) {
		if (it.slot.isSpeakerRole || it.slot.roleName === pairedEvalName) {
			if (!emitted) {
				result.push(...interleaved);
				emitted = true;
			}
			continue;
		}
		result.push(it.entry);
	}
	return result;
}

/** Where one roster entry lands in the two-column "Meeting Roles" grid. */
export type RosterGridPosition = {
	row: number;
	col: 0 | 1;
	wide: boolean;
	/** Nothing renders BELOW this cell in its column, so the boxed variant's
	 *  frame is what closes it and it draws no bottom rule of its own. Not the
	 *  same as "in the last row": an odd roster's final row holds one cell, and
	 *  the cell above the empty half has nothing under it either. Getting that
	 *  wrong hangs a rule inside the frame on every club's ordinary agenda, not
	 *  just a contest's — the roster has an odd entry count more often than not. */
	lastInColumn: boolean;
};

/**
 * Lay the roster into its two-column grid. An entry naming several people
 * (#624) takes a whole row — half a column cannot hold four surnames legibly —
 * and starts a fresh row when the left cell is already taken; everything else
 * fills left, then right. The print layout needs this to know which COLUMN an
 * entry occupies (the boxed variant tints the right one) and which cells have
 * nothing beneath them (`lastInColumn` — those draw no bottom rule, the frame
 * closes them): "odd index" and "the last two entries" stopped meaning those
 * things the moment a cell could span. A collapsed entry with one holder, or
 * none, is an ordinary cell — "Faisal Ali and — open —" fits half a row.
 */
export function rosterGridPositions(
	entries: readonly { holderCount?: number }[],
): RosterGridPosition[] {
	const placed: Omit<RosterGridPosition, "lastInColumn">[] = [];
	let row = 0;
	let col: 0 | 1 = 0;
	for (const e of entries) {
		if ((e.holderCount ?? 0) > 1) {
			if (col === 1) {
				row++;
				col = 0;
			}
			placed.push({ row, col: 0, wide: true });
			row++;
			continue;
		}
		placed.push({ row, col, wide: false });
		if (col === 0) {
			col = 1;
		} else {
			col = 0;
			row++;
		}
	}
	// A later WIDE entry sits under both columns, so it covers either one.
	return placed.map((p, i) => ({
		...p,
		lastInColumn: !placed
			.slice(i + 1)
			.some((later) => later.wide || later.col === p.col),
	}));
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
	// CODE POINTS, not UTF-16 code units. `name.slice(0, 4)` on a name with no
	// ASCII letters can cut a surrogate pair in half: `roleAbbrev("①🎤🎤")`
	// returned `"①🎤\ud83c"`, a lone high surrogate, which renders as a
	// replacement glyph on the attendance rail's badge and makes
	// `encodeURIComponent` throw `URIError: URI malformed` for any consumer that
	// builds a URL out of it. The cap is still four.
	if (words.length === 0) return [...name].slice(0, 4).join("") || "?";
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
	/** When this member last held the role being assigned, or null = never (#146). */
	lastServedAt: Date | null;
};

/** Picker sort tier (#377): 0 = available and unassigned (the real candidates),
 *  1 = already holding a role this meeting (still assignable — double-booking is
 *  sometimes deliberate), 2 = marked Not Available. Unavailable outranks
 *  already-assigned: "not coming at all" is a stronger signal than "here but
 *  busy", and collapsing the two into one bucket is what made the old order read
 *  as haphazard. */
function pickerTier(row: {
	unavailable: boolean;
	currentRole: string | null;
}): 0 | 1 | 2 {
	if (row.unavailable) return 2;
	return row.currentRole === null ? 0 : 1;
}

/** Build member-picker rows, sorted into three tiers (see `pickerTier`) and
 *  alphabetized within each; every row stays selectable. Unavailable members are
 *  sorted last rather than hidden behind a toggle — an officer sometimes must
 *  assign someone who said no, and a name the search box can't find is worse
 *  than one sitting at the bottom. `lastServedAt` maps memberId → the most
 *  recent prior date they held the role being assigned (null = never); it
 *  annotates rows but does NOT affect ordering (#146). */
export function buildPickerRows(
	roster: { id: string; name: string }[],
	roleByMemberId: Record<string, string>,
	unavailableIds: string[],
	lastServedAt: Record<string, Date | null> = {},
): PickerRow[] {
	const unavailable = new Set(unavailableIds);
	return roster
		.map((m) => ({
			id: m.id,
			name: m.name,
			unavailable: unavailable.has(m.id),
			currentRole: roleByMemberId[m.id] ?? null,
			lastServedAt: lastServedAt[m.id] ?? null,
		}))
		.sort((a, b) => {
			const tier = pickerTier(a) - pickerTier(b);
			// `localeCompare` stays the authority within a tier — Postgres
			// collation and it disagree on punctuation/case, and the roster
			// arrives in Postgres's order.
			return tier !== 0 ? tier : a.name.localeCompare(b.name);
		});
}

/** Muted "last time they did this role" label for the assign picker (#146),
 *  measured from `now`. `null` → "Never". */
export function formatLastServed(
	lastAt: Date | null,
	now: Date = new Date(),
): string {
	if (!lastAt) return "Never";
	const days = Math.floor((now.getTime() - lastAt.getTime()) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days} days ago`;
	if (days < 60) {
		const wks = Math.round(days / 7);
		return `${wks} wk${wks === 1 ? "" : "s"} ago`;
	}
	if (days < 365) {
		const mo = Math.round(days / 30);
		return `${mo} mo ago`;
	}
	const yrs = Math.floor(days / 365);
	return `${yrs} yr${yrs === 1 ? "" : "s"} ago`;
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
 *  the filled percentage (0 when there are no slots). A slot is "filled" when
 *  it has EITHER a member or a guest assignee (#151). */
export function summarizeAgenda(
	slots: {
		assigneeId: string | null;
		assigneeGuestId?: string | null;
		status: string;
		isSpeakerRole: boolean;
	}[],
): AgendaSummary {
	const isFilled = (s: {
		assigneeId: string | null;
		assigneeGuestId?: string | null;
	}) => Boolean(s.assigneeId) || Boolean(s.assigneeGuestId);
	const total = slots.length;
	const filled = slots.filter(isFilled).length;
	const confirmed = slots.filter((s) => s.status === "confirmed").length;
	const speakers = slots.filter((s) => s.isSpeakerRole);
	const speakerFilled = speakers.filter(isFilled).length;
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
