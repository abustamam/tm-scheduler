import { afterEach, describe, expect, it, vi } from "vitest";
import { isReservedRecipient, sendEmail } from "./email";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("sendEmail", () => {
	it("uses the dev fallback (no fetch) when RESEND_API_KEY is unset", async () => {
		vi.stubEnv("RESEND_API_KEY", "");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({
			to: "member@example.com",
			subject: "Hi",
			html: "<p>hello</p>",
			text: "open this: https://gavelup.app/x",
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		const logged = logSpy.mock.calls.flat().join(" ");
		expect(logged).toContain("member@example.com");
		expect(logged).toContain("https://gavelup.app/x");
	});

	it("POSTs to Resend with bearer auth and the right body when keyed", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.stubEnv("EMAIL_FROM", "GavelUp <noreply@gavelup.app>");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ id: "1" }), { status: 200 }),
			);

		await sendEmail({
			to: "member@club.org",
			subject: "Subj",
			html: "<p>H</p>",
			text: "T",
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer re_test");
		const body = JSON.parse(init?.body as string);
		expect(body).toMatchObject({
			from: "GavelUp <noreply@gavelup.app>",
			to: "member@club.org",
			subject: "Subj",
			html: "<p>H</p>",
			text: "T",
		});
	});

	it("falls back to the default from address when EMAIL_FROM is unset", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.stubEnv("EMAIL_FROM", "");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: "a@b.com",
			subject: "S",
			html: "<p></p>",
			text: "t",
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.from).toBe("GavelUp <noreply@gavelup.app>");
	});

	it("sends reply_to only when replyTo is given (#866)", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: "a@b.com",
			subject: "S",
			html: "<p></p>",
			text: "t",
			replyTo: "requester@club.org",
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.reply_to).toBe("requester@club.org");
	});

	it("sends an Idempotency-Key header only when one is given (#866)", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: "a@b.com",
			subject: "S",
			html: "<p></p>",
			text: "t",
			idempotencyKey: "access-request/abc",
		});
		await sendEmail({
			to: "a@b.com",
			subject: "S",
			html: "<p></p>",
			text: "t",
		});

		const withKey = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
			string,
			string
		>;
		const without = fetchSpy.mock.calls[1]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(withKey["Idempotency-Key"]).toBe("access-request/abc");
		expect(Object.keys(without).sort()).toEqual([
			"Authorization",
			"Content-Type",
		]);
		// Never in the body: it is a header.
		const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(body).not.toHaveProperty("idempotencyKey");
	});

	it("does NOT include a reply_to field when replyTo is omitted", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: "a@b.com",
			subject: "S",
			html: "<p></p>",
			text: "t",
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(Object.keys(body).sort()).toEqual(
			["from", "html", "subject", "text", "to"].sort(),
		);
	});

	it("supports a recipient array", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: ["a@b.com", "c@d.com"],
			subject: "S",
			html: "<p>H</p>",
			text: "T",
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.to).toEqual(["a@b.com", "c@d.com"]);
	});

	it("logs every recipient in the dev fallback (no key)", async () => {
		vi.stubEnv("RESEND_API_KEY", "");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({
			to: ["a@b.com", "c@d.com"],
			subject: "S",
			html: "<p></p>",
			text: "body",
		});

		const logged = logSpy.mock.calls.flat().join(" ");
		expect(logged).toContain("a@b.com");
		expect(logged).toContain("c@d.com");
	});

	it("throws (does not swallow) when Resend returns a non-OK response", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("bad", { status: 422 }),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			sendEmail({ to: "a@b.com", subject: "S", html: "<p></p>", text: "t" }),
		).rejects.toThrow("Failed to send email.");
	});

	it("throws when fetch itself rejects (network error)", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			sendEmail({ to: "a@b.com", subject: "S", html: "<p></p>", text: "t" }),
		).rejects.toThrow("Failed to send email.");
	});
});

describe("isReservedRecipient", () => {
	// protects=an address that cannot exist (RFC 2606 / 6761) is classed reserved:
	//   the three example domains and their subdomains, the reserved TLDs, any case,
	//   and a "Name <addr>" form;
	// fails_when=a reserved domain, a subdomain of one, or a reserved TLD is
	//   reported deliverable;
	// no_claim=nothing about the transport; this is the predicate alone.
	it.each([
		"a@example.com",
		"a@example.net",
		"a@example.org",
		"A@EXAMPLE.COM",
		"a@mail.example.com",
		"a@deep.sub.example.org",
		"a@club.example",
		"a@club.test",
		"a@club.invalid",
		"a@club.localhost",
		"a@localhost",
		"Demo <a@example.com>",
	])("treats %s as reserved", (address) => {
		expect(isReservedRecipient(address)).toBe(true);
	});

	// protects=a real address is never classed reserved, including look-alikes of a
	//   reserved domain, so real mail is not dropped;
	// fails_when=a look-alike (example.com.evil.io, myexample.com, example.co,
	//   testing.io) or a malformed value is reported reserved;
	// no_claim=a malformed value is "not reserved", not "valid".
	it.each([
		"a@gavelup.app",
		"a@club.org",
		"a@myexample.com",
		"a@example.com.evil.io",
		"a@example.co",
		"a@testing.io",
		"not-an-address",
		"a@",
	])("treats %s as deliverable", (address) => {
		expect(isReservedRecipient(address)).toBe(false);
	});
});

describe("sendEmail: reserved recipients", () => {
	const message = { subject: "S", html: "<p></p>", text: "t" };

	// protects=no mail leaves for a reserved address (the demo club, #1199), and
	//   the drop's log line carries no address;
	// fails_when=a reserved recipient reaches the provider, or the log names it;
	// no_claim=fetch is mocked, so what Resend does with a request is not
	//   exercised; the demo club's own call sites are not walked here.
	it("makes no transport call for a reserved address and logs no address", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({ to: "priya@example.com", ...message });

		expect(fetchSpy).not.toHaveBeenCalled();
		const logged = logSpy.mock.calls.flat().join(" ");
		expect(logged).toContain("[email] dropped: reserved recipient domain");
		expect(logged).not.toContain("priya");
	});

	// protects=a real address is still sent to, once;
	// fails_when=the reserved-address drop swallows ordinary mail, or sends twice;
	// no_claim=fetch is mocked.
	it("makes exactly one transport call for a real address", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({ to: "real@club.org", ...message });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	// protects=a list holding reserved and real addresses is sent once, to the real
	//   ones only;
	// fails_when=a reserved address rides along, or the real one is dropped with
	//   it, or two calls are made;
	// no_claim=fetch is mocked.
	it("sends a mixed list once, to the real address only", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: ["priya@example.com", "real@club.org", "x@club.test"],
			...message,
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.to).toEqual(["real@club.org"]);
	});

	// protects=with no API key the dev log still prints the whole message, reserved
	//   address included, so a developer sees the magic link;
	// fails_when=the drop is applied before the dev branch and the link is lost;
	// no_claim=fetch is mocked.
	it("still prints a reserved address in the dev log when no key is set", async () => {
		vi.stubEnv("RESEND_API_KEY", "");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({ to: "priya@example.com", ...message });

		expect(fetchSpy).not.toHaveBeenCalled();
		const logged = logSpy.mock.calls.flat().join(" ");
		expect(logged).toContain("priya@example.com");
		expect(logged).not.toContain("dropped");
	});

	// protects=a comma-separated string of recipients is judged address by address,
	//   so a real one is not dropped because the LAST address is reserved, and a
	//   reserved one is not sent because the last is real;
	// fails_when=the string is tested whole (its domain is only the last
	//   address's), so the real recipient is dropped or the reserved one rides along;
	// no_claim=fetch is mocked; a display name that contains a comma is not
	//   supported by any caller.
	it("judges each address of a comma-joined string", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({ to: "real@club.org, fake@example.com", ...message });
		await sendEmail({ to: "fake@example.com, real@club.org", ...message });

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		for (const call of fetchSpy.mock.calls) {
			expect(JSON.parse(call[1]?.body as string).to).toEqual(["real@club.org"]);
		}
	});

	// protects=a comma-joined string whose every address is reserved sends nothing;
	// fails_when=the last address alone is tested and a reserved first one is sent;
	// no_claim=fetch is mocked.
	it("drops a comma-joined string of only reserved addresses", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({ to: "a@club.test, b@example.com", ...message });

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// protects=a comma-joined string of only real addresses goes through byte for
	//   byte, not reshaped into an array;
	// fails_when=untouched input is rewritten;
	// no_claim=fetch is mocked.
	it("passes a comma-joined string of real addresses through unchanged", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({ to: "a@club.org, b@club.org", ...message });

		expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).to).toBe(
			"a@club.org, b@club.org",
		);
	});
});
