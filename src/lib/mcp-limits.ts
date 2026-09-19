/**
 * The MCP endpoint's numeric ceilings, and the reader that enforces the body one
 * (#773, #776 items 1 and 7).
 *
 * **Why they live here and not beside their callers.** Each of these three
 * numbers was first written in the module that reads it — `MAX_BODY_BYTES` in
 * `handle-request.ts`, `MAX_RESULTS` in `find-people.ts`,
 * `MAX_GUEST_BOOK_ENTRIES` in `record-guest-book.ts` — and every one of those
 * modules imports `#/db` at load. `CODING_STANDARDS.md` ("Test coverage") calls
 * that shape unassertable, and it is literal here: a vitest file cannot import
 * `record-guest-book.ts` without a database, so the entry cap could have been
 * raised to 5,000,000 with the whole suite green. The repo already keeps ten
 * `src/lib/*-limits.ts` modules for exactly this reason; this is the eleventh.
 *
 * Nothing here imports `#/db`, `pg`, or any server module, so
 * `mcp-limits.test.ts` asserts the values directly. That test is the point of
 * the move, not a bonus.
 */

/**
 * How many lines of the paper guest book one `record_guest_book` call may carry.
 *
 * The book is transcribed one page at a time and a page holds a dozen or so
 * names; 100 is far more than one page and still small enough that the plan,
 * the hash and the locked section stay cheap.
 */
export const MAX_GUEST_BOOK_ENTRIES = 100;

/**
 * How many people one `find_people` call returns.
 *
 * A club's roster plus its live prospect list. The tool reports `truncated`
 * rather than silently returning a prefix, because a caller that believes it
 * has everyone will conclude a name is absent.
 */
export const MAX_FIND_PEOPLE_RESULTS = 200;

/**
 * 1 MB — the largest request body `/api/mcp` will read, the same ceiling
 * `/api/pathways/ingest` uses. A 100-entry guest-book page is a few KB.
 *
 * Enforced by `readBodyWithinCap` WHILE the body streams in, not after, so the
 * ceiling bounds memory rather than merely reporting on it.
 */
export const MAX_MCP_BODY_BYTES = 1_000_000;

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
 * The handler used to call `await request.text()` and check the length
 * afterwards. That check is honest about what arrived and useless as a ceiling:
 * by the time it runs, the whole body is already a string in this process. The
 * declared-length check that ran before it could not close the gap either,
 * because a chunked request declares no length at all and the header is the
 * caller's to write.
 *
 * So the ceiling is enforced HERE, against bytes actually received. Crossing it
 * cancels the stream, which is what makes "1 MB" a bound on memory instead of a
 * label on a 413.
 *
 * Bytes, not `text.length`: the old check counted UTF-16 code units, so a body
 * of multi-byte characters could be ~3x the cap on the wire and pass.
 *
 * `request.body` is null for a body-less request (and on any runtime that does
 * not expose the stream), which falls back to `text()` — a body that does not
 * stream cannot be aborted part-way, but it is also not the shape this cap
 * exists for.
 */
export async function readBodyWithinCap(
	request: Request,
	maxBytes: number = MAX_MCP_BODY_BYTES,
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
