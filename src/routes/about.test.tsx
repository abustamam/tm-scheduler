// @vitest-environment jsdom
//
// `/about` rendered (#869): the sections it promises, that the founder section
// says exactly the confirmed blurb and nothing more, and that the data section
// describes rather than promises. The disclaimer is the marketing guard's
// (`marketing-disclaimer.guard.test.ts`), which enrols this route by content.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONTACT_MAILTO,
	FOUNDER_BLURB,
	TOASTMASTERS_DISCLAIMER,
} from "#/lib/brand";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { Route } from "./about";

afterEach(cleanup);

async function mount() {
	const Component = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Component />);
}

/** The `<section>` a level-2 heading names. */
function sectionFor(name: string): HTMLElement {
	const heading = screen.getByRole("heading", { level: 2, name });
	const section = heading.closest("section");
	if (!section) throw new Error(`"${name}" is not inside a <section>`);
	return section;
}

describe("/about", () => {
	it("renders its sections inside the marketing shell", async () => {
		await mount();
		expect(
			screen.getByRole("heading", { level: 1, name: "About GavelUp" }),
		).toBeTruthy();
		sectionFor("Who's behind GavelUp");
		sectionFor("What happens to your club's data");
		// The shell's footer, i.e. the TI disclaimer, is on the page.
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	// AC2: while FOUNDER_SECTIONS is empty the founder section is the blurb and
	// only the blurb. Anything more is an unconfirmed claim about a real person.
	it("says exactly FOUNDER_BLURB about the founder, in one paragraph", async () => {
		await mount();
		const paragraphs = sectionFor("Who's behind GavelUp").querySelectorAll("p");
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.textContent).toBe(FOUNDER_BLURB);
	});

	// AC3: the data section describes what the code does. A promise is the
	// maintainer's to make (#871), and these words are how one reads.
	it("makes no promises in the data section", async () => {
		await mount();
		const section = sectionFor("What happens to your club's data");
		const text = section.textContent ?? "";
		expect(section.querySelectorAll("li").length).toBeGreaterThan(0);
		for (const banned of [/\bnever\b/i, /\bsell/i, /\bguarantee/i]) {
			expect(text).not.toMatch(banned);
		}
	});

	it("points 'Get in touch' at the request form and the contact address", async () => {
		await mount();
		const section = within(sectionFor("Get in touch"));
		expect(
			section
				.getByRole("link", { name: "request access" })
				.getAttribute("href"),
		).toBe("/request-access");
		expect(
			section.getByRole("link", { name: "email us" }).getAttribute("href"),
		).toBe(CONTACT_MAILTO);
	});
});
