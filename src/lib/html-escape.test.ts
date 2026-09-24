import { describe, expect, it } from "vitest";
import { escapeHtml, toSubjectText } from "./html-escape";

describe("escapeHtml", () => {
	it("escapes the five characters that break out of text or an attribute", () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});
});

describe("toSubjectText (#866)", () => {
	it("turns CR, LF, tabs and other controls into single spaces", () => {
		expect(toSubjectText("Club\r\nBcc: x@evil.test")).toBe(
			"Club Bcc: x@evil.test",
		);
		expect(toSubjectText("a\tb\u0000c\u007fd\u0085e f")).toBe("a b c d e f");
	});

	it("leaves ordinary text, including non-ASCII, alone", () => {
		expect(toSubjectText("  Oradores de São Paulo  ")).toBe(
			"Oradores de São Paulo",
		);
	});
});
