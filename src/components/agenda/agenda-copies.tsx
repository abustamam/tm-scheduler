import { type ComponentProps, Fragment } from "react";
import { AGENDA_LAYOUT_PAGES } from "#/lib/agenda-layouts";
import { MeetingAgendaPrint } from "./meeting-agenda-print";
import { PAGE_OUTER } from "./print-theme";

type AgendaProps = ComponentProps<typeof MeetingAgendaPrint>;

/**
 * The printed agenda, repeated `copies` times for the room (#1166).
 *
 * `copies` of 1 or less renders the bare agenda, byte for byte what the print
 * page drew before this existed, so the single-copy page is untouched.
 *
 * DUPLEX. A one-page layout printed double-sided puts copy 2 on the back of
 * copy 1, so with `duplex` a blank sheet goes BETWEEN copies, never after the
 * last. A two-page layout already ends on a back, so it gets none. The rule
 * reads `AGENDA_LAYOUT_PAGES`, which `print-page-count.test.tsx` measures
 * against the real layouts.
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
	if (copies <= 1) return <MeetingAgendaPrint {...agenda} />;
	const blankBetween = duplex && AGENDA_LAYOUT_PAGES[agenda.layout] === 1;
	return (
		// `.pgwrap` is the stack the two-page layouts already use: a column, so
		// one-page sheets (inline-block on screen) do not sit side by side, and
		// the print stylesheet zeroes its padding and gap.
		<div
			className="pgwrap"
			data-testid="agenda-copies"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 26,
			}}
		>
			{Array.from({ length: copies }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: copies are identical and never reorder
				<Fragment key={i}>
					{i > 0 && blankBetween ? (
						<div
							className="agenda-page"
							data-testid="agenda-blank-sheet"
							aria-hidden="true"
							style={PAGE_OUTER}
						/>
					) : null}
					<MeetingAgendaPrint {...agenda} />
				</Fragment>
			))}
		</div>
	);
}
