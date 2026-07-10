import { describe, expect, it, vi } from "vitest";
import type { SendEmailParams } from "#/lib/email";
import {
	buildMinutesFilename,
	buildMinutesSubject,
	type MinutesEmailPort,
	resolveMinutesRecipients,
	sendMinutesEmail,
} from "./minutes-email-logic";

describe("resolveMinutesRecipients", () => {
	it("keeps only entries with a non-empty email, skips the rest", () => {
		const { recipients, skipped } = resolveMinutesRecipients({
			members: [
				{ name: "Ada", email: "ada@example.com" },
				{ name: "Grace", email: null },
				{ name: "Alan", email: "   " },
			],
			presentGuests: [{ name: "Guest Gwen", email: "gwen@example.com" }],
		});

		expect(recipients).toEqual([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Guest Gwen", email: "gwen@example.com" },
		]);
		expect(skipped).toEqual([{ name: "Grace" }, { name: "Alan" }]);
	});

	it("trims surrounding whitespace on kept emails", () => {
		const { recipients } = resolveMinutesRecipients({
			members: [{ name: "Ada", email: "  ada@example.com  " }],
			presentGuests: [],
		});
		expect(recipients).toEqual([{ name: "Ada", email: "ada@example.com" }]);
	});
});

describe("buildMinutesSubject / buildMinutesFilename", () => {
	it("formats the subject with club name and date", () => {
		const subject = buildMinutesSubject(
			"Acme TM",
			new Date("2026-07-10T18:00:00Z"),
		);
		expect(subject).toContain("Acme TM — Minutes for");
	});

	it("names the file minutes-<iso date>.pdf", () => {
		expect(buildMinutesFilename(new Date("2026-07-10T18:00:00Z"))).toBe(
			"minutes-2026-07-10.pdf",
		);
	});
});

// ---------------------------------------------------------------------------
// sendMinutesEmail — mock the port + sendEmail (no db, no network).
// ---------------------------------------------------------------------------

function makePort(overrides?: Partial<MinutesEmailPort>): MinutesEmailPort {
	return {
		renderMinutesPdf: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
		loadRecipients: vi.fn().mockResolvedValue({
			members: [
				{ name: "Ada", email: "ada@example.com" },
				{ name: "Grace", email: null },
			],
			presentGuests: [{ name: "Guest Gwen", email: "gwen@example.com" }],
		}),
		loadHeader: vi.fn().mockResolvedValue({
			clubName: "Acme TM",
			meetingDate: new Date("2026-07-10T18:00:00Z"),
		}),
		...overrides,
	};
}

describe("sendMinutesEmail", () => {
	it("sends one email to recipients with email; skips those without; attaches base64 PDF", async () => {
		const port = makePort();
		const sendEmail = vi
			.fn<(params: SendEmailParams) => Promise<void>>()
			.mockResolvedValue();

		const result = await sendMinutesEmail(
			port,
			{ sendEmail },
			{
				meetingId: "m1",
			},
		);

		expect(result.sent.map((r) => r.email)).toEqual([
			"ada@example.com",
			"gwen@example.com",
		]);
		expect(result.skipped).toEqual([{ name: "Grace" }]);

		expect(sendEmail).toHaveBeenCalledTimes(1);
		const params = sendEmail.mock.calls[0][0];
		expect(params.to).toEqual(["ada@example.com", "gwen@example.com"]);
		// Correct subject.
		expect(params.subject).toContain("Acme TM — Minutes for");
		// Exactly one attachment, base64-encoded, named for the meeting date.
		expect(params.attachments).toHaveLength(1);
		const attachment = params.attachments?.[0];
		expect(attachment?.filename).toBe("minutes-2026-07-10.pdf");
		expect(attachment?.content).toBe(
			Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
		);
		// Round-trips back to the PDF bytes.
		expect([...Buffer.from(attachment?.content ?? "", "base64")]).toEqual([
			1, 2, 3, 4,
		]);
	});

	it("honours an admin-curated recipient override (and still skips no-email entries)", async () => {
		const port = makePort();
		const sendEmail = vi
			.fn<(params: SendEmailParams) => Promise<void>>()
			.mockResolvedValue();

		const result = await sendMinutesEmail(
			port,
			{ sendEmail },
			{
				meetingId: "m1",
				recipients: [
					{ name: "Extra", email: "extra@example.com" },
					{ name: "NoEmail", email: null },
				],
				subject: "Custom subject",
				body: "Custom body",
			},
		);

		expect(port.loadRecipients).not.toHaveBeenCalled();
		expect(result.sent.map((r) => r.email)).toEqual(["extra@example.com"]);
		expect(result.skipped).toEqual([{ name: "NoEmail" }]);
		const params = sendEmail.mock.calls[0][0];
		expect(params.subject).toBe("Custom subject");
		expect(params.text).toBe("Custom body");
		expect(params.to).toEqual(["extra@example.com"]);
	});

	it("does not send when nobody has an email, but reports skips", async () => {
		const port = makePort({
			loadRecipients: vi.fn().mockResolvedValue({
				members: [{ name: "Grace", email: null }],
				presentGuests: [],
			}),
		});
		const sendEmail = vi
			.fn<(params: SendEmailParams) => Promise<void>>()
			.mockResolvedValue();

		const result = await sendMinutesEmail(
			port,
			{ sendEmail },
			{
				meetingId: "m1",
			},
		);

		expect(sendEmail).not.toHaveBeenCalled();
		expect(port.renderMinutesPdf).not.toHaveBeenCalled();
		expect(result).toEqual({ sent: [], skipped: [{ name: "Grace" }] });
	});

	it("does not throw on the dev (no-RESEND_API_KEY) transport path", async () => {
		const port = makePort();
		// Exercise the REAL transport in its dev branch (logs, never throws).
		vi.stubEnv("RESEND_API_KEY", "");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { sendEmail } = await import("#/lib/email");

		await expect(
			sendMinutesEmail(port, { sendEmail }, { meetingId: "m1" }),
		).resolves.toMatchObject({ skipped: [{ name: "Grace" }] });

		expect(logSpy).toHaveBeenCalled();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});
});
