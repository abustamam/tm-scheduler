import { describe, expect, it } from "vitest";
import {
	buildMinutesMailto,
	MINUTES_MAILTO_WARN_LENGTH,
	minutesBccList,
} from "./minutes-mailto";

/**
 * Split a `mailto:` into its address part and its header NAMES + raw values.
 * Deliberately not `URLSearchParams`: that decodes `+` as a space and would hide
 * an injected header behind its own normalisation. This reads the URL the way a
 * mail client does, splitting on the literal `?` and `&`.
 */
function parse(href: string) {
	expect(href.startsWith("mailto:")).toBe(true);
	const rest = href.slice("mailto:".length);
	const q = rest.indexOf("?");
	const to = q === -1 ? rest : rest.slice(0, q);
	const query = q === -1 ? "" : rest.slice(q + 1);
	const headers = query
		.split("&")
		.filter(Boolean)
		.map((pair) => {
			const eq = pair.indexOf("=");
			return [pair.slice(0, eq), pair.slice(eq + 1)] as const;
		});
	return { to, headers };
}

describe("buildMinutesMailto", () => {
	it("puts every recipient in bcc and none in to", () => {
		const href = buildMinutesMailto({
			recipients: [{ email: "ada@club.org" }, { email: "gwen@guest.example" }],
			subject: "S",
			body: "B",
		});
		const { to, headers } = parse(href);
		expect(to).toBe("");
		expect(headers.map(([k]) => k)).toEqual(["bcc", "subject", "body"]);
		expect(headers[0]?.[1]).toBe("ada@club.org,gwen@guest.example");
		expect(href).not.toMatch(/[?&]to=/);
		expect(href).not.toMatch(/[?&]cc=/);
	});

	it("encodes the subject and body, with CRLF line breaks", () => {
		const subject = "Acme TM — Minutes for Jul 10 & more?";
		const body = "Hi,\n\nAttached = minutes #3.\nThanks";
		const { headers } = parse(
			buildMinutesMailto({
				recipients: [{ email: "ada@club.org" }],
				subject,
				body,
			}),
		);
		const map = new Map(headers);
		expect(decodeURIComponent(map.get("subject") ?? "")).toBe(subject);
		expect(decodeURIComponent(map.get("body") ?? "")).toBe(
			"Hi,\r\n\r\nAttached = minutes #3.\r\nThanks",
		);
		// Nothing in either value may open a header of its own.
		expect(map.get("subject")).not.toMatch(/[&?#=]/);
		expect(map.get("body")).not.toMatch(/[&?#=]/);
	});

	it("a stored address carrying ?bcc= and &body= adds no header", () => {
		const hostile = "ada@club.org?bcc=attacker@evil.example&body=I resign&";
		const { to, headers } = parse(
			buildMinutesMailto({
				recipients: [{ email: hostile }, { email: "gwen@guest.example" }],
				subject: "S",
				body: "B",
			}),
		);
		expect(to).toBe("");
		// Exactly the three headers the builder writes: one bcc, one body.
		expect(headers.map(([k]) => k)).toEqual(["bcc", "subject", "body"]);
		// The whole hostile string is ONE (odd-looking) bcc address, not a header.
		const bcc = headers[0]?.[1] ?? "";
		expect(bcc.split(",").map(decodeURIComponent)).toEqual([
			hostile,
			"gwen@guest.example",
		]);
		expect(new Map(headers).get("body")).toBe("B");
	});

	it("leaves @ readable, as mailtoHref does", () => {
		expect(
			buildMinutesMailto({
				recipients: [{ email: "ada@club.org" }],
				subject: "",
				body: "",
			}),
		).toContain("bcc=ada@club.org&");
	});

	it("trims, drops blanks and de-duplicates addresses case-insensitively", () => {
		const { headers } = parse(
			buildMinutesMailto({
				recipients: [
					{ email: " ada@club.org " },
					{ email: "ADA@club.org" },
					{ email: "   " },
					{ email: "gwen@guest.example" },
				],
				subject: "S",
				body: "B",
			}),
		);
		expect(headers[0]).toEqual(["bcc", "ada@club.org,gwen@guest.example"]);
	});

	it("writes no bcc header at all when there is nobody to send to", () => {
		const { headers } = parse(
			buildMinutesMailto({ recipients: [], subject: "S", body: "B" }),
		);
		expect(headers.map(([k]) => k)).toEqual(["subject", "body"]);
	});

	it("a club-sized list crosses the long-link threshold", () => {
		const recipients = Array.from({ length: 60 }, (_, i) => ({
			email: `member.number.${i}@example-club.org`,
		}));
		expect(
			buildMinutesMailto({ recipients, subject: "S", body: "B" }).length,
		).toBeGreaterThan(MINUTES_MAILTO_WARN_LENGTH);
		expect(MINUTES_MAILTO_WARN_LENGTH).toBe(1900);
	});
});

describe("minutesBccList", () => {
	it("is the plain, comma-separated, de-duplicated address list", () => {
		expect(
			minutesBccList([
				{ email: "ada@club.org" },
				{ email: " Ada@Club.org" },
				{ email: "gwen@guest.example" },
			]),
		).toBe("ada@club.org, gwen@guest.example");
	});
});
