/**
 * What #1227's tests compare against, as `main` (#1230, before pagination)
 * rendered it: shared by the generator (`print-paginate-main-ref.gen.tsx`, run
 * on a checkout of that commit) and `print-paginate.test.tsx`, which reads the
 * committed `__snapshots__/print-paginate-main-baseline.json` it wrote.
 *
 * Both sides must render through the SAME props, so they are built here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
	MeetingAgendaPrint,
	type PrintDensity,
} from "#/components/agenda/meeting-agenda-print";
import {
	type PrintCompactFixtureId,
	printCompactAgenda,
} from "#/test/print-compact-fixtures";

export const QR_URL = "https://example.test/meeting";

/** The fixtures whose UNPAGINATED Timing markup is pinned, at both densities:
 *  an agenda that fits, the overflow fixture, and both contest agendas. SSR never
 *  measures, so each renders as the unpaginated two sheets whatever its length. */
export const MARKUP_FIXTURES: PrintCompactFixtureId[] = [
	"mcf",
	"thrLong",
	"contest7",
	"contestDense16",
];

/** The agendas that paginate, whose single compact sheet 2 on main is pinned
 *  as text (`reference`). */
export const REFERENCE_FIXTURES = {
	rep1: "contestDense20",
} as const satisfies Record<string, PrintCompactFixtureId>;

export type ReferenceId = keyof typeof REFERENCE_FIXTURES;

export function timingProps(fixture: PrintCompactFixtureId) {
	const a = printCompactAgenda(fixture);
	return {
		layout: "timing" as const,
		header: a.header,
		roles: a.roles,
		officers: a.officers,
		explainers: [],
		rows: a.rows,
		qrUrl: QR_URL,
	};
}

/** `renderToStaticMarkup` of Timing, starting at `density`. */
export function timingMarkup(
	fixture: PrintCompactFixtureId,
	density: PrintDensity,
): string {
	return renderToStaticMarkup(
		<MeetingAgendaPrint {...timingProps(fixture)} initialDensity={density} />,
	);
}

export const markupKey = (fixture: string, density: PrintDensity) =>
	`${fixture}|${density}`;
