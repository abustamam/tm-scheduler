const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "GavelUp <noreply@gavelup.app>";

/** A single email attachment. `content` is the file bytes base64-encoded — the
 *  shape Resend's `attachments` field expects. */
export interface EmailAttachment {
	filename: string;
	/** base64-encoded file content. */
	content: string;
}

export interface SendEmailParams {
	/** A single recipient or a list (Resend accepts either). */
	to: string | string[];
	subject: string;
	html: string;
	text: string;
	/** Optional file attachments (e.g. a minutes PDF). Omit for plain mail. */
	attachments?: EmailAttachment[];
}

/**
 * Provider-agnostic email transport. Sends via Resend when RESEND_API_KEY is
 * set; otherwise logs to the console (dev). Throws on send failure — callers
 * (e.g. Better-Auth's sendMagicLink) rely on the throw surfacing a clean error.
 *
 * The transport seam is deliberately minimal; `from`-override can be added
 * non-breakingly when richer email lands. `attachments` (base64) pass straight
 * through to Resend's `attachments` field (#165 minutes PDF).
 */
export async function sendEmail({
	to,
	subject,
	html,
	text,
	attachments,
}: SendEmailParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM || DEFAULT_FROM;
	const toLabel = Array.isArray(to) ? to.join(", ") : to;

	// Dev fallback: no provider configured. Log the email — the text body carries
	// the magic-link URL, so local sign-in still works by copy-paste. This is the
	// ONLY path that logs the link; when a provider is configured the URL (a
	// bearer token) is never logged. Attachment count is noted (never the bytes).
	if (!apiKey) {
		const attachmentNote = attachments?.length
			? ` attachments=${attachments.length} (${attachments.map((a) => a.filename).join(", ")})`
			: "";
		console.log(
			`\n[email:dev] to=${toLabel} subject=${subject}${attachmentNote}\n${text}\n`,
		);
		return;
	}

	// Only include `attachments` in the body when present, so attachment-less
	// sends produce a byte-identical request to before this field existed.
	const body: Record<string, unknown> = { from, to, subject, html, text };
	if (attachments?.length) {
		body.attachments = attachments;
	}

	let res: Response;
	try {
		res = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (cause) {
		console.error(`[email] network error sending to ${toLabel}:`, cause);
		throw new Error("Failed to send email.");
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		console.error(
			`[email] Resend error sending to ${toLabel}: ${res.status} ${detail}`,
		);
		throw new Error("Failed to send email.");
	}
}
