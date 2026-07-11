/**
 * Normalize a raw presentation-link input to a clean http(s) URL, or null.
 *
 * - Empty / blank / nullish → null.
 * - A bare host ("docs.google.com/d/abc") is coerced to `https://`.
 * - Anything that isn't a valid http/https URL with a dotted host → null
 *   (rejects non-http schemes and accidental words like "tbd" / "n/a").
 *
 * Pure + client-safe: used server-side (persisted value is always clean) and
 * can back client-side form validation.
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
	return url.toString();
}
