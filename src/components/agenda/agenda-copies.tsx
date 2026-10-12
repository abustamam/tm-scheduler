import {
	type ComponentProps,
	Fragment,
	type Ref,
	useEffect,
	useRef,
	useState,
} from "react";
import { AGENDA_LAYOUT_PAGES } from "#/lib/agenda-layouts";
import { MeetingAgendaPrint } from "./meeting-agenda-print";
import { PAGE_H, PAGE_OUTER } from "./print-theme";

type AgendaProps = ComponentProps<typeof MeetingAgendaPrint>;

/**
 * Printed pages a sheet of this rendered height occupies.
 *
 * A sheet is normally exactly `PAGE_H` (one page). `FitPage` lets a sheet whose
 * content will not scale legibly onto one page drop its fixed height and flow,
 * and then it is as tall as its content and the browser paginates it. The 2px
 * is `FitPage`'s own guard against the "content == page height" phantom page.
 */
export function sheetPages(height: number): number {
	return Math.max(1, Math.ceil((height - 2) / PAGE_H));
}

/**
 * Which copies are followed by a blank sheet when printing double-sided:
 * every copy EXCEPT the last whose printed page count is odd, since an odd
 * copy would otherwise leave the next copy starting on a back. `pages[i]` is
 * how many physical pages copy `i` really prints.
 */
export function blanksAfterCopies(
	pages: readonly number[],
	duplex: boolean,
): boolean[] {
	return pages.map((p, i) => duplex && i < pages.length - 1 && p % 2 === 1);
}

function BlankSheet() {
	return (
		<div
			className="agenda-page"
			data-agenda-blank=""
			data-testid="agenda-blank-sheet"
			aria-hidden="true"
			style={PAGE_OUTER}
		/>
	);
}

/**
 * The stack itself, given how many physical pages each copy prints. Separate
 * from the measuring `AgendaCopies` so a test can state the page counts rather
 * than needing a browser that runs `FitPage`.
 */
export function AgendaCopiesStack({
	pagesPerCopy,
	duplex,
	stackRef,
	...agenda
}: AgendaProps & {
	pagesPerCopy: readonly number[];
	duplex: boolean;
	stackRef?: Ref<HTMLDivElement>;
}) {
	const blanks = blanksAfterCopies(pagesPerCopy, duplex);
	return (
		// `.pgwrap` is the stack the two-page layouts already use: a column, so
		// one-page sheets (inline-block on screen) do not sit side by side, and
		// the print stylesheet zeroes its padding and gap.
		<div
			ref={stackRef}
			className="pgwrap"
			data-testid="agenda-copies"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 26,
			}}
		>
			{pagesPerCopy.map((_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: copies are identical and never reorder
				<Fragment key={i}>
					{i > 0 && blanks[i - 1] ? <BlankSheet /> : null}
					<MeetingAgendaPrint {...agenda} />
				</Fragment>
			))}
		</div>
	);
}

/**
 * The printed agenda, repeated `copies` times for the room (#1166).
 *
 * The print route renders a single copy as the bare agenda and uses this only
 * for two or more, so the single-copy page is untouched.
 *
 * DUPLEX. A copy that prints an odd number of pages leaves the next copy on
 * the back of its last page, so with `duplex` a blank sheet goes after every
 * such copy but the last. How many pages a copy prints is MEASURED, not read
 * off the layout: `AGENDA_LAYOUT_PAGES` says what a layout prints when it
 * fits, but `FitPage` lets a long agenda flow onto extra pages, and a rule
 * built on the nominal count would put copy 2 on a back exactly when the
 * agenda is longest. Until the first measurement, and wherever there is no
 * layout engine to ask, the nominal count stands in.
 *
 * The caller decides when to ask for more than one copy. The print route does
 * it only after mount: the offline service worker answers any `?copies=` URL
 * with the HTML it cached for `?layout=X`, and N copies in the first render
 * would not hydrate against it.
 */
export function AgendaCopies({
	copies,
	duplex,
	...agenda
}: AgendaProps & { copies: number; duplex: boolean }) {
	const stack = useRef<HTMLDivElement>(null);
	const nominal = AGENDA_LAYOUT_PAGES[agenda.layout];
	const [measured, setMeasured] = useState<number[] | null>(null);
	const count = Math.max(copies, 1);

	useEffect(() => {
		const root = stack.current;
		if (!root) return;
		const sheetsNow = () =>
			Array.from(
				root.querySelectorAll<HTMLElement>(
					".agenda-page:not([data-agenda-blank])",
				),
			);
		const measure = () => {
			const sheets = sheetsNow();
			// Every copy is `nominal` sheets, in document order: a layout's sheet
			// count does not change when its content overflows, only a sheet's height.
			const next = Array.from({ length: count }, (_, i) => {
				let pages = 0;
				for (let j = 0; j < nominal; j++) {
					const sheet = sheets[i * nominal + j];
					pages += sheet ? sheetPages(sheet.offsetHeight) : 1;
				}
				return pages;
			});
			setMeasured((prev) =>
				prev &&
				prev.length === next.length &&
				prev.every((p, i) => p === next[i])
					? prev
					: next,
			);
		};
		// `FitPage` drops a sheet's fixed height after the fonts load, so a sheet
		// can grow well after mount. A ResizeObserver per sheet hears that.
		//
		// The sheets it must hear are the CURRENT ones, not the ones present when
		// this effect ran (#1181): switching layout between two layouts with the
		// same page count (editorial <-> grid) swaps every `.agenda-page` for a
		// new element without changing `count` or `nominal`, so an observer armed
		// once was left watching detached nodes and the count stayed at the old
		// layout's, placing blanks for pages the new layout does not print.
		const resizes =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		const watched = new Set<Element>();
		const sync = () => {
			const current = new Set<Element>(sheetsNow());
			for (const el of watched) {
				if (current.has(el)) continue;
				resizes?.unobserve(el);
				watched.delete(el);
			}
			for (const el of current) {
				if (watched.has(el)) continue;
				resizes?.observe(el);
				watched.add(el);
			}
		};
		sync();
		measure();
		const swaps = new MutationObserver(() => {
			sync();
			measure();
		});
		swaps.observe(root, { childList: true, subtree: true });
		return () => {
			resizes?.disconnect();
			swaps.disconnect();
		};
	}, [count, nominal]);

	const pagesPerCopy =
		measured && measured.length === count
			? measured
			: Array.from({ length: count }, () => nominal as number);
	return (
		<AgendaCopiesStack
			pagesPerCopy={pagesPerCopy}
			duplex={duplex}
			stackRef={stack}
			{...agenda}
		/>
	);
}
