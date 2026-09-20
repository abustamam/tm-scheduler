/**
 * The body reader asserted as a BOUND ON MEMORY rather than a status code
 * (#776 item 7; moved here from `mcp-limits.test.ts` with the helpers when
 * `/api/pathways/ingest` became the second caller, #800).
 *
 * It measures what the old check could not: how much of an oversized body is
 * read before the reader gives up. A 413 says nothing about that — `await
 * request.text()` followed by a length check returns the same 413 having
 * buffered the whole thing.
 *
 * Each endpoint's own ceiling is asserted beside that endpoint
 * (`mcp-limits.test.ts`, `pathways-ingest-request.test.ts`); the caps used here
 * are small literals, because what is under test is the READER, not a number.
 */
import { describe, expect, it } from "vitest";
import {
	brokenStreamRequest,
	streamingRequest,
} from "#/test/streaming-request";
import {
	parseDeclaredContentLength,
	readBodyWithinCap,
} from "./request-body-limits";

const ONE_MB = 1_000_000;

describe("parseDeclaredContentLength (#776 item 7)", () => {
	it("reads a plain byte count", () => {
		expect(parseDeclaredContentLength("0")).toEqual({
			kind: "length",
			bytes: 0,
		});
		expect(parseDeclaredContentLength("2000000")).toEqual({
			kind: "length",
			bytes: 2_000_000,
		});
		// Header values arrive with incidental whitespace often enough to trim.
		expect(parseDeclaredContentLength(" 42 ")).toEqual({
			kind: "length",
			bytes: 42,
		});
	});

	it("says ABSENT rather than zero when there is no header", () => {
		// The old code read this as `Number("0")`, i.e. "a body of nothing", and
		// waved a chunked request of any size straight through.
		expect(parseDeclaredContentLength(null)).toEqual({ kind: "absent" });
		expect(parseDeclaredContentLength(undefined)).toEqual({ kind: "absent" });
		expect(parseDeclaredContentLength("   ")).toEqual({ kind: "absent" });
	});

	it("says MALFORMED rather than NaN for anything that is not digits", () => {
		// `Number("abc")` is NaN, and NaN is false against every comparison — so
		// the cheapest way past a `declared > MAX` check was to write nonsense.
		for (const raw of [
			"abc",
			"-1",
			"1.5",
			"1e6",
			"0x10",
			"10, 10",
			"1_000",
			// Beyond 2^53: a number this large cannot be compared exactly.
			"9007199254740993",
		]) {
			expect(parseDeclaredContentLength(raw), raw).toMatchObject({
				kind: "malformed",
			});
		}
	});
});

describe("readBodyWithinCap (#776 item 7)", () => {
	it("returns a body under the cap unchanged, with its true byte size", async () => {
		const text = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "whoami" });
		const res = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", { method: "POST", body: text }),
			ONE_MB,
		);
		expect(res).toEqual({
			kind: "body",
			text,
			bytes: new TextEncoder().encode(text).byteLength,
		});
	});

	it("counts BYTES, not UTF-16 code units", async () => {
		// "🎤" is 2 code units and 4 bytes. A cap read off `text.length` lets a
		// body ~3x the ceiling through; this one does not.
		const text = "🎤".repeat(10); // 20 code units, 40 bytes
		const under = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", { method: "POST", body: text }),
			40,
		);
		expect(under).toMatchObject({ kind: "body", bytes: 40 });

		const over = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", { method: "POST", body: text }),
			39,
		);
		expect(over).toEqual({ kind: "too-large" });
	});

	it("decodes a multi-byte character split across two chunks", async () => {
		// The streaming decoder is what keeps a chunk boundary inside a UTF-8
		// sequence from becoming two replacement glyphs in the parsed JSON.
		const bytes = new TextEncoder().encode('{"t":"🎤"}');
		const cut = 7; // lands inside the 4-byte sequence
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, cut));
				controller.enqueue(bytes.slice(cut));
				controller.close();
			},
		});
		const res = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
			ONE_MB,
		);
		expect(res).toMatchObject({ kind: "body", text: '{"t":"🎤"}' });
	});

	it("STOPS READING once the cap is crossed — the 413 is not the claim", async () => {
		// 1000 chunks of 64 KB is a ~64 MB body against a 1 MB cap. The old
		// handler answered 413 having held every byte of it; this one reads ~17
		// chunks and cancels the stream.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request, pulled } = streamingRequest(
			"https://club.test/api/mcp",
			chunk,
			1000,
		);

		const res = await readBodyWithinCap(request, ONE_MB);

		expect(res).toEqual({ kind: "too-large" });
		// The ceiling plus at most a chunk in flight and one queued ahead.
		expect(pulled.bytes).toBeLessThanOrEqual(ONE_MB + 2 * chunk.byteLength);
		// The measured control: without the cap this would be 1000.
		expect(pulled.chunks).toBeLessThan(20);
		expect(pulled.cancelled).toBe(true);
	});

	it("reports an unreadable body rather than throwing", async () => {
		const res = await readBodyWithinCap(
			brokenStreamRequest("https://club.test/api/mcp"),
			ONE_MB,
		);
		expect(res).toEqual({ kind: "unreadable" });
	});
});
