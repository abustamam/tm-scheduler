/**
 * Reads ONE JSX opening tag out of (comment-stripped) source, so a guard can
 * assert on that element's own `className` and not on whichever `className="…"`
 * happens to come next in the file. A bare element has no className, so a
 * "first className after the tag" read lands on the NEXT element and reports
 * its classes as the bare one's (#1596).
 */

/** The opening tag `<Name …>` of the one element called `name`. Fails when there
 *  is not exactly one, so a second bare `<Card>` elsewhere cannot stand in. */
export function openingTag(src: string, name: string): string {
	const re = new RegExp(`<${name}(?=[\\s>/])`, "g");
	const starts = [...src.matchAll(re)].map((m) => m.index ?? 0);
	if (starts.length !== 1) {
		throw new Error(
			`expected exactly one <${name}> opening tag, found ${starts.length}`,
		);
	}
	const from = starts[0];
	let depth = 0;
	let quote: string | null = null;
	for (let i = from; i < src.length; i++) {
		const ch = src[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{") depth++;
		else if (ch === "}") depth--;
		else if (ch === ">" && depth === 0 && src[i - 1] !== "=") {
			return src.slice(from, i + 1);
		}
	}
	throw new Error(`<${name}> opening tag is not closed`);
}

/** The tag's own literal `className="…"`, or null when it carries none. */
export function tagClassName(tag: string): string | null {
	return /\bclassName="([^"]*)"/.exec(tag)?.[1] ?? null;
}
