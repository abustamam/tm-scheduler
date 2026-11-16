/**
 * Where the presenter should be after the deck's slides changed (#1637): the
 * index of the slide that has the same key, else the same index clamped to the
 * last slide. Pure, so the rule is testable without rendering.
 */
export function remapSlideIndex(
	prevKeys: readonly string[],
	nextKeys: readonly string[],
	i: number,
): number {
	const key = prevKeys[i];
	const at = key === undefined ? -1 : nextKeys.indexOf(key);
	if (at >= 0) return at;
	return Math.max(0, Math.min(i, nextKeys.length - 1));
}
