import type { MetaTag } from "#/lib/share-meta";

/** The generated card's size: the endpoint renders it, the head declares it (#1411). */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export const OG_IMAGE_SIZE_META: MetaTag[] = [
	{ property: "og:image:width", content: String(OG_IMAGE_WIDTH) },
	{ property: "og:image:height", content: String(OG_IMAGE_HEIGHT) },
];

/** `path` with the card's version as `?v=`; no version, no query. */
export function ogImagePath(
	path: string,
	version: string | null | undefined,
): string {
	return version ? `${path}?v=${version}` : path;
}

/**
 * The club card's image path, or undefined when the id is missing (the caller
 * then keeps the default share image: never `/api/og/club/undefined.png`).
 */
export function clubOgImage(
	clubUuid: string | null | undefined,
	version: string | null | undefined,
): string | undefined {
	return clubUuid
		? ogImagePath(`/api/og/club/${clubUuid}.png`, version)
		: undefined;
}

/** The meeting card's image path; undefined when an id is missing. */
export function meetingOgImage(
	clubUuid: string | null | undefined,
	meetingKey: string | null | undefined,
	version: string | null | undefined,
): string | undefined {
	return clubUuid && meetingKey
		? ogImagePath(
				`/api/og/meeting/${clubUuid}/${encodeURIComponent(meetingKey)}.png`,
				version,
			)
		: undefined;
}
