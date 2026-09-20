/**
 * `/api/pathways/ingest`'s body ceiling, asserted as a BOUND ON MEMORY (#800).
 *
 * This endpoint reads a request body before it has validated anything, and it
 * takes no session — the `gup_` token is checked inside `ingestForToken`, which
 * runs after the body is already parsed. So every assertion here is made with
 * NO `Authorization` header or a junk one: whatever the cap does, it has to do
 * without a credential, because that is how it is reachable.
 *
 * The status code is not the claim. `await request.text()` followed by a length
 * check answers the same 413 having buffered the whole body, which was the bug
 * (#800, and #776 item 7 before it on `/api/mcp`). The assertions that matter
 * count how many bytes the reader actually pulled off the wire.
 *
 * `#/server/pathways-ingest-logic` is mocked wholesale so this runs without a
 * database: the sync pipeline behind it has its own integration suite, and what
 * is under test here is everything that happens BEFORE it — including, for an
 * oversized body, that it is never reached at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	brokenStreamRequest,
	streamingRequest as makeStreamingRequest,
} from "#/test/streaming-request";

class FakeIngestError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "IngestError";
	}
}

const ingestForToken = vi.fn();

vi.mock("#/server/pathways-ingest-logic", () => ({
	IngestError: FakeIngestError,
	ingestForToken: (...args: unknown[]) => ingestForToken(...args),
	parseBearerToken: (header: string | null) => {
		if (!header) return null;
		const m = /^Bearer\s+(.+)$/i.exec(header.trim());
		return m ? m[1] : null;
	},
}));

const { handlePathwaysIngestRequest, handlePathwaysIngestPreflight } =
	await import("#/server/pathways-ingest-request");
const { MAX_INGEST_BODY_BYTES } = await import("#/lib/pathways-ingest-limits");

/** A POST with a buffered body, and whatever headers the caller wants on it. */
function bufferedRequest(
	body: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(INGEST_URL, {
		method: "POST",
		headers,
		body,
	});
}

const INGEST_URL = "https://club.test/api/pathways/ingest";

/** The shared harness (`#/test/streaming-request`), bound to this endpoint's URL. */
function streamingRequest(
	chunk: Uint8Array,
	chunks: number,
	headers: Record<string, string> = {},
) {
	return makeStreamingRequest(INGEST_URL, chunk, chunks, headers);
}

const SYNC_RESULT = { membersMatched: 3, rowsWritten: 7 };

beforeEach(() => {
	ingestForToken.mockReset();
	ingestForToken.mockResolvedValue(SYNC_RESULT);
});

describe("the ingest ceiling itself", () => {
	it("is an absolute number, not one stated against itself", () => {
		// Stated absolutely on purpose. A bound written as
		// `expect(body.length).toBeLessThanOrEqual(MAX_INGEST_BODY_BYTES)` holds
		// for every value the constant could have, including one that puts the
		// bug back — see CODING_STANDARDS.md, "Test coverage".
		expect(MAX_INGEST_BODY_BYTES).toBe(5_000_000);
		expect(Number.isSafeInteger(MAX_INGEST_BODY_BYTES)).toBe(true);
	});

	it("is not the MCP endpoint's cap — the two are different numbers", async () => {
		const { MAX_MCP_BODY_BYTES } = await import("#/lib/mcp-limits");
		expect(MAX_INGEST_BODY_BYTES).not.toBe(MAX_MCP_BODY_BYTES);
	});
});

describe("the CORS preflight", () => {
	// It moved out of the route file with the POST handler, so it is reachable
	// now and gets asserted rather than assumed.
	it("answers 204 with no body", () => {
		const res = handlePathwaysIngestPreflight();
		expect(res.status).toBe(204);
		expect(res.body).toBeNull();
	});

	it("grants the extension's origin, method and headers", () => {
		const res = handlePathwaysIngestPreflight();
		expect(Object.fromEntries(res.headers)).toMatchObject({
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "POST, OPTIONS",
			"access-control-allow-headers": "authorization, content-type",
			"access-control-max-age": "86400",
		});
	});

	it("answers every POST with the same headers it promises at preflight", async () => {
		// A preflight that grants what the response does not carry is a CORS
		// failure the extension reads as a network error, with no status to log.
		const preflight = Object.fromEntries(
			handlePathwaysIngestPreflight().headers,
		);
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request } = streamingRequest(chunk, 200);
		for (const res of [
			await handlePathwaysIngestRequest(request),
			await handlePathwaysIngestRequest(bufferedRequest("{not json")),
			await handlePathwaysIngestRequest(
				bufferedRequest(JSON.stringify({ pages: [] })),
			),
		]) {
			for (const [k, v] of Object.entries(preflight)) {
				if (k.startsWith("access-control-allow-origin")) {
					expect(res.headers.get(k)).toBe(v);
				}
			}
			expect(res.headers.get("access-control-allow-methods")).toBe(
				preflight["access-control-allow-methods"],
			);
			expect(res.headers.get("access-control-allow-headers")).toBe(
				preflight["access-control-allow-headers"],
			);
		}
	});
});

describe("an oversized body is refused without being read (#800)", () => {
	it("STOPS READING a chunked body — the 413 is not the claim", async () => {
		// 1000 chunks of 64 KB is a ~64 MB body against a 5 MB cap, declaring no
		// content-length at all. The old handler answered 413 holding every byte.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request, pulled } = streamingRequest(chunk, 1000);

		const res = await handlePathwaysIngestRequest(request);

		expect(res.status).toBe(413);
		// MEASURED: 77 chunks / 5,046,272 bytes — the cap plus the one chunk that
		// crossed it. The control is the other number: without the cap this is
		// 1000 chunks and 65,536,000 bytes, which is what the old handler read.
		// Absolute ceilings, so shrinking the cap cannot loosen them.
		expect(pulled.chunks).toBeLessThan(100);
		expect(pulled.bytes).toBeLessThan(7_000_000);
		expect(pulled.cancelled).toBe(true);
		// Nothing downstream ran: no token lookup, no database round trip.
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("refuses an oversized body whose content-length is absent, WITHOUT reading it", async () => {
		// The status alone does not discriminate: 13 MB of ASCII trips the old
		// `text.length` check too, and answers the same 413 holding all of it.
		// The byte count is the assertion that can tell the two apart.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request, pulled } = streamingRequest(chunk, 200);
		expect(request.headers.get("content-length")).toBeNull();

		const res = await handlePathwaysIngestRequest(request);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Body too large." });
		expect(pulled.bytes).toBeLessThan(7_000_000);
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("refuses a content-length that is not a byte count, without consuming the body", async () => {
		// `Number("abc")` is NaN, and NaN is false against `>`, so writing
		// nonsense in the header was the cheapest way past the old check.
		//
		// 400 rather than the 413 #800's acceptance criteria name, matching
		// `/api/mcp`: a header that is not a byte count is a malformed request
		// whatever the body turns out to weigh, and nothing has weighed it yet.
		// The substance the criterion is about — refused, unbuffered, with no
		// credential — is what the rest of this asserts.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request, pulled } = streamingRequest(chunk, 200, {
			"content-length": "abc",
		});

		const res = await handlePathwaysIngestRequest(request);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Malformed content-length header.",
		});
		// One chunk, not zero: a `ReadableStream` calls its source's `pull` once
		// at construction to fill its own queue, so the counter below measures
		// what the SOURCE produced, not what the handler consumed. The handler
		// consumed nothing — it answered before taking a reader at all.
		expect(pulled.bytes).toBeLessThanOrEqual(chunk.byteLength);
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("refuses an HONESTLY declared oversized body without consuming it", async () => {
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request, pulled } = streamingRequest(chunk, 200, {
			"content-length": String(200 * 64 * 1024),
		});

		const res = await handlePathwaysIngestRequest(request);

		expect(res.status).toBe(413);
		// The stream's own one-chunk prefill; see the note above.
		expect(pulled.bytes).toBeLessThanOrEqual(chunk.byteLength);
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("answers 400 when the connection drops mid-body", async () => {
		const res = await handlePathwaysIngestRequest(
			brokenStreamRequest(INGEST_URL),
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Could not read request body.",
		});
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("counts BYTES, not UTF-16 code units", async () => {
		// "🎤" is 2 code units and 4 bytes, so a body of them is ~2x its
		// `text.length` on the wire. 1.5M of them is 6 MB over a 5 MB cap while
		// `text.length` reads 3,000,000 — under it, and waved straight through.
		const text = "🎤".repeat(1_500_000);
		expect(text.length).toBeLessThan(MAX_INGEST_BODY_BYTES);
		expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(
			MAX_INGEST_BODY_BYTES,
		);

		const res = await handlePathwaysIngestRequest(bufferedRequest(text));

		expect(res.status).toBe(413);
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("rejects regardless of the token — absent, junk, or well-formed", async () => {
		// Every shape the cap can be reached by, against every shape of
		// credential. The endpoint reads the body before anything authenticates,
		// so "it needs no token" is the claim, not a detail.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const matrix: Record<string, string>[] = [
			{},
			{ authorization: "Bearer gup_not-a-real-token" },
			{ authorization: "Basic hunter2" },
		];
		const multiByte = "🎤".repeat(1_500_000);
		for (const headers of matrix) {
			const label = JSON.stringify(headers);

			// Chunked, no declared length.
			const streamed = streamingRequest(chunk, 200, headers);
			const chunkedRes = await handlePathwaysIngestRequest(streamed.request);
			expect(chunkedRes.status, `chunked ${label}`).toBe(413);
			expect(streamed.pulled.bytes, `chunked ${label}`).toBeLessThan(7_000_000);

			// Buffered, over the cap in BYTES while under it in code units.
			const byteRes = await handlePathwaysIngestRequest(
				bufferedRequest(multiByte, headers),
			);
			expect(byteRes.status, `multi-byte ${label}`).toBe(413);

			// A content-length that is not a byte count.
			const malformed = streamingRequest(chunk, 200, {
				...headers,
				"content-length": "abc",
			});
			const malformedRes = await handlePathwaysIngestRequest(malformed.request);
			expect(malformedRes.status, `malformed ${label}`).toBe(400);
		}
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("answers 413 with the CORS headers the extension needs to read it", async () => {
		// A 413 the browser drops as a CORS failure tells the extension nothing.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request } = streamingRequest(chunk, 200);

		const res = await handlePathwaysIngestRequest(request);

		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("a body within the ceiling is unaffected", () => {
	it("passes a normal sync through and returns its result as 200", async () => {
		const body = {
			basecampClubGuid: "guid-1",
			pages: [{ p: 1 }],
			details: [{ d: 1 }],
		};
		const res = await handlePathwaysIngestRequest(
			bufferedRequest(JSON.stringify(body), {
				"content-type": "application/json",
				authorization: "Bearer gup_token",
			}),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(SYNC_RESULT);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(ingestForToken).toHaveBeenCalledWith("gup_token", body);
	});

	it("still answers 400, not 413, for malformed JSON under the ceiling", async () => {
		const res = await handlePathwaysIngestRequest(
			bufferedRequest("{not json", { "content-type": "application/json" }),
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Body must be JSON." });
		expect(ingestForToken).not.toHaveBeenCalled();
	});

	it("maps an IngestError to its own status, unchanged", async () => {
		ingestForToken.mockRejectedValue(new FakeIngestError(401, "Bad token."));

		const res = await handlePathwaysIngestRequest(
			bufferedRequest(JSON.stringify({ pages: [] })),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Bad token." });
	});

	it("hides an unexpected failure behind a 500", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		ingestForToken.mockRejectedValue(new Error("column does not exist"));

		const res = await handlePathwaysIngestRequest(
			bufferedRequest(JSON.stringify({ pages: [] })),
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Sync failed." });
		spy.mockRestore();
	});
});
