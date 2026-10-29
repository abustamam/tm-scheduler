/**
 * Link-preview metadata for shared GavelUp URLs.
 *
 * `head` runs during SSR with no request origin, and scrapers (iMessage,
 * Slack, WhatsApp, Facebook) need ABSOLUTE `og:image` / `og:url`, so the
 * production origin is pinned here.
 *
 * PRIVACY: a caller passes only public strings (club name, meeting date,
 * theme). The meeting page is public but its roll is members-only, so never
 * pass a member name, assignee, attendance or count into `shareMeta`.
 */
export const SITE_ORIGIN = "https://gavelup.app";
export const SITE_NAME = "GavelUp";
export const DEFAULT_SHARE_IMAGE = "/landing/hero.png";

export type MetaTag = Record<string, string>;

export function absoluteUrl(path: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface ShareMetaInput {
	title: string;
	description: string;
	/** Path (or absolute URL) of the page; omitted => no `og:url`. */
	path?: string;
	/** Path (or absolute URL) of the preview image. */
	image?: string;
	/** Extra tags appended after the share tags, e.g. robots. */
	extra?: MetaTag[];
}

export function shareMeta({
	title,
	description,
	path,
	image = DEFAULT_SHARE_IMAGE,
	extra = [],
}: ShareMetaInput): MetaTag[] {
	return [
		{ title },
		{ name: "description", content: description },
		{ property: "og:title", content: title },
		{ property: "og:description", content: description },
		{ property: "og:type", content: "website" },
		{ property: "og:site_name", content: SITE_NAME },
		{ property: "og:image", content: absoluteUrl(image) },
		...(path ? [{ property: "og:url", content: absoluteUrl(path) }] : []),
		{ name: "twitter:card", content: "summary_large_image" },
		...extra,
	];
}

export const NOINDEX: MetaTag = {
	name: "robots",
	content: "noindex, nofollow",
};
