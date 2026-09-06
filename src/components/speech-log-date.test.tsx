// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
	assortedIntlRuntimes,
	hydrateAcrossRuntimes,
	pinIntlTo,
	restoreIntl,
	serverMarkupAcross,
} from "#/test/hydration-across-runtimes";
import { SpeechLogDate } from "./speech-log-date";

afterEach(() => {
	cleanup();
	restoreIntl();
});

/**
 * 2026-08-21 02:00 UTC — the same instant #608 was reported against. It is
 * Aug 21 in the UTC container Railway runs and Aug 20, 19:00 for a Los Angeles
 * member, so the day number differs, and `es-ES` spells the month AGO against
 * the server's AUG. One fixture exercises both halves.
 *
 * A fixed instant, deliberately: unlike the greeting, this render does NOT read
 * the clock. Moving the clock changes nothing here, which is exactly why the
 * greeting's seam could not have caught this and a second one was needed.
 */
const SPEECH_AT = new Date(Date.UTC(2026, 7, 21, 2, 0, 0));

/** The text a reader sees in server-rendered markup, with the tags stripped. */
function serverText(html: string): string {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el.textContent ?? "";
}

/**
 * The shipped code as it stood before this change — `dayMon` and its markup,
 * lifted verbatim out of `dashboard.tsx`.
 *
 * The control that makes the rest of this suite able to fail. It is also the
 * proof that the Intl seam is the RIGHT seam: swap `pinIntlTo` for a clock move
 * and this test goes green against the broken component.
 */
function LegacySpeechLogDate({ value }: { value: Date | string }) {
	const d = new Date(value);
	const day = new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(d);
	const mon = new Intl.DateTimeFormat(undefined, { month: "short" })
		.format(d)
		.toUpperCase();
	return (
		<div className="text-center leading-[1.1]">
			<div className="font-display text-lg font-semibold">{day}</div>
			<div className="text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)]">
				{mon}
			</div>
		</div>
	);
}

describe("SpeechLogDate hydration (#608)", () => {
	it("CONTROL: the pre-#608 date mismatches when the two runtimes disagree on the ZONE", () => {
		const recovered = hydrateAcrossRuntimes(
			<LegacySpeechLogDate value={SPEECH_AT} />,
			() => pinIntlTo("en-US", "UTC"),
			() => pinIntlTo("en-US", "America/Los_Angeles"),
		);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces the day-number half of #608",
		).toMatch(/hydrat/i);
	});

	// The second half, and the one a club in UTC is still exposed to: the LOCALE
	// is resolved from the runtime too, so `AGO` hydrates against `AUG` even when
	// both sides agree on the day.
	it("CONTROL: the pre-#608 date mismatches when the two runtimes disagree on the LOCALE alone", () => {
		const recovered = hydrateAcrossRuntimes(
			<LegacySpeechLogDate value={SPEECH_AT} />,
			() => pinIntlTo("en-US", "UTC"),
			() => pinIntlTo("es-ES", "UTC"),
		);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces the month-spelling half of #608",
		).toMatch(/hydrat/i);
	});

	it("hydrates clean across a zone disagreement", () => {
		const recovered = hydrateAcrossRuntimes(
			<SpeechLogDate value={SPEECH_AT} />,
			() => pinIntlTo("en-US", "UTC"),
			() => pinIntlTo("en-US", "America/Los_Angeles"),
		);
		expect(recovered).toEqual([]);
	});

	it("hydrates clean across a locale disagreement", () => {
		const recovered = hydrateAcrossRuntimes(
			<SpeechLogDate value={SPEECH_AT} />,
			() => pinIntlTo("en-US", "UTC"),
			() => pinIntlTo("es-ES", "UTC"),
		);
		expect(recovered).toEqual([]);
	});

	// The invariant, stated directly rather than sampled at one pair: the server
	// pass does not consult the runtime at all. Six locale/zone pairs spanning
	// both sides of the date boundary and four languages; the answer must be one
	// string.
	it("renders one and the same markup under every runtime, server-side", () => {
		const distinct = serverMarkupAcross(assortedIntlRuntimes(), () => (
			<SpeechLogDate value={SPEECH_AT} />
		));
		expect(distinct.size).toBe(1);
	});

	it("emits no date content at all before mount", () => {
		pinIntlTo("en-US", "UTC");
		// TEXT, not raw markup: the Tailwind class names carry digits of their own
		// (`leading-[1.1]`, `tracking-[0.05em]`), so a `/\d/` over the HTML string
		// can never fail and would be a test that asserts nothing.
		const text = serverText(
			renderToString(<SpeechLogDate value={SPEECH_AT} />),
		);
		// The direct statement of what "neutral" means for a DATE. There is no
		// generic date the way there is a generic greeting, so the honest neutral
		// is nothing — a reserved box. Digits are the day, letters the month.
		expect(text).not.toMatch(/\d/);
		expect(text).not.toMatch(/AUG|AGO|8月/i);
	});

	it("keeps the box occupied so the row does not reflow when the date lands", () => {
		pinIntlTo("en-US", "UTC");
		const text = serverText(
			renderToString(<SpeechLogDate value={SPEECH_AT} />),
		);
		// Exactly two non-breaking spaces, one per line. Empty divs would collapse
		// to zero height and the 64px grid column would jump when the effect fills
		// them in. Asserting the exact string also pins that BOTH slots are held,
		// which a `toContain` would not.
		expect(text).toBe("\u00A0\u00A0");
	});

	it("shows the viewer's own day and month once mounted", () => {
		pinIntlTo("en-US", "America/Los_Angeles");
		const { container } = render(<SpeechLogDate value={SPEECH_AT} />);
		// 02:00 UTC on the 21st is 19:00 on the 20th in Los Angeles. This is the
		// date the member's own calendar shows, and it is what this route rendered
		// client-side before the change too — the POST-mount output is unchanged,
		// only the server pass is.
		expect(container.textContent).toBe("20AUG");
	});

	it("follows the viewer's locale once mounted", () => {
		pinIntlTo("es-ES", "America/Los_Angeles");
		const { container } = render(<SpeechLogDate value={SPEECH_AT} />);
		expect(container.textContent).toBe("20AGO");
	});

	it("accepts the ISO string the loader actually serializes", () => {
		// `scheduledAt` arrives over the wire as a string on a client-side
		// navigation and as a `Date` on the SSR pass, so both shapes reach this
		// component in production.
		pinIntlTo("en-US", "America/Los_Angeles");
		render(<SpeechLogDate value={SPEECH_AT.toISOString()} />);
		expect(screen.getByText("20")).toBeTruthy();
	});

	it("keeps the day and month typography that moved out of the route", () => {
		pinIntlTo("en-US", "UTC");
		const { container } = render(<SpeechLogDate value={SPEECH_AT} />);
		const [dayEl, monEl] = Array.from(
			container.firstElementChild?.children ?? [],
		);
		expect(dayEl?.className).toContain("font-display");
		expect(dayEl?.className).toContain("text-lg");
		expect(monEl?.className).toContain("text-xs");
		expect(monEl?.className).toContain("tracking-[0.05em]");
	});
});
