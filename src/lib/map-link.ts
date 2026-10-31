// The "open in maps" link for a meeting's address (#1444). Pure.
//
// A meeting's `location` is free text: a street address, a room name, or (for an
// online club) a URL someone pasted. Only the first two have a place to show on a
// map, so a URL, or nothing, gets no link.

const URL_LIKE = /^(https?:\/\/|www\.)/i;

/** The Google Maps search link for `location`, or null when there is nothing to
 *  look up: blank, or a URL. */
export function mapLink(location: string | null | undefined): string | null {
	const text = location?.trim();
	if (!text) return null;
	if (URL_LIKE.test(text)) return null;
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
}
