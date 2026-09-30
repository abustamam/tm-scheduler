import { describe, expect, it } from "vitest";
import { parseMailto } from "#/test/mailto-parse";
import {
	buildMinutesMailto,
	isSingleMailbox,
	MINUTES_MAILTO_WARN_LENGTH,
	minutesBccList,
	partitionMinutesRecipients,
} from "./minutes-mailto";

const draft = (
	recipients: { email: string }[],
	over: Partial<{ subject: string; body: string; defaultSubject: string }> = {},
) =>
	buildMinutesMailto({
		recipients,
		subject: "S",
		body: "B",
		defaultSubject: "Default subject",
		...over,
	});

/** Every address the draft's bcc header resolves to, decoded as a client would. */
const bccOf = (href: string) => {
	const bcc = new Map(parseMailto(href).headers).get("bcc") ?? "";
	return decodeURIComponent(bcc).split(/[,;]/).filter(Boolean);
};

describe("buildMinutesMailto", () => {
	it("puts every recipient in bcc and none in to", () => {
		const href = draft([
			{ email: "ada@club.org" },
			{ email: "gwen@guest.example" },
		]);
		const { to, headers } = parseMailto(href);
		expect(to).toBe("");
		expect(headers.map(([k]) => k)).toEqual(["bcc", "subject", "body"]);
		expect(headers[0]?.[1]).toBe("ada@club.org,gwen@guest.example");
		expect(href).not.toMatch(/[?&]to=/);
		expect(href).not.toMatch(/[?&]cc=/);
	});

	it("encodes the subject and body, with CRLF line breaks", () => {
		const subject = "Acme TM — Minutes for Jul 10 & more?";
		const body = "Hi,\n\nAttached = minutes #3.\nThanks";
		const map = new Map(
			parseMailto(draft([{ email: "ada@club.org" }], { subject, body }))
				.headers,
		);
		expect(decodeURIComponent(map.get("subject") ?? "")).toBe(subject);
		expect(decodeURIComponent(map.get("body") ?? "")).toBe(
			"Hi,\r\n\r\nAttached = minutes #3.\r\nThanks",
		);
		// Nothing in either value may open a header of its own.
		expect(map.get("subject")).not.toMatch(/[&?#=]/);
		expect(map.get("body")).not.toMatch(/[&?#=]/);
	});

	it("falls back to the default subject when the officer empties it", () => {
		for (const subject of ["", "   "]) {
			const map = new Map(
				parseMailto(draft([{ email: "ada@club.org" }], { subject })).headers,
			);
			expect(decodeURIComponent(map.get("subject") ?? "")).toBe(
				"Default subject",
			);
		}
	});

	it("escapes a valid local part carrying ?bcc= and &body=, so it adds no header", () => {
		// `?`, `=` and `&` are legal atext, so this IS one mailbox and passes the
		// validator. Only the escaping stands between it and two extra headers.
		const tricky = "ada?bcc=attacker&body=pwned@club.org";
		expect(isSingleMailbox(tricky)).toBe(true);
		const { to, headers } = parseMailto(
			draft([{ email: tricky }, { email: "gwen@guest.example" }]),
		);
		expect(to).toBe("");
		expect(headers.map(([k]) => k)).toEqual(["bcc", "subject", "body"]);
		expect(new Map(headers).get("body")).toBe("B");
		expect(bccOf(draft([{ email: tricky }]))).toEqual([tricky]);
	});

	it.each([
		["comma", "a@x.org,b@evil.example"],
		["encoded-comma once decoded", "a@x.org, b@evil.example"],
		["semicolon", "a@x.org;b@evil.example"],
		["CRLF", "a@x.org\r\nBcc: b@evil.example"],
		["LF", "a@x.org\nb@evil.example"],
		["inner space", "a@x.org b@evil.example"],
		["query in the domain", "ada@club.org?bcc=b@evil.example&"],
		// One `@` only, separator on either side of it — so neither half of the
		// pattern can lean on the other to reject a second `@`.
		["comma in the local part", "evil.example, ada@club.org"],
		["semicolon in the local part", "x;y@club.org"],
		["space in the local part", "x y@club.org"],
		["comma in the domain", "ada@club.org,evil.example"],
		["semicolon in the domain", "ada@club.org;evil.example"],
		["CRLF in the domain", "ada@club.org\r\nBcc:evil.example"],
		["no domain dot", "ada@localhost"],
		["no at", "ada.club.org"],
	])("a stored address with a %s never reaches bcc", (_label, stored) => {
		const href = draft([{ email: stored }, { email: "gwen@guest.example" }]);
		expect(bccOf(href)).toEqual(["gwen@guest.example"]);
		expect(href).not.toContain("evil");
		expect(minutesBccList([{ email: stored }])).toBe("");
	});

	it("leaves @ readable, as mailtoHref does", () => {
		expect(draft([{ email: "ada@club.org" }])).toContain("bcc=ada@club.org&");
	});

	it("trims, drops blanks and de-duplicates addresses case-insensitively", () => {
		const { headers } = parseMailto(
			draft([
				{ email: " ada@club.org " },
				{ email: "ADA@club.org" },
				{ email: "   " },
				{ email: "gwen@guest.example" },
			]),
		);
		expect(headers[0]).toEqual(["bcc", "ada@club.org,gwen@guest.example"]);
	});

	it("writes no bcc header at all when there is nobody to send to", () => {
		const { headers } = parseMailto(draft([]));
		expect(headers.map(([k]) => k)).toEqual(["subject", "body"]);
	});

	it("a club-sized list crosses the long-link threshold", () => {
		const recipients = Array.from({ length: 60 }, (_, i) => ({
			email: `member.number.${i}@example-club.org`,
		}));
		expect(draft(recipients).length).toBeGreaterThan(
			MINUTES_MAILTO_WARN_LENGTH,
		);
		expect(MINUTES_MAILTO_WARN_LENGTH).toBe(1900);
	});
});

describe("partitionMinutesRecipients", () => {
	it("keeps the rejected entries, in order, for the dialog to show", () => {
		const { valid, invalid } = partitionMinutesRecipients([
			{ name: "Ada", email: "ada@club.org" },
			{ name: "Pair", email: "a@x.org,b@evil.example" },
			{ name: "Gwen", email: " gwen@guest.example " },
			{ name: "Semi", email: "a@x.org;b@evil.example" },
		]);
		expect(valid.map((r) => r.name)).toEqual(["Ada", "Gwen"]);
		expect(invalid.map((r) => r.name)).toEqual(["Pair", "Semi"]);
	});
});

describe("minutesBccList", () => {
	it("is the plain, comma-separated, de-duplicated list of valid addresses", () => {
		expect(
			minutesBccList([
				{ email: "ada@club.org" },
				{ email: " Ada@Club.org" },
				{ email: "a@x.org;b@evil.example" },
				{ email: "gwen@guest.example" },
			]),
		).toBe("ada@club.org, gwen@guest.example");
	});
});
