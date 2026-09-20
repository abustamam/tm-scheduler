/**
 * A POST whose body is a `ReadableStream`, plus a counter of what came off it.
 *
 * The counter is the whole point. A body cap that answers 413 having already
 * buffered everything and one that cancels the stream mid-read are
 * indistinguishable by status code — #776 item 7 and #800 were both exactly
 * that bug — so the assertion that can tell them apart has to count bytes.
 *
 * Shared by `request-body-limits.test.ts` (the reader) and
 * `pathways-ingest-request.test.ts` (the endpoint that calls it), which had a
 * copy each until a reviewer pointed out that `src/test/` is where this repo
 * puts a harness two suites need.
 */

/** What the stream's SOURCE produced. See `streamingRequest` on why that is not the same as what the handler consumed. */
export type PulledCounter = {
	chunks: number;
	bytes: number;
	cancelled: boolean;
};

/**
 * `chunks` repeats of `chunk`, offered to whoever reads the request.
 *
 * `pulled` counts what the SOURCE handed over, which is at least one chunk more
 * than the reader consumed: a `ReadableStream` calls its source's `pull` once at
 * construction to fill its own queue, so a handler that rejects before taking a
 * reader at all still sees a count of 1 rather than 0.
 */
export function streamingRequest(
	url: string,
	chunk: Uint8Array,
	chunks: number,
	headers: Record<string, string> = {},
): { request: Request; pulled: PulledCounter } {
	const pulled: PulledCounter = { chunks: 0, bytes: 0, cancelled: false };
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			sent += 1;
			pulled.chunks += 1;
			pulled.bytes += chunk.byteLength;
			controller.enqueue(chunk);
		},
		cancel() {
			pulled.cancelled = true;
		},
	});
	const request = new Request(url, {
		method: "POST",
		headers,
		body,
		// Required by undici for a streaming request body.
		duplex: "half",
	} as RequestInit & { duplex: "half" });
	return { request, pulled };
}

/** A request whose body errors mid-read — a dropped connection. */
export function brokenStreamRequest(url: string): Request {
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.error(new Error("connection reset"));
		},
	});
	return new Request(url, {
		method: "POST",
		body,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}
