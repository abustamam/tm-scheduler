// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./keyboard";

function el(html: string): Element {
	const host = document.createElement("div");
	host.innerHTML = html;
	return host.firstElementChild as Element;
}

describe("isTypingTarget", () => {
	// protects=a bare-key shortcut yields to every text-entry element; fails_when=any of input/textarea/select/contenteditable (or a child of one) reads false; no_claim=that the shortcut itself is wired
	it.each([
		["input", "<input />"],
		["search input", '<input type="search" />'],
		["textarea", "<textarea></textarea>"],
		["select", "<select><option>a</option></select>"],
		["contenteditable", '<div contenteditable="true"></div>'],
		["bare contenteditable", "<div contenteditable></div>"],
		["child of contenteditable", '<div contenteditable="true"><b>x</b></div>'],
	])("is true for %s", (_name, html) => {
		const root = el(html);
		const target = root.querySelector("b") ?? root;
		expect(isTypingTarget(target)).toBe(true);
	});

	// protects=non-typing targets keep the shortcut; fails_when=buttons, the body, null or a contenteditable=false region count as typing; no_claim=disabled inputs
	it.each([
		["button", "<button>x</button>"],
		["link", '<a href="#">x</a>'],
		["contenteditable=false", '<div contenteditable="false"></div>'],
	])("is false for %s", (_name, html) => {
		expect(isTypingTarget(el(html))).toBe(false);
	});

	it("is false for the body and for null", () => {
		expect(isTypingTarget(document.body)).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
	});
});
