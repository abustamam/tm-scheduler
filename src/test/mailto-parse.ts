/**
 * Split a `mailto:` URL the way a mail client reads it: the address part before
 * the first literal `?`, then `name=value` header pairs split on literal `&`,
 * values left RAW (still percent-encoded).
 *
 * Deliberately not `URLSearchParams`: that decodes `+` as a space and would hide
 * an injected header behind its own normalisation. Shared by the minutes draft's
 * unit and component tests (#903) so both read a draft identically.
 */
export function parseMailto(href: string): {
	to: string;
	headers: [string, string][];
} {
	if (!href.startsWith("mailto:")) {
		throw new Error(`not a mailto: URL: ${href.slice(0, 40)}`);
	}
	const rest = href.slice("mailto:".length);
	const q = rest.indexOf("?");
	const to = q === -1 ? rest : rest.slice(0, q);
	const query = q === -1 ? "" : rest.slice(q + 1);
	const headers = query
		.split("&")
		.filter(Boolean)
		.map((pair): [string, string] => {
			const eq = pair.indexOf("=");
			return [pair.slice(0, eq), pair.slice(eq + 1)];
		});
	return { to, headers };
}
