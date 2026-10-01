// @vitest-environment jsdom
//
// #1030: the time-zone picker's option labels must hydrate clean when the
// server's tz data and the browser's DISAGREE about a zone's offset.
//
// Production measured exactly that: the server (Node, `node:22-slim`) put
// Africa/Casablanca and Africa/El Aaiun at `GMT+0` while Chrome put them at
// `GMT+1`, so every load of /admin/club-settings threw React #418. The route
// hydration gate cannot hold this: its two ICUs (the runner's Node and its
// Chrome) agree or disagree about Morocco depending on the machine, not the
// code. Here the disagreement is forced, so it fails the same everywhere.
//
// Server-fn modules are mocked for the reason `club-settings.test.tsx` gives:
// they reach `#/db` → `pg`, which must not load under jsdom.
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	loadClubTimezoneSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
}));
vi.mock("#/server/notification-prefs", () => ({
	loadClubReminderSettings: vi.fn(),
	updateClubReminderSettings: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));
vi.mock("#/lib/club-logo-url", () => ({ clubLogoUrl: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
	hydrateAcrossRuntimes,
	restoreIntl,
} from "#/test/hydration-across-runtimes";
import { ZoneOptions, zoneLabel } from "./club-settings";

const ZONES = ["Africa/Casablanca", "America/Chicago"] as const;

/**
 * A runtime whose tz data puts Africa/Casablanca at `offset`. Every other zone
 * answers truthfully.
 *
 * A CLASS extending the real one, for the reason `pinIntlTo` gives: a
 * function expression gets rewritten into an arrow by `bun run fix`, `new`
 * then throws, and `zoneLabel`'s `catch` turns that into a bare name that
 * would hydrate clean for the wrong reason.
 */
function casablancaAt(offset: string) {
	return () => {
		restoreIntl();
		const Real = Intl.DateTimeFormat;
		class TzData extends Real {
			readonly #zone: string | undefined;
			constructor(
				locales?: Intl.LocalesArgument,
				options?: Intl.DateTimeFormatOptions,
			) {
				super(locales, options);
				this.#zone = options?.timeZone;
			}
			override formatToParts(date?: Date | number) {
				const parts = super.formatToParts(date);
				if (this.#zone !== "Africa/Casablanca") return parts;
				return parts.map((p) =>
					p.type === "timeZoneName" ? { ...p, value: offset } : p,
				);
			}
		}
		Intl.DateTimeFormat = TzData as unknown as typeof Intl.DateTimeFormat;
	};
}

/** Production's pair, as measured in #1030. */
const SERVER = casablancaAt("GMT+0");
const BROWSER = casablancaAt("GMT+1");

function Picker() {
	return (
		<select aria-label="Time zone" defaultValue="Africa/Casablanca">
			<ZoneOptions zones={ZONES} />
		</select>
	);
}

/** The picker as it stood before #1030: offsets computed during render. */
function LegacyPicker() {
	return (
		<select aria-label="Time zone" defaultValue="Africa/Casablanca">
			{ZONES.map((z) => (
				<option key={z} value={z}>
					{zoneLabel(z)}
				</option>
			))}
		</select>
	);
}

afterEach(() => {
	restoreIntl();
});

describe("time-zone picker across disagreeing tz data (#1030)", () => {
	it("CONTROL: offsets computed during render mismatch on hydration", () => {
		// What makes the assertion below able to fail: if the stub stopped
		// reaching `zoneLabel`, this would go clean too.
		const recovered = hydrateAcrossRuntimes(<LegacyPicker />, SERVER, BROWSER);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces the Morocco mismatch",
		).toMatch(/hydrat/i);
	});

	it("hydrates clean when the server and the browser disagree", () => {
		expect(hydrateAcrossRuntimes(<Picker />, SERVER, BROWSER)).toEqual([]);
	});

	it("puts no offset in the server's HTML", () => {
		SERVER();
		const html = renderToString(<Picker />);
		expect(html).toContain("Africa/Casablanca");
		expect(html).not.toMatch(/GMT/);
	});

	it("shows the BROWSER's offset once hydrated", () => {
		SERVER();
		const container = document.createElement("div");
		container.innerHTML = renderToString(<Picker />);
		document.body.appendChild(container);
		BROWSER();

		const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
		const prior = globals.IS_REACT_ACT_ENVIRONMENT;
		globals.IS_REACT_ACT_ENVIRONMENT = true;
		let root: ReturnType<typeof hydrateRoot> | undefined;
		try {
			act(() => {
				root = hydrateRoot(container, <Picker />);
			});
			const labels = [...container.querySelectorAll("option")].map(
				(o) => o.textContent,
			);
			expect(labels[0]).toBe("Africa/Casablanca (GMT+1)");
			expect(labels[1]).toMatch(/^America\/Chicago \(GMT-\d\)$/);
		} finally {
			act(() => root?.unmount());
			globals.IS_REACT_ACT_ENVIRONMENT = prior;
			container.remove();
		}
	});
});
