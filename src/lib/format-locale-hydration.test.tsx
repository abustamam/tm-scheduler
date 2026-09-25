// @vitest-environment jsdom
//
// #708's acceptance: a server render and a client render under an `es-ES`
// runtime produce identical text for a formatted date and a dues amount.
//
// The date half rides `pinIntlTo` from the shared harness. The currency half
// needs `Intl.NumberFormat` pinned the same way, which the harness does not do,
// so `pinNumberFormatTo` below is its sibling — a subclass for the same reason
// `pinIntlTo` is one (Biome rewrites a function expression into an arrow, which
// is not a constructor).
import { afterEach, describe, expect, it } from "vitest";
import { formatCents } from "#/lib/dues";
import {
	APP_LOCALE,
	formatArchiveDate,
	formatMeetingDate,
	formatMeetingTime,
} from "#/lib/format";
import {
	assortedIntlRuntimes,
	hydrateAcrossRuntimes,
	pinIntlTo,
	restoreIntl,
	serverMarkupAcross,
} from "#/test/hydration-across-runtimes";

const RealNumberFormat = Intl.NumberFormat;

function pinNumberFormatTo(locale: string) {
	class PinnedNumberFormat extends RealNumberFormat {
		constructor(
			locales?: Intl.LocalesArgument,
			options?: Intl.NumberFormatOptions,
		) {
			super(locales ?? locale, options);
		}
	}
	Intl.NumberFormat = PinnedNumberFormat as unknown as typeof Intl.NumberFormat;
}

function runtime(locale: string, timeZone: string) {
	return () => {
		pinIntlTo(locale, timeZone);
		pinNumberFormatTo(locale);
	};
}

afterEach(() => {
	restoreIntl();
	Intl.NumberFormat = RealNumberFormat;
});

/** Wed Aug 20 2026, 19:00 in Los Angeles — the day #708 was reported against. */
const AT = new Date(Date.UTC(2026, 7, 21, 2, 0, 0));
const ZONE = "America/Los_Angeles";

/** A commitments row and a dues cell, the two surfaces the issue names. */
function Row() {
	return (
		<p>
			<span>{formatMeetingDate(AT, ZONE)}</span>
			<span>{formatMeetingTime(AT, ZONE)}</span>
			<span>{formatArchiveDate(AT, ZONE)}</span>
			<span>{formatCents(4500)}</span>
		</p>
	);
}

/**
 * The same row as it stood before #708: zone pinned, locale left to the
 * runtime. The control that makes the assertions below able to fail — if the
 * harness stopped reporting, this would go green too.
 */
function LegacyRow() {
	const date = new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: ZONE,
	}).format(AT);
	const money = new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
	}).format(45);
	return (
		<p>
			<span>{date}</span>
			<span>{money}</span>
		</p>
	);
}

describe("date and currency formatters under a non-English runtime (#708)", () => {
	it("CONTROL: the pre-#708 row mismatches when only the LOCALE differs", () => {
		const recovered = hydrateAcrossRuntimes(
			<LegacyRow />,
			runtime("en-US", "UTC"),
			runtime("es-ES", "UTC"),
		);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces a locale-only mismatch",
		).toMatch(/hydrat/i);
	});

	it("hydrates clean when the server is en-US and the browser es-ES", () => {
		const recovered = hydrateAcrossRuntimes(
			<Row />,
			runtime("en-US", "UTC"),
			runtime("es-ES", "UTC"),
		);
		expect(recovered).toEqual([]);
	});

	it("prints the same text under every runtime", () => {
		const distinct = serverMarkupAcross(
			assortedIntlRuntimes().map((pinDates, i) => () => {
				pinDates();
				pinNumberFormatTo(["en-US", "es-ES", "ja-JP", "de-DE"][i % 4]);
			}),
			() => <Row />,
		);
		expect(distinct.size).toBe(1);
	});

	it("renders in APP_LOCALE whatever the runtime says", () => {
		runtime("es-ES", "UTC")();
		expect(APP_LOCALE).toBe("en-US");
		expect(formatMeetingDate(AT, ZONE)).toBe("Thu, Aug 20");
		expect(formatCents(4500)).toBe("$45.00");
	});
});
