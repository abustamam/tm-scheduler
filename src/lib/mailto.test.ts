import { describe, expect, it } from "vitest";
import { mailtoHref } from "./mailto";

describe("mailtoHref", () => {
	it("leaves an ordinary address in its canonical form", () => {
		// The whole reason this is not bare `encodeURIComponent`: that would ship
		// `mailto:ada%40example.com` on every link in the app.
		expect(mailtoHref("ada@example.com")).toBe("mailto:ada@example.com");
		// `+` IS escaped, and should be: in a URL it decodes to a space in some
		// parsers, so a plus-addressed recipient is the one common address that
		// legitimately needs escaping to survive the round trip intact.
		expect(mailtoHref("first.last+tag@sub.example.co.uk")).toBe(
			"mailto:first.last%2Btag@sub.example.co.uk",
		);
	});

	it.each([
		["?", "a@b.com?bcc=attacker@evil.com"],
		["&", "a@b.com&cc=attacker@evil.com"],
		["#", "a@b.com#frag"],
		[", (multiple recipients)", "a@b.com,attacker@evil.com"],
	])("escapes %s so it cannot start or extend the header section", (_, raw) => {
		const href = mailtoHref(raw);
		// The recipient half is everything up to the first unescaped delimiter. If
		// any survived, a mail client would read live headers.
		expect(href.slice("mailto:".length)).not.toMatch(/[?&#,]/);
	});

	it("neutralises a bcc injection specifically", () => {
		// The concrete harm: the sender's own client silently blind-copies a third
		// party. Asserted as an exact string so a partial escape is visible.
		expect(mailtoHref("a@b.com?bcc=x@y.z&subject=hi")).toBe(
			"mailto:a@b.com%3Fbcc%3Dx@y.z%26subject%3Dhi",
		);
	});

	it("escapes whitespace, which a padded legacy row carries", () => {
		expect(mailtoHref(" a@b.com ")).toBe("mailto:%20a@b.com%20");
	});

	it("parses back to a single recipient with no headers", () => {
		// Behavioural rather than textual: whatever the escaping, a URL parser must
		// see one recipient and an empty query. This is the property that matters,
		// and it fails for every partial escape the assertions above might miss.
		const url = new URL(mailtoHref("a@b.com?bcc=x@y.z&subject=hi"));
		expect(url.protocol).toBe("mailto:");
		expect(url.search).toBe("");
		expect(decodeURIComponent(url.pathname)).toBe(
			"a@b.com?bcc=x@y.z&subject=hi",
		);
	});
});
