const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "GavelUp <noreply@gavelup.app>";

export interface SendEmailParams {
	/** A single recipient or a list (Resend accepts either). */
	to: string | string[];
	subject: string;
	html: string;
	text: string;
	/** Optional Reply-To address (sent as Resend's `reply_to`). Omit for none. */
	replyTo?: string;
	/**
	 * Optional Resend `Idempotency-Key`. A retry of a send that actually went
	 * through (the send succeeded, the caller's bookkeeping did not) is then
	 * de-duplicated by Resend rather than delivered twice. Opt-in: omitted, the
	 * request carries no such header, exactly as before.
	 */
	idempotencyKey?: string;
}

/**
 * Domains RFC 2606 / 6761 reserve for documentation and tests: nothing there is
 * ever deliverable, and the fixture club's people (#1198) live on them. The demo
 * club (#1199) is made of such addresses, so the transport drops them rather
 * than send a real provider a message for an address that cannot exist.
 */
const RESERVED_SECOND_LEVEL = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"];

/**
 * True when `address` is on a reserved domain: `example.com`, `.net` or `.org`
 * and any subdomain of them, or any name ending `.example`, `.test`,
 * `.invalid` or `.localhost` (or equal to one). Case-insensitive; an address
 * with no `@` is not reserved.
 */
export function isReservedRecipient(address: string): boolean {
	const at = address.lastIndexOf("@");
	if (at < 0) return false;
	// "Name <a@b.example>" keeps its closing bracket after the domain.
	const domain = address
		.slice(at + 1)
		.replace(/[>\s]+$/u, "")
		.toLowerCase();
	if (!domain) return false;
	for (const d of RESERVED_SECOND_LEVEL) {
		if (domain === d || domain.endsWith(`.${d}`)) return true;
	}
	for (const tld of RESERVED_TLDS) {
		if (domain === tld || domain.endsWith(`.${tld}`)) return true;
	}
	return false;
}

/**
 * Provider-agnostic email transport. Sends via Resend when RESEND_API_KEY is
 * set; otherwise logs to the console (dev). Throws on send failure — callers
 * (e.g. Better-Auth's sendMagicLink) rely on the throw surfacing a clean error.
 *
 * The transport seam is deliberately minimal; `from`-override can be added
 * non-breakingly when richer email lands. There is no attachment support: its
 * only caller was the app-sent minutes email, which #903 removed (every message
 * to a person is now sent by a human).
 */
export async function sendEmail({
	to,
	subject,
	html,
	text,
	replyTo,
	idempotencyKey,
}: SendEmailParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM || DEFAULT_FROM;
	const toLabel = Array.isArray(to) ? to.join(", ") : to;

	// Dev fallback: no provider configured. Log the email — the text body carries
	// the magic-link URL, so local sign-in still works by copy-paste. This is the
	// ONLY path that logs the link; when a provider is configured the URL (a
	// bearer token) is never logged.
	if (!apiKey) {
		const replyToNote = replyTo ? ` reply_to=${replyTo}` : "";
		console.log(
			`\n[email:dev] to=${toLabel} subject=${subject}${replyToNote}\n${text}\n`,
		);
		return;
	}

	// A reserved address (the demo club's people) is never sent to. Dropped
	// per recipient, so a mixed list still reaches the real addresses.
	const recipients = Array.isArray(to) ? to : [to];
	const deliverable = recipients.filter((a) => !isReservedRecipient(a));
	if (deliverable.length === 0) {
		console.log("[email] dropped: reserved recipient domain");
		return;
	}
	const sendTo = Array.isArray(to) ? deliverable : to;

	// Only include `reply_to` in the body when present, so a send without one
	// produces a byte-identical request to before the field existed.
	const body: Record<string, unknown> = {
		from,
		to: sendTo,
		subject,
		html,
		text,
	};
	if (replyTo) {
		body.reply_to = replyTo;
	}

	let res: Response;
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		};
		if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
		res = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers,
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
