import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "./email";

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
			to: "member@example.com",
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
			to: "member@example.com",
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

	it("does NOT include an attachments field for attachment-less sends", async () => {
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
		expect(body).not.toHaveProperty("attachments");
	});

	it("passes attachments through to Resend and supports a recipient array", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({
			to: ["a@b.com", "c@d.com"],
			subject: "Minutes",
			html: "<p>H</p>",
			text: "T",
			attachments: [
				{ filename: "minutes-2026-07-10.pdf", content: "YmFzZTY0" },
			],
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.to).toEqual(["a@b.com", "c@d.com"]);
		expect(body.attachments).toEqual([
			{ filename: "minutes-2026-07-10.pdf", content: "YmFzZTY0" },
		]);
	});

	it("logs the attachment count in the dev fallback (no key)", async () => {
		vi.stubEnv("RESEND_API_KEY", "");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({
			to: ["a@b.com", "c@d.com"],
			subject: "Minutes",
			html: "<p></p>",
			text: "body",
			attachments: [
				{ filename: "minutes-2026-07-10.pdf", content: "YmFzZTY0" },
			],
		});

		const logged = logSpy.mock.calls.flat().join(" ");
		expect(logged).toContain("a@b.com");
		expect(logged).toContain("c@d.com");
		expect(logged).toContain("attachments=1");
		expect(logged).toContain("minutes-2026-07-10.pdf");
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
