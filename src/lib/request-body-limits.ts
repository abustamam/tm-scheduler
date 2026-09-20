/**
 * Reading a request body under a ceiling, without trusting the caller's
 * account of how big it is.
 *
 * Both helpers were written for `/api/mcp` (#776 item 7) and lived in
 * `mcp-limits.ts` beside that endpoint's numbers. Neither is MCP-specific:
 * `/api/pathways/ingest` had a verbatim copy of the same defeated check and
 * now calls these instead (#800), so they moved to a module named for what
 * they do. The CEILINGS stay with their endpoints — `MAX_MCP_BODY_BYTES` in
 * `mcp-limits.ts`, `MAX_INGEST_BODY_BYTES` in `pathways-ingest-limits.ts` —
 * because they are different numbers and unifying them would make every
 * future tuning of one a change to the other.
 *
 * Nothing here imports `#/db`, `pg`, or any server module, so
 * `request-body-limits.test.ts` can drive a real `ReadableStream` through it
 * and COUNT what came off the wire. That is the point: a 413 is reachable
 * while still buffering everything, so a status code proves nothing about
 * memory.
 */

/**
 * What a request's `content-length` header says, as three distinct answers.
 *
 * Three, not a number, because the header is CALLER-CONTROLLED and the two
 * non-numeric cases mean opposite things. `Number(header ?? "0")` collapsed
 * both into a value that passes every comparison: an absent header became `0`
 * ("a body of nothing", when it actually means "length unknown, probably
 * chunked"), and `abc` became `NaN`, which is false against `>` — so the
 * cheapest way past a size check was to write nonsense in the header.
 */
export type DeclaredLength =
	/** No header. Legitimate for a chunked body; says nothing about its size. */
	| { kind: "absent" }
	/** Present and not a plain byte count. A client that means it sends digits. */
	| { kind: "malformed"; raw: string }
	/** A byte count the caller CLAIMS. Still only a claim — see `readBodyWithinCap`. */
	| { kind: "length"; bytes: number };

/**
 * Read `content-length` without coercing.
 *
 * Deliberately strict: RFC 9110 allows a repeated header to arrive as
 * `"10, 10"`, and a signed, spaced, hex or float value is not a byte count from
 * anything that meant it. All of those are `malformed` rather than guessed at,
 * because guessing is how the check got skipped in the first place.
 */
export function parseDeclaredContentLength(
	raw: string | null | undefined,
): DeclaredLength {
	if (raw === null || raw === undefined || raw.trim() === "") {
		return { kind: "absent" };
	}
	const value = raw.trim();
	if (!/^\d+$/.test(value)) return { kind: "malformed", raw: value };
	const bytes = Number(value);
	if (!Number.isSafeInteger(bytes)) return { kind: "malformed", raw: value };
	return { kind: "length", bytes };
}

/** What `readBodyWithinCap` found. */
export type CappedBody =
	/** The whole body, decoded. `bytes` is its true size on the wire. */
	| { kind: "body"; text: string; bytes: number }
	/** The cap was crossed. The stream was cancelled at that point. */
	| { kind: "too-large" }
	/** The stream errored mid-read — a dropped connection, usually. */
	| { kind: "unreadable" };

/**
 * Read a request body, stopping the moment it crosses `maxBytes`.
 *
 * The handlers used to call `await request.text()` and check the length
 * afterwards. That check is honest about what arrived and useless as a ceiling:
 * by the time it runs, the whole body is already a string in this process. The
 * declared-length check that ran before it could not close the gap either,
 * because a chunked request declares no length at all and the header is the
 * caller's to write.
 *
 * So the ceiling is enforced HERE, against bytes actually received. Crossing it
 * cancels the stream, which is what makes a byte count a bound on memory
 * instead of a label on a 413.
 *
 * Bytes, not `text.length`: the old checks counted UTF-16 code units, so a body
 * of multi-byte characters could be ~3x the cap on the wire and pass.
 *
 * `maxBytes` is REQUIRED rather than defaulted. It defaulted to
 * `MAX_MCP_BODY_BYTES` while this lived in `mcp-limits.ts`, which was a
 * reasonable default for one caller and a trap for the second: an ingest
 * handler that forgot the argument would have silently enforced the MCP
 * endpoint's 1 MB, five times tighter than its own ceiling, and every test
 * below that number would still pass.
 *
 * `request.body` is null for a body-less request (and on any runtime that does
 * not expose the stream), which falls back to `text()` — a body that does not
 * stream cannot be aborted part-way, but it is also not the shape this cap
 * exists for.
 */
export async function readBodyWithinCap(
	request: Request,
	maxBytes: number,
): Promise<CappedBody> {
	const stream = request.body;
	if (!stream) {
		try {
			const text = await request.text();
			const bytes = new TextEncoder().encode(text).byteLength;
			return bytes > maxBytes
				? { kind: "too-large" }
				: { kind: "body", text, bytes };
		} catch {
			return { kind: "unreadable" };
		}
	}

	const reader = stream.getReader();
	// `stream: true` so a multi-byte character split across two chunks decodes as
	// one character rather than two replacement glyphs.
	const decoder = new TextDecoder("utf-8");
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				// Stop pulling. Everything after this point is never read, which is
				// the entire difference between this and checking afterwards.
				await reader.cancel().catch(() => {});
				return { kind: "too-large" };
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} catch {
		await reader.cancel().catch(() => {});
		return { kind: "unreadable" };
	}
	return { kind: "body", text, bytes };
}
