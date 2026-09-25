// @vitest-environment jsdom
//
// `/about` rendered (#869, #871): the sections it promises, that the founder
// section says exactly the approved copy and nothing more, that the data section
// carries the facts then the maintainer's commitments and none of the banned
// words, and that no sentence claims deletion or export (#914, #915). The
// disclaimer is the marketing guard's (`marketing-disclaimer.guard.test.ts`),
// which enrols this route by content.
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

/**
 * The bio approved on #871 (2026-09-25), verbatim. Literals, not the route's
 * constant: the copy was approved word for word, so a test that read the
 * constant back would agree with any edit to it.
 */
const APPROVED_BIO = [
	"By day, I'm a software engineer at Salty, where I build tools that help drivers find better car insurance without the paperwork. I've been shipping software since 2016.",
	"In Toastmasters, I chartered Simply the Best at Kaiser South Sacramento, served as an Area Director in 2014, and I'm chartering THR Speaking Club in Roseville, in District 206, right now.",
	"As a VP Education, I ran sign-ups on a shared spreadsheet. Two people could claim the same role, nothing checked the entries, and I had no easy way to see who'd done which role or how the club was growing. The club software I tried wasn't much better: hard to use, and it signed me out constantly. Filling a role as Toastmaster meant clicking a name, finding a phone number in a pop-up, copying it into my messaging app and pasting in a message, once for every person.",
	"So I built GavelUp to do that busywork: one sign-up sheet that can't double-book, role history at a glance, contact details one tap from a ready-to-send message, and the agenda and slide deck built for you. (I really don't like PowerPoint.) When I was VP Membership, I wanted every guest in one place, so inviting them back to the next meeting is easy.",
	"What GavelUp won't do is talk to your members for you. Members still reach out to each other about roles; GavelUp just makes that quicker.",
];

/** The data commitments approved on #871 (2026-09-25), verbatim. */
const APPROVED_PROMISES = [
	"GavelUp doesn't share your club's data with advertisers or data brokers.",
	"GavelUp shares your club's data only with the services that run it: Railway (hosting), Resend (email), and Anthropic, if a member connects Claude.",
	"Your club's data is used only to run GavelUp for your club.",
];

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
		sectionFor("Get in touch");
		// The shell's footer, i.e. the TI disclaimer, is on the page.
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	// #871 AC1: the founder section is the blurb, then the approved bio, in
	// order, and nothing else. Anything more is an unapproved claim about a
	// real person.
	it("says exactly FOUNDER_BLURB and the five approved paragraphs, in order", async () => {
		await mount();
		const paragraphs = [
			...sectionFor("Who's behind GavelUp").querySelectorAll("p"),
		].map((p) => p.textContent);
		expect(paragraphs).toEqual([FOUNDER_BLURB, ...APPROVED_BIO]);
	});

	// #871 AC1/AC3: the banner (eager, captioned, first under the heading) and
	// the headshot (lazy, beside the blurb), both from public/about/ and both
	// with explicit dimensions so they reserve their space before loading.
	it("shows the stage banner and the headshot from public/about/", async () => {
		await mount();
		const section = sectionFor("Who's behind GavelUp");

		const banner = within(section).getByRole("img", {
			name: "Rasheed Bustamam speaking on stage to a large audience",
		});
		expect(banner.getAttribute("src")).toBe("/about/rasheed-speaking.webp");
		expect(banner.getAttribute("width")).toBe("1400");
		expect(banner.getAttribute("height")).toBe("350");
		expect(banner.getAttribute("loading")).toBeNull();
		expect(banner.className).toContain("w-full");
		expect(banner.className).toContain("object-cover");
		const figure = banner.closest("figure");
		expect(figure?.querySelector("figcaption")?.textContent).toBe(
			"Speaking to an audience of 700.",
		);
		expect(section.querySelector("h2")?.nextElementSibling).toBe(figure);

		const headshot = within(section).getByRole("img", {
			name: "Rasheed Bustamam",
		});
		expect(headshot.getAttribute("src")).toBe("/about/rasheed-headshot.png");
		expect(headshot.getAttribute("width")).toBe("400");
		expect(headshot.getAttribute("height")).toBe("400");
		expect(headshot.getAttribute("loading")).toBe("lazy");
		expect(headshot.className).toContain("rounded-full");
		// Beside the blurb from `sm` up, stacked above it below.
		const row = headshot.parentElement;
		expect(row?.querySelector("p")?.textContent).toBe(FOUNDER_BLURB);
		expect(row?.className).toContain("flex-col");
		expect(row?.className).toContain("sm:flex-row");
	});

	// #871 AC2: the five facts, then the three commitments verbatim, in order.
	it("lists the data facts, then the maintainer's three commitments", async () => {
		await mount();
		const items = [
			...sectionFor("What happens to your club's data").querySelectorAll("li"),
		].map((li) => li.textContent);
		expect(items).toHaveLength(5 + APPROVED_PROMISES.length);
		expect(items.slice(5)).toEqual(APPROVED_PROMISES);
	});

	// The whole data section, commitments included, stays clear of the words
	// that overclaim.
	it("uses none of the banned words in the data section", async () => {
		await mount();
		const section = sectionFor("What happens to your club's data");
		const text = section.textContent ?? "";
		expect(section.querySelectorAll("li").length).toBeGreaterThan(0);
		for (const banned of [/\bnever\b/i, /\bsell/i, /\bguarantee/i]) {
			expect(text).not.toMatch(banned);
		}
	});

	// #871 AC4: deletion on request and self-serve export are false today, so
	// the page says neither until the change that makes each true (#914, #915).
	it("says nothing about deleting or exporting club data", async () => {
		await mount();
		const text = screen.getByRole("main").textContent ?? "";
		for (const claim of [/\bdelet/i, /\berase/i, /\bexport/i, /\bdownload/i]) {
			expect(text).not.toMatch(claim);
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
