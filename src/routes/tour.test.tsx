// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_CONNECTOR_SETUP_LINE } from "#/components/marketing/tour/assistant-demo";
import {
	FOUNDER_BLURB,
	PILOT_PRICING_LINE,
	TOASTMASTERS_DISCLAIMER,
} from "#/lib/brand";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { Route } from "./tour";

const SCENES = [
	"Claim a role in one tap.",
	"The agenda writes itself.",
	"Put it on the screen.",
	"Run the room.",
	"Between meetings, the officers' view.",
	"Works with your AI assistant.",
];

/** The five words the issue bans from this page's copy. */
const BANNED = ["streamline", "empower", "solution", "seamless", "leverage"];

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;
let socketSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchSpy = vi.fn(() => Promise.reject(new Error("no network in a demo")));
	vi.stubGlobal("fetch", fetchSpy);
	xhrOpen = vi.fn();
	vi.stubGlobal(
		"XMLHttpRequest",
		class {
			open = xhrOpen;
			send() {}
			setRequestHeader() {}
			addEventListener() {}
		},
	);
	beaconSpy = vi.fn(() => true);
	Object.defineProperty(navigator, "sendBeacon", {
		value: beaconSpy,
		configurable: true,
		writable: true,
	});
	socketSpy = vi.fn();
	vi.stubGlobal("WebSocket", socketSpy);
	vi.stubGlobal("EventSource", socketSpy);
	// Reduced motion, so the assistant demo shows both bubbles without an
	// IntersectionObserver (jsdom has none).
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: query.includes("prefers-reduced-motion: reduce"),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	// Not a global stub, so unstubAllGlobals leaves it; jsdom has no native one.
	Reflect.deleteProperty(navigator, "sendBeacon");
});

/** The route's `head` meta. It is synchronous here; the router's type allows a promise. */
function headMeta(): Array<Record<string, unknown> | undefined> {
	const head = Route.options.head?.({} as never) as
		| { meta?: Array<Record<string, unknown> | undefined> }
		| undefined;
	return head?.meta ?? [];
}

async function renderTour() {
	const Component = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Component />);
}

describe("/tour", () => {
	it("renders the six scenes as h2s, in order", async () => {
		await renderTour();
		const h2s = screen
			.getAllByRole("heading", { level: 2 })
			.map((h) => h.textContent ?? "");
		expect(h2s).toHaveLength(SCENES.length);
		SCENES.forEach((title, i) => {
			expect(h2s[i].startsWith(title)).toBe(true);
		});
	});

	it("marks the assistant scene Beta, with the connector setup line", async () => {
		await renderTour();
		const h2 = screen.getByRole("heading", {
			level: 2,
			name: /Works with your AI assistant/,
		});
		expect(within(h2).getByText("Beta")).toBeTruthy();
		expect(screen.getByText(AI_CONNECTOR_SETUP_LINE)).toBeTruthy();
	});

	it("shows the real screenshots in scenes 2, 3 and 5", async () => {
		await renderTour();
		const srcs = screen
			.getAllByRole("img")
			.map((img) => img.getAttribute("src"));
		expect(srcs).toEqual([
			"/landing/tour-agenda.png",
			"/landing/tour-present.png",
			"/landing/tour-vpe.png",
			"/landing/tour-vpm.png",
		]);
		for (const img of screen.getAllByRole("img")) {
			expect(img.getAttribute("alt")).toMatch(/Harbor City Speakers/);
		}
	});

	it("crops the agenda shot to its printed sheet, and leaves the present shot whole", async () => {
		await renderTour();
		const [agenda, present] = screen.getAllByRole("img");
		const agendaClasses = agenda.className.split(/\s+/);
		const presentClasses = present.className.split(/\s+/);
		for (const c of ["aspect-[816/1000]", "object-cover", "object-left-top"]) {
			expect(agendaClasses).toContain(c);
			expect(presentClasses).not.toContain(c);
		}
		expect(presentClasses).toContain("h-auto");
	});

	it("numbers the steps 1 to 6, with the officers' stop at 5 and the assistant at 6", async () => {
		await renderTour();
		const steps = Array.from(document.querySelectorAll("section[data-scene]"));
		expect(steps.map((s) => s.getAttribute("data-scene"))).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
		]);
		steps.forEach((section, i) => {
			expect(
				within(section as HTMLElement).getByText(`Step ${i + 1}`),
			).toBeTruthy();
		});
		const h2 = (n: number) =>
			(steps[n - 1] as HTMLElement).querySelector("h2")?.textContent ?? "";
		expect(h2(5)).toBe("Between meetings, the officers' view.");
		expect(h2(6).startsWith("Works with your AI assistant.")).toBe(true);
		expect(screen.getByText(/^Six stops\./)).toBeTruthy();
	});

	it("shows the VPE and VPM dashboards, stacked and uncropped, in the officers' stop", async () => {
		await renderTour();
		const scene = document.querySelector(
			'section[data-scene="5"]',
		) as HTMLElement;
		const imgs = within(scene).getAllByRole("img");
		expect(imgs.map((img) => img.getAttribute("src"))).toEqual([
			"/landing/tour-vpe.png",
			"/landing/tour-vpm.png",
		]);
		for (const img of imgs) {
			expect(img.getAttribute("alt")).toMatch(/Harbor City Speakers/);
			// The captures are 1600x900, not the 1600x1000 of the other shots.
			expect(img.getAttribute("width")).toBe("1600");
			expect(img.getAttribute("height")).toBe("900");
			const classes = img.className.split(/\s+/);
			expect(classes).toContain("h-auto");
			expect(classes).not.toContain("object-cover");
		}
		expect(imgs[0].getAttribute("alt")).toMatch(/VP Education/);
		expect(imgs[1].getAttribute("alt")).toMatch(/VP Membership/);
	});

	it("says, in the officers' stop, that GavelUp drafts and the officer sends", async () => {
		await renderTour();
		const scene = document.querySelector(
			'section[data-scene="5"]',
		) as HTMLElement;
		const text = scene.textContent ?? "";
		expect(text).toContain("GavelUp writes the draft. You send it.");
		expect(text).toMatch(/VP Education/);
		expect(text).toMatch(/VP Membership/);
		const words = Array.from(scene.querySelectorAll("p"))
			.filter((p) => !/^Step \d$/.test(p.textContent ?? ""))
			.map((p) => p.textContent ?? "")
			.join(" ")
			.split(/\s+/)
			.filter(Boolean).length;
		expect(words).toBeGreaterThanOrEqual(40);
		expect(words).toBeLessThanOrEqual(75);
	});

	it("closes with the pilot pricing line, the founder note and a /request-access link", async () => {
		await renderTour();
		expect(screen.getByText(PILOT_PRICING_LINE)).toBeTruthy();
		expect(screen.getByText(FOUNDER_BLURB)).toBeTruthy();
		const cta = screen.getByRole("link", { name: "Request access" });
		expect(cta.getAttribute("href")).toBe("/request-access");
		// After the last scene.
		const lastScene = screen.getByRole("heading", {
			level: 2,
			name: /Works with your AI assistant/,
		});
		expect(
			lastScene.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders inside MarketingShell, so the TI disclaimer is on the page", async () => {
		await renderTour();
		expect(
			within(screen.getByRole("contentinfo")).getByText(
				TOASTMASTERS_DISCLAIMER,
			),
		).toBeTruthy();
	});

	it("issues no network request, even after every demo is played", async () => {
		await renderTour();
		for (const b of screen.getAllByRole("button", { name: /^Claim / })) {
			fireEvent.click(b);
		}
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		fireEvent.click(screen.getByText("Speaker 2 · 5–7 min"));
		fireEvent.click(
			screen.getByRole("button", { name: "Vote for Priya Nair" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Vote again" }));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(xhrOpen).not.toHaveBeenCalled();
		expect(beaconSpy).not.toHaveBeenCalled();
		expect(socketSpy).not.toHaveBeenCalled();
	});

	it("contains none of the banned words", async () => {
		await renderTour();
		const text = (document.body.textContent ?? "").toLowerCase();
		const meta = headMeta()
			.map((m) => JSON.stringify(m))
			.join(" ")
			.toLowerCase();
		for (const word of BANNED) {
			expect(text).not.toContain(word);
			expect(meta).not.toContain(word);
		}
	});

	it("sets the title and an og:image of the printed agenda", () => {
		const meta = headMeta();
		expect(meta).toContainEqual({
			title: "How GavelUp works: a tour for Toastmasters officers",
		});
		expect(meta).toContainEqual({
			property: "og:image",
			content: "/landing/tour-agenda.png",
		});
		expect(meta.some((m) => m && "name" in m && m.name === "description")).toBe(
			true,
		);
	});
});
