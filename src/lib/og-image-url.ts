import type { MetaTag } from "./share-meta";

/** The generated card's size, for `og:image:width` / `og:image:height` (#1411). */
export const OG_IMAGE_SIZE_META: MetaTag[] = [
	{ property: "og:image:width", content: "1200" },
	{ property: "og:image:height", content: "630" },
];

/** `path` with the card's version as `?v=`; no version, no query. */
export function ogImagePath(
	path: string,
	version: string | null | undefined,
): string {
	return version ? `${path}?v=${version}` : path;
}
