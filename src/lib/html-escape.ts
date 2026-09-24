// Text-safety helpers for outgoing email. Client-safe, no dependencies.

/**
 * Escape a value for an HTML text node or a quoted attribute: `&`, `<`, `>`,
 * `"` and `'`.
 *
 * `notifications-logic.ts` keeps its own copy on purpose: it escapes no `'`,
 * so switching it here would change the bytes of every role reminder it sends.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** C0 and C1 controls, DEL, and the two Unicode line/paragraph separators. */
function isControl(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029
	);
}

/**
 * Make a value safe to interpolate into an email SUBJECT (#866): every control
 * character — CR and LF above all — becomes a space, runs of whitespace
 * collapse, and the result is trimmed.
 *
 * Resend builds the header itself, so this is not the only line of defence
 * against header injection; it is the one this app owns. A subject that
 * carries a newline from an anonymous form is at best a mangled inbox line.
 */
export function toSubjectText(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		out += isControl(code) ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim();
}
