const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "GavelUp <noreply@gavelup.app>";

export interface SendEmailParams {
	to: string;
	subject: string;
	html: string;
	text: string;
}

/**
 * Provider-agnostic email transport. Sends via Resend when RESEND_API_KEY is
 * set; otherwise logs to the console (dev). Throws on send failure — callers
 * (e.g. Better-Auth's sendMagicLink) rely on the throw surfacing a clean error.
 *
 * The transport seam is deliberately minimal; `to`/attachments/`from`-override
 * can be added non-breakingly when richer email (agendas) lands.
 */
export async function sendEmail({
	to,
	subject,
	html,
	text,
}: SendEmailParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM || DEFAULT_FROM;

	// Dev fallback: no provider configured. Log the email — the text body carries
	// the magic-link URL, so local sign-in still works by copy-paste. This is the
	// ONLY path that logs the link; when a provider is configured the URL (a
	// bearer token) is never logged.
	if (!apiKey) {
		console.log(`\n[email:dev] to=${to} subject=${subject}\n${text}\n`);
		return;
	}

	let res: Response;
	try {
		res = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ from, to, subject, html, text }),
		});
	} catch (cause) {
		console.error(`[email] network error sending to ${to}:`, cause);
		throw new Error("Failed to send email.");
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		console.error(
			`[email] Resend error sending to ${to}: ${res.status} ${detail}`,
		);
		throw new Error("Failed to send email.");
	}
}
