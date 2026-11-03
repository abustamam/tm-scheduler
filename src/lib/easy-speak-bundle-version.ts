// The Easy-Speak bundle's format version (#1497). Client-safe: its only import
// is `./import-bundle-limit`, itself import-free, so the panel, the server and
// the zod schema module all read it.

import { bundleTooBigMessage } from "./import-bundle-limit";

export const BUNDLE_FORMAT = "gavelup.easy-speak-bundle";
export const ARCHIVE_FORMAT = "gavelup.easy-speak-pages";

/** The one version an upload may carry. Bump it with every change to the bundle's shape. */
export const CURRENT_BUNDLE_VERSION = 2;

/** The refusal for a pages archive uploaded where the bundle belongs. */
export const ARCHIVE_UPLOADED_MESSAGE =
	"That is the pages archive (the file ending in -pages.json). Upload the other file the export saved.";

/** The upload refusal for any bundle whose version is not current. */
export function wrongVersionMessage(version: number | null): string {
	if (version === null) {
		return "This file came from an older GavelUp extension. Install the latest and export again.";
	}
	if (version > CURRENT_BUNDLE_VERSION) {
		return `This file came from a newer GavelUp extension (format ${version}) than this site reads yet. Try again after the next GavelUp update.`;
	}
	return `This file came from an older GavelUp extension (format ${version}). Install the latest and export again.`;
}

export type SniffResult =
	| { kind: "stale"; version: number | null }
	| { kind: "newer"; version: number }
	| { kind: "archive" }
	| { kind: "current" }
	| { kind: "unknown" };

/** How many leading bytes of an over-limit file the panel reads to classify it. */
export const SNIFF_HEAD_BYTES = 64 * 1024;

/** Classify an over-limit file from its first bytes (the panel passes the first SNIFF_HEAD_BYTES as text). */
export function sniffBundleHead(head: string): SniffResult {
	if (/"format"\s*:\s*"gavelup\.easy-speak-pages"/.test(head)) {
		return { kind: "archive" };
	}
	if (!/"format"\s*:\s*"gavelup\.easy-speak-bundle"/.test(head)) {
		return { kind: "unknown" };
	}
	const match = /"version"\s*:\s*(-?\d+)(?![\d.eE])/.exec(head);
	if (!match) return { kind: "stale", version: null };
	const version = Number(match[1]);
	if (version < CURRENT_BUNDLE_VERSION) return { kind: "stale", version };
	if (version > CURRENT_BUNDLE_VERSION) return { kind: "newer", version };
	// Current version, still over the limit: no current extension writes `raw`
	// inline, so a head that shows it came from a reordered older file.
	if (/"raw"\s*:\s*\[\s*\{\s*"url"/.test(head)) {
		return { kind: "stale", version: null };
	}
	return { kind: "current" };
}

/** The panel's sentence for an over-limit file. */
export function oversizeMessage(bytes: number, head: string): string {
	const size = bundleTooBigMessage(bytes);
	const sniffed = sniffBundleHead(head);
	switch (sniffed.kind) {
		case "stale":
		case "newer":
			return `${size} ${wrongVersionMessage(sniffed.version)}`;
		case "archive":
			return `${size} ${ARCHIVE_UPLOADED_MESSAGE}`;
		case "current":
		case "unknown":
			return size;
	}
}
