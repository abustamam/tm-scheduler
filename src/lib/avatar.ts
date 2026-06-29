import type { MemberTone } from "#/data/club";

/** Two-letter initials from a name (or the first two chars of an email). */
export function initialsOf(nameOrEmail: string): string {
	const parts = nameOrEmail.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) {
		return (parts[0][0] + parts[1][0]).toUpperCase();
	}
	return nameOrEmail.slice(0, 2).toUpperCase();
}

const TONES: MemberTone[] = ["palm", "lagoon", "amber"];

/**
 * Deterministic avatar tone for a real person who has no designer-assigned
 * tone. Stable per seed (user id or name) so an avatar keeps its color.
 */
export function toneFromSeed(seed: string): MemberTone {
	let h = 0;
	for (let i = 0; i < seed.length; i++) {
		h = (h * 31 + seed.charCodeAt(i)) >>> 0;
	}
	return TONES[h % TONES.length];
}
