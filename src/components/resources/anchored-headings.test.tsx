import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { slugifyHeading, splitHeadingId } from "#/lib/heading-anchor";
import { anchoredHeadingComponents } from "./anchored-headings";

function render(markdown: string): string {
	return renderToStaticMarkup(
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={anchoredHeadingComponents}
		>
			{markdown}
		</ReactMarkdown>,
	);
}

describe("splitHeadingId", () => {
	it("takes a trailing {#id} off the text", () => {
		expect(splitHeadingId("Setting up Base Camp {#base-camp}")).toEqual({
			text: "Setting up Base Camp",
			id: "base-camp",
		});
	});

	it("leaves a heading without a marker alone", () => {
		expect(splitHeadingId("How it works")).toEqual({
			text: "How it works",
			id: null,
		});
	});

	it("ignores a marker that is not at the end", () => {
		expect(splitHeadingId("{#early} then text").id).toBeNull();
	});
});

describe("slugifyHeading", () => {
	it("lowercases, strips punctuation and accents, and hyphenates", () => {
		expect(slugifyHeading("  Why members like it!  ")).toBe(
			"why-members-like-it",
		);
		expect(slugifyHeading("Café — résumé")).toBe("cafe-resume");
	});
});

describe("anchoredHeadingComponents", () => {
	it("uses a pinned id and strips the marker from the rendered text", () => {
		const html = render("## Setting up Base Camp {#base-camp}");
		expect(html).toBe(
			'<h2 id="base-camp" class="scroll-mt-24">Setting up Base Camp</h2>',
		);
	});

	it("pins an id on a heading with inline formatting before the marker", () => {
		const html = render("### The **first** week {#first}");
		expect(html).toBe(
			'<h3 id="first" class="scroll-mt-24">The <strong>first</strong> week</h3>',
		);
	});

	it("derives an id from the text when none is pinned", () => {
		expect(render("## The **first** week")).toBe(
			'<h2 id="the-first-week" class="scroll-mt-24">The <strong>first</strong> week</h2>',
		);
	});
});

// The orientation checklist (#934) links to these sections, so their ids are a
// contract with other pages rather than a rendering detail.
describe("what-is-pathways article (#941)", () => {
	const html = render(
		readFileSync(
			resolve(__dirname, "../../../content/resources/what-is-pathways.md"),
			"utf8",
		),
	);

	it.each([
		"first-weeks",
		"choosing-a-path",
		"base-camp",
		"tracking-progress",
	])("has a #%s section", (id) => {
		expect(html).toContain(`id="${id}"`);
	});

	it("renders no raw {#id} marker", () => {
		expect(html).not.toContain("{#");
	});

	it("every in-page link lands on a heading that exists", () => {
		const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
		expect(targets.length).toBeGreaterThan(0);
		for (const id of targets) expect(html).toContain(`id="${id}"`);
	});
});

// A route cannot be mounted here without its server context, so pin the wiring
// by source: without the prop the article renders `{#base-camp}` as visible
// text and every section link lands at the top of the page.
describe("the resource article route", () => {
	it("renders markdown through the anchored heading components", () => {
		const src = readFileSync(
			resolve(__dirname, "../../routes/resources.$slug.tsx"),
			"utf8",
		);
		expect(src).toMatch(/components=\{anchoredHeadingComponents\}/);
	});
});
