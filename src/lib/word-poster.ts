// src/lib/word-poster.ts
//
// Display sizing for the Word of the Day poster
// (`components/agenda/word-of-the-day-poster.tsx`). "Apt" and
// "obstreperousness" cannot share a font size, and the poster's whole job is to
// be readable from the back of the room, so the word is sized from its length.
//
// Deterministic buckets rather than a measure-and-scale pass: this runs during
// SSR, needs no DOM, and is unit-testable. The poster also sets `overflowWrap`
// as a backstop for anything longer than the last bucket anticipates.

/** Longest word length that still earns each size, largest bucket first. */
const BUCKETS: readonly (readonly [maxLength: number, size: number])[] = [
	[6, 200],
	[10, 150],
	[14, 112],
	[18, 88],
];

/** Size for anything longer than the last bucket. */
const SMALLEST = 68;

/** Display font size in px for `word`, from its trimmed length. */
export function posterWordSize(word: string): number {
	const length = word.trim().length;
	for (const [maxLength, size] of BUCKETS) {
		if (length <= maxLength) return size;
	}
	return SMALLEST;
}
