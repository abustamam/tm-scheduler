// The print route must hand `PrintAgendaView` the loader's OWN data object (#1225).
//
// `PrintAgendaView` resets the "this layout was too long, show Timing" fallback in
// an effect keyed on `[layout, source]`, where `source` is the object
// `Route.useLoaderData()` returns. TanStack Query / the router give a new object
// only when the agenda data is new, so the effect re-measures exactly then. A route
// that spreads or copies the data (`source={{ ...loaderData }}`) builds a fresh
// object on EVERY render: the effect fires every render, clears the fallback right
// after it was set, and the page flips between Grid and Timing forever.
//
// The Chrome suite renders `PrintAgendaView` with a stable stand-in for the
// loader, so it cannot see this wiring; the full 8,000-test suite also stayed green
// when the prop was swapped (the "route prop gates need a wiring guard" lesson).
// A source grep is the cheap observer. COMMENT-BLIND (`readSource`), so prose
// quoting the pattern cannot satisfy it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, "./club.$clubId_.meeting.$meetingId.print.tsx");

/** The body of `function PrintAgenda() { … }`, up to its closing top-level brace. */
function printAgendaBody(source: string): string {
	const start = source.indexOf("function PrintAgenda() {");
	if (start === -1) return "";
	const end = source.indexOf("\n}\n", start);
	return end === -1 ? "" : source.slice(start, end);
}

describe("print route wiring", () => {
	const body = printAgendaBody(readSource(ROUTE));

	// protects=the fallback reset keys on the loader's object identity
	// fails_when=`loaderData` is spread, copied or re-derived before it is bound
	// no_claim=that the loader returns a stable object (a router concern)
	it("binds the loader data directly, not a copy", () => {
		expect(body, "PrintAgenda not found in the route").not.toBe("");
		expect(body).toMatch(/\bconst loaderData = Route\.useLoaderData\(\);/);
	});

	// protects=PrintAgendaView receives the requested layout and that same object
	// fails_when=`source` is anything but `loaderData` itself (e.g. `{ ...loaderData }`),
	//   or `layout` is replaced by a derived value
	// no_claim=every other prop the view takes
	it("renders PrintAgendaView with layout={layout} and source={loaderData}", () => {
		const jsx = /<PrintAgendaView\b[^>]*?>/s.exec(body)?.[0] ?? "";
		expect(jsx, "no <PrintAgendaView in PrintAgenda").not.toBe("");
		expect(jsx).toMatch(/\blayout=\{layout\}/);
		expect(jsx).toMatch(/\bsource=\{loaderData\}/);
	});
});
