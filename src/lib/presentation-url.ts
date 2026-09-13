/**
 * Normalize a raw presentation-link input to a clean http(s) URL, or null.
 *
 * - Empty / blank / nullish → null.
 * - A bare host ("docs.google.com/d/abc") is coerced to `https://`.
 * - Anything that isn't a valid http/https URL with a dotted host → null
 *   (rejects non-http schemes and accidental words like "tbd" / "n/a").
 * - A URL carrying USERINFO → null. See below.
 *
 * Pure + client-safe: used server-side (persisted value is always clean) and
 * can back client-side form validation.
 *
 * ## Why userinfo is refused (#731)
 *
 * `https://zoom.us@evil.example.com/j/123` is a valid URL whose hostname is
 * `evil.example.com`; `zoom.us` is the username. The WHATWG parser preserves it,
 * so before this arm the function returned that string unchanged and every
 * caller stored it. Rendered as a link whose text is its own href — which is how
 * the #731 reminder email draws it — it reads as a Zoom link to the recipient
 * and lands them somewhere else. A bare host is not safe either: `new URL()`
 * parses `zoom.us@evil.example.com/j/123` the same way once `https://` is
 * prepended.
 *
 * Hardened HERE rather than at the `joinUrl` boundary, deliberately, and the
 * reasoning is in the PR for #731. Both callers are "paste the link" fields and
 * neither has a legitimate use for credentials in a URL: `speeches.presentation_url`
 * renders as a clickable anchor on the agenda too, reached through a LOWER-privilege
 * write (a speaker editing their own speech), so gating only the new field would
 * leave the same deceptive link reachable through the older one. This function
 * already refuses non-http schemes and undotted hosts for precisely the "that is
 * not a real link" reason; userinfo belongs on that list.
 *
 * Blast radius is new writes only. The non-test callers are write paths
 * (`slots-logic.ts`, and #731's `applyCreateMeeting` / `applyMeetingUpdate`);
 * nothing re-validates a stored column, so no existing row changes meaning —
 * except on the #731 meeting page, which re-runs this at render and will now
 * draw nothing for such a row. That is the intended direction.
 */
export function normalizePresentationUrl(raw?: string | null): string | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	// Require a dotted host so accidental words ("tbd", "n/a") don't become links.
	if (!url.hostname.includes(".")) return null;
	// Refuse credentials-in-URL: the part before `@` is userinfo, not the host,
	// so `https://zoom.us@evil.example.com/` points at evil.example.com while
	// reading as Zoom. See the header.
	if (url.username !== "" || url.password !== "") return null;
	return url.toString();
}
