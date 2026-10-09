import { describe, expect, it } from "vitest";
import {
	checkAgendaFeatures,
	checkVpeHydrated,
	checkVpmFeatures,
	checkVpmHydrated,
} from "./marketing-screenshot-features";

const WA = "Message Marcus Lee on WhatsApp, opens in a new tab";
const SMS = "Text Omar Haddad by SMS";
const MAIL = "Email Nina Petrov";

/** A "Close to a level" section whose nudge links carry these labels. */
function vpe(labels: string[]): string {
	return `<main><section id="close-to-a-level"><h2>Close to a level</h2>${labels
		.map((l) => `<div><a href="https://wa.me/1" aria-label="${l}"></a></div>`)
		.join("")}</section></main>`;
}

describe("checkVpeHydrated", () => {
	it("passes nudges that lead with two different preferred methods", () => {
		expect(
			checkVpeHydrated(vpe([`${WA} (preferred)`, MAIL, `${SMS} (preferred)`])),
		).toBeNull();
	});

	it("fails the page the shot was taken from before it hydrated: no nudge", () => {
		expect(checkVpeHydrated(vpe([]))).toMatch(/no nudge draft link/);
	});

	it("does not take an unrelated label for a nudge", () => {
		expect(checkVpeHydrated(vpe(["Open navigation", "What's new"]))).toMatch(
			/no nudge draft link/,
		);
	});

	it("fails when no nudge marks a preferred method", () => {
		expect(checkVpeHydrated(vpe([WA, MAIL]))).toMatch(/marks 0 preferred/);
	});

	it("fails when only one method is preferred, even on several rows", () => {
		expect(
			checkVpeHydrated(vpe([`${WA} (preferred)`, `${WA} (preferred)`])),
		).toMatch(/marks 1 preferred/);
	});

	it("names a missing section", () => {
		expect(checkVpeHydrated("<main></main>")).toMatch(
			/no element with id="close-to-a-level"/,
		);
	});
});

interface VpmOptions {
	lane?: boolean;
	more?: boolean;
	resend?: boolean;
	captions?: string[];
}

/** A guest-pipeline section with the controls and captions `opts` asks for. */
function vpm(opts: VpmOptions = {}): string {
	const { lane = true, more = true, resend = true } = opts;
	const captions = opts.captions ?? [
		"Visiting Toastmaster, Bayview",
		"Guest speaker, Seaport Speakers",
	];
	return `<main><div id="guest-pipeline">${captions
		.map((c) => `<div data-slot="guest-kind-caption" class="x">${c}</div>`)
		.join(
			"",
		)}${lane ? '<button aria-label="Lane for Lucia Moreno: Prospect"></button>' : ""}${
		more ? '<button aria-label="More actions for Lucia Moreno"></button>' : ""
	}${resend ? '<fieldset aria-label="Resend invite"></fieldset>' : ""}</div></main>`;
}

describe("checkVpmFeatures", () => {
	it("passes a pipeline with both captions and every control", () => {
		expect(checkVpmFeatures(vpm())).toBeNull();
	});

	it("fails without the lane dropdown", () => {
		expect(checkVpmFeatures(vpm({ lane: false }))).toMatch(/no lane dropdown/);
	});

	it("fails without the ⋯ menu", () => {
		expect(checkVpmFeatures(vpm({ more: false }))).toMatch(/no ⋯ menu/);
	});

	it("fails when no guest is invited to the next meeting", () => {
		expect(checkVpmFeatures(vpm({ resend: false }))).toMatch(
			/no "Resend invite" control/,
		);
	});

	it("fails when a guest kind has no caption, naming it", () => {
		expect(
			checkVpmFeatures(vpm({ captions: ["Guest speaker, Seaport Speakers"] })),
		).toMatch(/"Visiting Toastmaster" caption/);
		expect(
			checkVpmFeatures(vpm({ captions: ["Visiting Toastmaster, Bayview"] })),
		).toMatch(/"Guest speaker" caption/);
	});

	it("does not take the label in prose for a caption", () => {
		const html = vpm({ captions: [] }).replace(
			"</div></main>",
			"<p>Visiting Toastmaster, Guest speaker</p></div></main>",
		);
		expect(checkVpmFeatures(html)).toMatch(/shows no "Visiting Toastmaster"/);
	});

	it("names a missing section", () => {
		expect(checkVpmFeatures("<main></main>")).toMatch(
			/no element with id="guest-pipeline"/,
		);
	});
});

describe("checkVpmHydrated", () => {
	const section = (inner: string) =>
		`<main><div id="guest-pipeline">${inner}</div></main>`;

	it("passes a WhatsApp draft link", () => {
		expect(
			checkVpmHydrated(
				section('<a href="https://wa.me/12025550150?text=Hi%20Lucia">x</a>'),
			),
		).toBeNull();
	});

	it("passes an email draft link", () => {
		expect(
			checkVpmHydrated(
				section('<a href="mailto:a@example.com?subject=Join%20us">x</a>'),
			),
		).toBeNull();
	});

	it("fails on the guest's own contact links, which the server draws", () => {
		expect(
			checkVpmHydrated(
				section(
					'<a href="https://wa.me/12025550150">+1</a><a href="mailto:a@example.com">a@example.com</a>',
				),
			),
		).toMatch(/no invite draft link/);
	});

	it("names a missing section", () => {
		expect(checkVpmHydrated("<main></main>")).toMatch(
			/no element with id="guest-pipeline"/,
		);
	});
});

describe("checkAgendaFeatures", () => {
	it("passes a roster naming a guest speaker", () => {
		expect(
			checkAgendaFeatures(
				"<span>Theo Marchetti · Guest speaker, Seaport Speakers</span>",
			),
		).toBeNull();
	});

	it("passes a roster naming a visiting Toastmaster", () => {
		expect(
			checkAgendaFeatures(
				"<span>Imani Clarke · Visiting Toastmaster, Bayview</span>",
			),
		).toBeNull();
	});

	it("fails when the only guest is a Visitor, who is captioned just 'Guest'", () => {
		expect(
			checkAgendaFeatures(
				"<span>Ben Carter · Guest</span><p>Guest speaker</p>",
			),
		).toMatch(/no guest kind caption/);
	});
});
