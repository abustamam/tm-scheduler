// The Easy-Speak upload cap (#1051), in `src/lib` so the server (which refuses
// an oversize body) and the panel (which refuses before it reads the file into
// memory) share ONE number and ONE sentence. No `#/db` import: client-safe.

/** The upload cap: 50 MB of JSON text. */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The refusal sentence, naming the file's size and the limit. */
export function bundleTooBigMessage(bytes: number): string {
	return `That file is ${megabytes(bytes)}; the limit is ${megabytes(MAX_BUNDLE_BYTES)}.`;
}
