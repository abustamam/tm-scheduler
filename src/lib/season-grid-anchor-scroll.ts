/**
 * Bring the sign-up grid's anchor meeting into view CLEAR of the pinned label
 * column (#930).
 *
 * The grid pins its Role / Member column with `sticky left-0`, so the left part
 * of the scroller's box is covered. A bare
 * `scrollIntoView({ inline: "center" })` centres the anchor in the scroller's
 * WHOLE width and knows nothing about that: at 1280px the centre sits clear of
 * the label column, but on a 375px phone it put the next meeting's left half
 * underneath it — MEASURED on production at 210px of scroll, names reading
 * "az …mmed".
 *
 * The fix is `scroll-padding-left` equal to the pinned column's rendered width,
 * which `scrollIntoView` honours: the anchor is then aligned inside the
 * UNOBSCURED part of the box. The width is measured rather than fixed because
 * it is the widest role name or member name in the club's data, which no
 * constant can know. Centred when the column fits beside the pinned one, so a
 * wide screen still shows the meetings either side of it; start-aligned when
 * it does not, because a centred column wider than the room left spills its
 * left edge back under the label, which is the bug again.
 *
 * Self-contained on purpose — no imports, no module state — because
 * `season-grid-geometry.test.ts` runs THIS function's source inside headless
 * Chrome, so the gate measures the shipped logic rather than a restatement of
 * it.
 */
export function scrollAnchorClearOfPinnedColumn(
	scroller: HTMLElement,
	pinned: HTMLElement | null,
	anchor: HTMLElement,
): void {
	const pinnedWidth = pinned ? pinned.getBoundingClientRect().width : 0;
	scroller.style.scrollPaddingLeft = `${pinnedWidth}px`;
	const room = scroller.clientWidth - pinnedWidth;
	anchor.scrollIntoView({
		inline: anchor.getBoundingClientRect().width > room ? "start" : "center",
		block: "nearest",
	});
}
