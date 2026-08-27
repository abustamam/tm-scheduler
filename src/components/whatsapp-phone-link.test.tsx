// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppPhoneLink } from "./whatsapp-phone-link";

/** jsdom's own UA is desktop-shaped, so tests that want the mobile branch have
 *  to say so. Restored by `vi.restoreAllMocks` in afterEach. */
function pretendUserAgent(ua: string) {
	vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

/** What a SIGHTED viewer reads. The number renders as a bare text node between
 *  the decorative icon and the `sr-only` label, so plain `textContent` would
 *  sweep the screen-reader copy in with it and no exact assertion would be
 *  possible — but exact is the point, since trailing space is what `.trim()`
 *  removes. */
function visibleText(el: Element): string {
	return Array.from(el.childNodes)
		.filter((n) => n.nodeType === Node.TEXT_NODE)
		.map((n) => n.textContent)
		.join("");
}

describe("WhatsAppPhoneLink", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("links a desktop viewer to WhatsApp Web, not the wa.me interstitial", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe(
			"https://web.whatsapp.com/send/?phone=14155552671&type=phone_number&app_absent=0",
		);
		expect(link.getAttribute("href")).not.toContain("wa.me");
	});

	it("links a mobile viewer to wa.me so the app takes over", () => {
		pretendUserAgent(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
		);
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		expect(screen.getByRole("link").getAttribute("href")).toBe(
			"https://wa.me/14155552671",
		);
	});

	it("serves wa.me before hydration, so a pre-JS tap still reaches WhatsApp", () => {
		// The pre-mount pass is what the SERVER renders, and `renderToString` is the
		// only way to observe it: `render()` flushes the mount effect before any
		// assertion can run, so every other test here sees the post-mount value and
		// the pre-mount default could be flipped with all of them green. It is not
		// arbitrary — a desktop viewer who taps before hydration lands on exactly
		// the `wa.me` interstitial #485 exists to close, so this pins the narrower
		// harm (mobile default) as the one we accept for that window.
		const html = renderToString(
			<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />,
		);
		expect(html).toContain("https://wa.me/14155552671");
		expect(html).not.toContain("web.whatsapp.com");
	});

	it("opens a BLANK chat — no prefilled text on these surfaces", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		expect(screen.getByRole("link").getAttribute("href")).not.toContain(
			"text=",
		);
	});

	it("shows the number as the link text and names the destination", () => {
		// Padded input, exact visible output: this is the only fixture that pins
		// `.trim()` on the path that actually RENDERS a number. The all-whitespace
		// fallback case cannot — there the result is empty with or without the trim.
		render(<WhatsAppPhoneLink phone="  +14155552671  " name="Jane Doe" />);
		const link = screen.getByRole("link");
		expect(visibleText(link)).toBe("+14155552671");
		expect(link.getAttribute("title")).toBe("Message Jane Doe on WhatsApp");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("announces the destination, not just a string of digits", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		// `title` cannot carry this. Per the accname spec content wins for the NAME
		// and `title` is the last-resort source, so it degrades to the DESCRIPTION —
		// which screen readers announce inconsistently or not at all. Querying by
		// accessible name is what distinguishes the two; a `title`-only version
		// leaves the name as the bare number and returns null here.
		expect(screen.getByRole("link", { name: /whatsapp/i })).toBeTruthy();
		expect(screen.getByRole("link", { name: /jane doe/i })).toBeTruthy();
		// Outbound to a new tab, which `target="_blank"` alone never announces.
		expect(screen.getByRole("link", { name: /new tab/i })).toBeTruthy();
	});

	it("renders the icon decoratively, ahead of the number", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		const link = screen.getByRole("link");
		const svg = link.querySelector("svg");
		// The number is already the accessible name, so an exposed icon is noise.
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		expect(svg?.getAttribute("class")).toContain("lucide-message-circle");
		// Icon leads; a trailing icon reads as a separate affordance. Deliberately
		// `firstChild`, not `firstElementChild`: the number is a bare TEXT node, so
		// `firstElementChild` skips straight past it and still finds the svg even
		// when the icon has been moved after the number — the mutation this line
		// exists to catch.
		expect(link.firstChild).toBe(svg);
	});

	it("renders a digit-less value as visible text, not a dead link", () => {
		render(<WhatsAppPhoneLink phone="ask at church" name="Jane Doe" />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("ask at church").tagName).toBe("SPAN");
	});

	// The COLOUR contract, which no call site can hold. `styles.css` has an
	// unlayered `a:not(…) { color: var(--lagoon-deep) }` rule; unlayered beats
	// Tailwind's `@layer utilities`, so a `text-primary` passed as a `className`
	// by a caller loses to it silently and the link renders --lagoon-deep
	// (~3.8:1 on white) at `text-xs` — under WCAG AA on both surfaces that show
	// it most. The fix is the `data-slot` exclusion, which has to sit on the
	// anchor, which means the colour has to sit here with it.
	it("colours the link itself and opts out of the unlayered anchor rule", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		const link = screen.getByRole("link");
		// --primary is --lagoon-ink, annotated AA-verified at 5.8:1 in styles.css.
		expect(
			link.className,
			"WhatsAppPhoneLink must colour its own anchor — call sites no longer " +
				"pass one. (Before #646 a caller-supplied colour could not have won " +
				"anyway: the `a { color }` rule in styles.css was unlayered.)",
		).toContain("text-primary");
		// Kept as a TEST SELECTOR since #646: the `text-primary` above is no
		// longer inert without it (layering means the utility wins on its own),
		// but this attribute is the stable handle the roster and profile suites
		// use to find the link. `text-link-layering.guard.test.ts` holds the
		// cascade half.
		expect(
			link.getAttribute("data-slot"),
			"the `text-primary` above is inert without this attribute",
		).toBe("wa-phone");
	});

	// Tasks 6-9 all place this inside a table cell or a flex row, so a dropped
	// base class would ship looking like a CSS problem rather than a component
	// regression. Both rendering branches that accept a `className` get pinned;
	// the fallback branch deliberately does not take one (callers wrap a styled
	// node themselves), so there is nothing to pin.
	it("merges a caller's className onto the link without losing its own base", () => {
		render(
			<WhatsAppPhoneLink
				phone="+14155552671"
				name="Jane Doe"
				className="text-sm tabular-nums"
			/>,
		);
		const link = screen.getByRole("link");
		expect(link.className).toContain("text-sm");
		expect(link.className).toContain("tabular-nums");
		// Asserted alongside the caller's classes so this pins the `cn` MERGE — a
		// bare `className={className}` that dropped the base would pass on the two
		// assertions above alone.
		expect(link.className).toContain("inline-flex");
		// The base owns the affordance so no call site has to remember it: the rest
		// of the base is pure layout, which would leave the anchor looking exactly
		// like the plain text next to it.
		expect(link.className).toContain("hover:underline");
		// …and the colour survives a caller class that does not touch colour.
		expect(link.className).toContain("text-primary");
	});

	it("lets a conflicting caller class win over the base", () => {
		// The test above uses classes that collide with nothing in the base, so it
		// only proves the base SURVIVES — reversing the `cn` arguments keeps it
		// green. `gap-4` is deliberately NOT a colour: colour is the component's
		// own decision now, so overriding it from a call site is the thing this
		// change removed, and pinning that as supported would invite it back.
		render(
			<WhatsAppPhoneLink
				phone="+14155552671"
				name="Jane Doe"
				className="gap-4"
			/>,
		);
		const link = screen.getByRole("link");
		expect(link.className).toContain("gap-4");
		expect(link.className).not.toContain("gap-1.5");
	});

	it("does not paint the digit-less branch with link styling", () => {
		// This branch renders no link, so painting it in link colour shows a plain
		// string that looks clickable and is not: an affordance that lies. It must
		// escape BOTH the base's own `text-primary` and any caller class.
		// Reachable, not theoretical — `toStoredPhone` preserves an un-normalizable
		// value on purpose, and the read paths carry it through verbatim.
		render(
			<WhatsAppPhoneLink
				phone="ask at church"
				name="Jane Doe"
				className="text-sm"
			/>,
		);
		const span = screen.getByText("ask at church");
		// The whole class list, not just one utility. Asserting only
		// `not.toContain("text-primary")` would pass on a version that forwarded
		// every OTHER class, which is the same bug with a different input.
		expect(span.className).toBe("");
		// It is also not the anchor, so it must not carry the anchor's escape
		// hatch — a `data-slot` here would exempt plain prose from the site's link
		// styling for no reason.
		expect(span.getAttribute("data-slot")).toBeNull();
	});

	it.each([
		null,
		undefined,
		"",
		"   ",
	])("renders the fallback for %p", (phone) => {
		render(<WhatsAppPhoneLink phone={phone} name="Jane Doe" fallback="—" />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("—")).toBeTruthy();
	});
});
