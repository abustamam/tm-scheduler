/**
 * Stable heading anchors for the markdown articles under `content/resources/`
 * (#941).
 *
 * A heading may pin its own id with a trailing `{#id}`:
 *
 *     ## Setting up Base Camp {#base-camp}
 *
 * The marker is stripped from the rendered text and becomes the heading's
 * `id`, so a link to `/resources/what-is-pathways#base-camp` survives the
 * heading being reworded. A heading without one gets an id slugged from its
 * text, which is convenient but moves when the text does — pin an id on any
 * heading something else links to.
 */

const EXPLICIT_ID = /\s*\{#([A-Za-z0-9][A-Za-z0-9_-]*)\}\s*$/;

export function splitHeadingId(text: string): {
	text: string;
	id: string | null;
} {
	const match = EXPLICIT_ID.exec(text);
	if (!match) return { text, id: null };
	return { text: text.slice(0, match.index), id: match[1] };
}

export function slugifyHeading(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
