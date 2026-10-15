/**
 * Browser half of `print-paginate-main-ref.gen.tsx`: renders Timing at `compact`
 * in a client root, read BEFORE any effect ran (`flushSync`, so `FitPage`'s font
 * wait has not resolved), which is the single flowing sheet 2 #1226/#1230 print,
 * and reports the text of the box around the run-of-show stamps for each
 * `REFERENCE_FIXTURES` scenario.
 *
 * Run ONLY on a checkout of `main` before #1227: on a later commit the box is
 * the paginated path's and the reference would be circular.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MeetingAgendaPrint } from "#/components/agenda/meeting-agenda-print";
import {
	REFERENCE_FIXTURES,
	type ReferenceId,
	timingProps,
} from "#/test/print-paginate-main-ref";

declare global {
	interface Window {
		__report: (v: unknown) => void;
	}
}

function referenceText(id: ReferenceId): string {
	const host = document.getElementById("root") as HTMLElement;
	host.replaceChildren();
	const root = createRoot(host);
	flushSync(() =>
		root.render(
			<MeetingAgendaPrint
				{...timingProps(REFERENCE_FIXTURES[id])}
				initialDensity="compact"
			/>,
		),
	);
	const sheet = document.querySelectorAll<HTMLElement>(".agenda-page")[1];
	const stamps = [...sheet.querySelectorAll<HTMLElement>("[data-row-time]")];
	// The nearest ancestor shared by every stamp: the run-of-show frame.
	let box: HTMLElement | null = stamps[0]?.parentElement ?? null;
	while (box && !stamps.every((st) => box?.contains(st)))
		box = box.parentElement;
	const text = (box?.innerText ?? "").replace(/\s+/g, " ").trim();
	root.unmount();
	return text;
}

try {
	const out: Record<string, string> = {};
	for (const id of Object.keys(REFERENCE_FIXTURES) as ReferenceId[])
		out[id] = referenceText(id);
	window.__report(out);
} catch (e) {
	document.documentElement.setAttribute(
		"data-error",
		encodeURIComponent(String((e as Error)?.stack ?? e)),
	);
}
